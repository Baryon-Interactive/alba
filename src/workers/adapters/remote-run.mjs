// Runs one order on another machine (a worker with `host:`). Started detached by alba in place of the worker program, so its pid,
// output and exit code stand for the remote worker's: stdout is the worker's stdout (the events stream), stderr goes to the log.
//
//   1. stage: the remote script, its spec, the overlay (alba's untracked files in the worktree: skills, design snapshot, inbox,
//      plus the order file and prompt under .alba/order/) -> one tar stream into <workspace>/runs/<id>/
//   2. prepare: the bare repository exists; push the local branch to refs/alba/incoming/<branch>; send the Git LFS objects of
//      the branch that the host's bare repository lacks (there is no LFS server on the host, so the push skips them)
//   3. run over SSH with a reverse tunnel (local port -> a free port on the host), trying the next port when it is taken
//   4. every few minutes, and at the end: fetch the branch back, bring the LFS objects its commits added from the host's bare
//      repository, and fast-forward the local worktree; send a changed inbox
//   5. at the end: copy back what the worker left uncommitted, deletions and the last-message file
import { spawn as nativeSpawn, spawnSync as nativeSpawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, lstatSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from '../../fs/remove-tree.mjs';

export async function runRemote(spec, transport = {}) {
  if (spec.os !== 'windows') throw new Error(`Remote workers on ${spec.os} hosts are unsupported.`);
  const spawn = transport.spawn ?? nativeSpawn;
  const spawnSync = transport.run ?? nativeSpawnSync;
  const say = transport.say ?? (text => process.stderr.write(`[alba remote] ${text}\n`));
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? path.win32.join('C:', path.win32.sep, 'Windows'), 'System32', 'tar.exe') : 'tar';
  const SSH = ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4', '-o', 'ConnectTimeout=15'];
  const PACK = spec.os === 'windows' ? { receive: 'powershell -NoProfile -Command git receive-pack', upload: 'powershell -NoProfile -Command git upload-pack' } : { receive: 'git-receive-pack', upload: 'git-upload-pack' };
  const remoteUrl = `${spec.ssh}:${spec.repo}`;
  const runDir = `${spec.workspace}/runs/${spec.id}`;
  const q = s => `"${s}"`;
  const localStage = mkdtempSync(path.join(path.dirname(spec.local_stage), 'remote-stage-'));
  const resultStage = mkdtempSync(path.join(path.dirname(spec.local_stage), 'remote-result-'));

  function run(program, args, options = {}) {
    const r = spawnSync(program, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: options.timeout ?? 600000, ...options });
    if (r.error) throw new Error(`${path.basename(program)}: ${r.error.message}`);
    return r;
  }
  function must(r, what) {
    if (r.status !== 0) throw new Error(`${what} failed (${r.status}): ${String(r.stderr ?? '').trim().split('\n').slice(-3).join(' | ')}`);
    return String(r.stdout ?? '');
  }
  const git = (args, options) => run('git', ['-C', spec.local_worktree, ...args], options);
  const ssh = (command, options) => run('ssh', [...SSH, spec.ssh, command], options);

  /** Both ends must succeed: an empty or truncated archive is not a successful transfer. */
  function transfer(fromProgram, fromArgs, toProgram, toArgs) {
    return new Promise((resolve, reject) => {
      const from = spawn(fromProgram, fromArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const to = spawn(toProgram, toArgs, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
      from.stdout.pipe(to.stdin);
      let err = '', remaining = 2, failure;
      // Killing a child is not the same as closing its file handles. Settle only after both close events.
      const fail = error => { failure ??= error; from.kill(); to.kill(); };
      to.stdin.on('error', fail);
      for (const child of [from, to]) {
        child.stderr.on('data', data => { err = (err + data).slice(-4000); });
        child.on('error', fail);
        child.on('close', code => {
          if (code !== 0) fail(new Error(`File transfer failed (${code}): ${err.trim()}`));
          if (--remaining === 0) { if (failure) reject(failure); else resolve(); }
        });
      }
    });
  }
  function sendTar(cwd, entries, command) {
    return transfer(tar, ['-cf', '-', '-C', cwd, ...entries], 'ssh', [...SSH, spec.ssh, command]);
  }
  function receiveTar(remoteDir, localDir) {
    return transfer('ssh', [...SSH, spec.ssh, `tar -cf - -C ${q(remoteDir)} .`], tar, ['-xf', '-', '-C', localDir]);
  }

  /** alba's own untracked files in the worktree (ignored or not) under the overlay roots. */
  function overlayFiles() {
    const roots = spec.overlay_roots.filter(r => existsSync(path.join(spec.local_worktree, r)));
    if (!roots.length) return [];
    return must(git(['ls-files', '-z', '-o', '--', ...roots]), 'listing alba files').split('\0').filter(Boolean);
  }

  /** The full oids of the Git LFS files in a tree (the worktree's HEAD, or `ref`); undefined when Git LFS is not installed here. */
  function lfsOids(ref) {
    const listed = git(['lfs', 'ls-files', '-l', ...(ref ? [ref] : [])]);
    if (listed.status !== 0) return undefined;
    return [...new Set(String(listed.stdout).split(/\r?\n/).map(l => /^([0-9a-f]{64}) [*-] /.exec(l)?.[1]).filter(Boolean))];
  }
  /** The local folder that holds this repository's LFS objects. */
  function lfsDir() {
    const env = String(git(['lfs', 'env']).stdout ?? '');
    const media = /^LocalMediaDir=(.+)$/m.exec(env)?.[1]?.trim();
    const common = must(git(['rev-parse', '--git-common-dir']), 'finding the git folder').trim();
    return media || path.join(path.isAbsolute(common) ? common : path.join(spec.local_worktree, common), 'lfs', 'objects');
  }
  /** The Git LFS objects the branch's files need (full oids) and the local folder that holds them; none when the repository has no LFS files. */
  function lfsObjects() {
    const oids = lfsOids() ?? [];
    return oids.length ? { oids, dir: lfsDir() } : { oids, dir: '' };
  }
  const objectPath = oid => `${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`;
  let lfs = { oids: [], dir: '' };

  function rewrite(text) {
    for (const [from, to] of spec.rewrite) for (const f of new Set([from, from.replace(/\//g, '\\')])) text = text.split(f).join(to);
    return text;
  }

  async function stage() {
    const root = localStage;
    const dir = path.join(root, 'runs', spec.id);
    const overlay = path.join(dir, 'overlay');
    mkdirSync(path.join(overlay, '.alba', 'order'), { recursive: true });
    const files = overlayFiles();
    for (const f of files) { mkdirSync(path.dirname(path.join(overlay, f)), { recursive: true }); cpSync(path.join(spec.local_worktree, f), path.join(overlay, f)); }
    for (const f of spec.order_files) writeFileSync(path.join(overlay, '.alba', 'order', path.basename(f)), rewrite(readFileSync(f, 'utf8')), 'utf8');
    writeFileSync(path.join(overlay, '.alba', 'order', 'prompt.md'), rewrite(readFileSync(spec.prompt_file, 'utf8')), 'utf8');
    cpSync(fileURLToPath(new URL('./remote-run.ps1', import.meta.url)), path.join(dir, 'run.ps1'));
    if (spec.read_only) cpSync(fileURLToPath(new URL('./read-only.mjs', import.meta.url)), path.join(dir, 'read-only.mjs'));
    cpSync(fileURLToPath(new URL('./remote-worker.mjs', import.meta.url)), path.join(dir, 'worker.mjs'));
    cpSync(fileURLToPath(new URL('./desktop-run.ps1', import.meta.url)), path.join(dir, 'desktop-run.ps1'));
    cpSync(fileURLToPath(new URL('../../run/environment.mjs', import.meta.url)), path.join(dir, 'environment.mjs'));
    const exclude = path.join(must(git(['rev-parse', '--git-common-dir']), 'finding the git folder').trim(), 'info', 'exclude');
    const excludeFile = path.isAbsolute(exclude) ? exclude : path.join(spec.local_worktree, exclude);
    writeFileSync(path.join(dir, 'exclude.txt'), existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '', 'utf8');
    lfs = lfsObjects();
    if (lfs.oids.length) writeFileSync(path.join(dir, 'lfs-oids.txt'), lfs.oids.join('\n') + '\n', 'utf8');
    const { program, args, env, env_unset, identity, repo, worktree, branch } = spec;
    writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ program, args, env, env_unset, identity, repo, worktree, branch, read_only: spec.read_only, read_only_home: spec.read_only_home }, null, 2), 'utf8');
    say(`sending ${files.length} alba files and the order to ${spec.ssh}:${runDir}`);
    const make = `powershell -NoProfile -NonInteractive -Command "New-Item -ItemType Directory -Force -Path '${spec.workspace}' | Out-Null"`;
    must(ssh(make), 'creating the workspace');
    await sendTar(root, ['runs'], `tar -xf - -C ${q(spec.workspace)}`);
    removeTreeSync(root, { onError: say });
  }

  const script = mode => `powershell -NoProfile -ExecutionPolicy Bypass -File ${q(`${runDir}/run.ps1`)} -Mode ${mode}`;

  /** Returns the LFS objects of the branch that the host's bare repository lacks (the prepare step lists them). */
  function pushBranch() {
    const prepared = must(ssh(script('prepare')), 'preparing the repository on the host');
    // The host has no LFS server, so the push itself skips LFS content; the objects are copied next (sendLfs).
    must(git(['push', '-q', '--no-verify', '--force', `--receive-pack=${PACK.receive}`, remoteUrl, `HEAD:refs/alba/incoming/${spec.branch}`], { env: { ...process.env, GIT_LFS_SKIP_PUSH: '1' } }), 'pushing the branch to the host');
    return prepared.split(/\r?\n/).map(l => /^lfs-missing ([0-9a-f]{64})$/.exec(l.trim())?.[1]).filter(Boolean);
  }

  /** Copies the missing LFS objects into <bare>/lfs/objects, where the host's `git lfs checkout` reads them. */
  async function sendLfs(missing) {
    if (!lfs.oids.length) return;
    const have = missing.filter(oid => existsSync(path.join(lfs.dir, objectPath(oid))));
    const absent = missing.length - have.length;
    if (absent) say(`${absent} LFS object(s) the branch needs are not in the local store either (${lfs.dir}); their files stay pointers on the host`);
    if (!have.length) { say(`the host has all ${lfs.oids.length - absent} LFS object(s) of the branch`); return; }
    const listDir = mkdtempSync(path.join(path.dirname(spec.local_stage), 'remote-lfs-'));
    try {
      const list = path.join(listDir, 'objects.txt');
      writeFileSync(list, have.map(objectPath).join('\n') + '\n', 'utf8');
      const bytes = have.reduce((n, oid) => n + statSync(path.join(lfs.dir, objectPath(oid))).size, 0);
      say(`sending ${have.length} LFS object(s) (${(bytes / 1e6).toFixed(1)} MB) to ${spec.ssh}:${spec.repo}/lfs/objects`);
      await sendTar(lfs.dir, ['-T', list], `tar -xf - -C ${q(`${spec.repo}/lfs/objects`)}`);
    } finally { removeTreeSync(listDir, { onError: say }); }
  }

  /**
   * The LFS objects of the fetched branch that the local store lacks: the worker committed them on the host, where they went into the
   * bare repository's lfs/objects (there is no LFS server to push them to). Copied with tar over SSH, a few dozen per call.
   */
  async function fetchLfs(ref) {
    const oids = lfsOids(ref);
    if (!oids?.length) return;
    const dir = lfs.dir || lfsDir();
    const missing = oids.filter(oid => !existsSync(path.join(dir, objectPath(oid))));
    if (!missing.length) return;
    mkdirSync(dir, { recursive: true });
    say(`fetching ${missing.length} LFS object(s) the host's commits added, from ${spec.ssh}:${spec.repo}/lfs/objects`);
    for (let i = 0; i < missing.length; i += 40) {
      const names = missing.slice(i, i + 40).map(objectPath);
      try { await transfer('ssh', [...SSH, spec.ssh, `tar -cf - -C ${q(`${spec.repo}/lfs/objects`)} ${names.join(' ')}`], tar, ['-xf', '-', '-C', dir]); }
      catch (e) { say(`fetching LFS objects failed: ${e.message}`); }
    }
    const still = missing.filter(oid => !existsSync(path.join(dir, objectPath(oid))));
    if (still.length) say(`${still.length} LFS object(s) of the host's branch are on neither machine; those files stay pointers here`);
  }

  /** Fetches the branch from the host; fast-forwards the local worktree when it is clean and behind. */
  let syncedHead;
  async function syncBack(final) {
    const ref = `refs/alba/remote/${spec.branch}`;
    const f = git(['fetch', '-q', '--no-tags', `--upload-pack=${PACK.upload}`, remoteUrl, `+refs/heads/${spec.branch}:${ref}`]);
    if (f.status !== 0) { say(`fetching the branch back failed: ${String(f.stderr).trim().split('\n').pop()}`); return false; }
    await fetchLfs(ref);
    const head = must(git(['rev-parse', 'HEAD']), 'reading HEAD').trim();
    const there = must(git(['rev-parse', ref]), 'reading the fetched branch').trim();
    if (git(['status', '--porcelain']).stdout.trim()) { say('the local worktree has changes; not synchronizing over them'); return false; }
    if (head === there) { syncedHead = there; return true; }
    if (git(['merge-base', '--is-ancestor', head, there]).status !== 0) { say(`the local branch has commits the host does not have; the host's work is kept at ${ref}`); return false; }
    // Without smudging (an object still missing would make the merge reach for an LFS server); `git lfs checkout` then fills the
    // LFS files from the local store, and leaves a pointer only where the object is on neither machine.
    const m = git(['merge', '-q', '--ff-only', ref], { env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' } });
    if (m.status !== 0) { say(`fast-forward failed: ${String(m.stderr).trim().split('\n').pop()}`); return false; }
    git(['lfs', 'checkout']);
    syncedHead = there;
    say(`${final ? 'final' : 'progress'} sync: ${head.slice(0, 7)} -> ${there.slice(0, 7)}`);
    return true;
  }

  let inboxStamp = '';
  async function sendInbox() {
    const inbox = path.join(spec.local_worktree, '.alba', 'inbox.md');
    if (!existsSync(inbox)) return;
    const s = statSync(inbox); const stamp = `${s.size}:${s.mtimeMs}`;
    if (stamp === inboxStamp) return;
    if (inboxStamp) { await sendTar(spec.local_worktree, ['.alba/inbox.md'], `tar -xf - -C ${q(spec.worktree)}`).catch(e => say(`sending the inbox failed: ${e.message}`)); say('sent the inbox'); }
    inboxStamp = stamp;
  }

  let current;
  /** Set when the host refused to start the worker (see Stop-Dispatch in remote-run.ps1). */
  let dispatchFailed;
  const cancel = () => current?.kill();
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, cancel);

  /** Starts the worker over SSH with the tunnel; resolves with its exit code, or `taken` when the tunnel port is in use. */
  function launch(port) {
    return new Promise(resolve => {
      const forward = spec.tunnel ? ['-o', 'ExitOnForwardFailure=yes', '-R', `127.0.0.1:${port}:127.0.0.1:${spec.tunnel}`] : [];
      const child = spawn('ssh', [...SSH, ...forward, spec.ssh, `${script('run')} -Port ${port}`], { windowsHide: true, stdio: ['ignore', 'inherit', 'pipe'] });
      let taken = false;
      child.stderr.on('data', d => { const t = String(d); if (/forwarding failed/i.test(t)) taken = true; const stop = /\[remote\] dispatch failed: (.*)/.exec(t); if (stop) dispatchFailed = stop[1].trim(); process.stderr.write(t); });
      child.on('error', e => { say(e.message); resolve({ code: 1 }); });
      child.on('close', code => { current = undefined; resolve(taken ? { taken: true } : { code: code ?? 1 }); });
      current = child;
    });
  }

  function safeFile(root, relative) {
    if (!relative || /[\\:]/.test(relative) || path.posix.isAbsolute(relative) || relative.split('/').some(p => p === '..' || p.toLowerCase() === '.git')) throw new Error('Remote result path escapes the worktree.');
    const target = path.resolve(root, relative);
    const rel = path.relative(root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Remote result path escapes the worktree.');
    let current = root;
    for (const part of rel.split(path.sep)) { current = path.join(current, part); if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Remote result traverses a symbolic link.'); }
    return target;
  }
  function resultFiles(root, prefix = '') {
    return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
      const rel = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Remote result contains a symbolic link.');
      return entry.isDirectory() ? resultFiles(path.join(root, entry.name), rel + '/') : [rel];
    });
  }

  async function collect() {
    const local = resultStage;
    await receiveTar(`${runDir}/result`, local);
    if (must(git(['status', '--porcelain']), 'checking local changes').trim() || must(git(['rev-parse', 'HEAD']), 'reading local HEAD').trim() !== syncedHead) throw new Error('Local worktree changed during result transfer; remote results are preserved on the host.');
    const files = path.join(local, 'files');
    const changed = existsSync(files) ? resultFiles(files) : [];
    const targets = changed.map(f => [path.join(files, f), safeFile(spec.local_worktree, f)]);
    const deleted = existsSync(path.join(local, 'deleted.txt')) ? readFileSync(path.join(local, 'deleted.txt'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean) : [];
    const removed = deleted.map(f => safeFile(spec.local_worktree, f));
    for (const [from, to] of targets) { mkdirSync(path.dirname(to), { recursive: true }); cpSync(from, to); }
    for (const to of removed) rmSync(to, { force: true });
    if (deleted.length) say(`removed ${deleted.length} file(s) the worker deleted`);
    if (existsSync(path.join(local, 'last.txt'))) { mkdirSync(path.dirname(spec.last_file), { recursive: true }); cpSync(path.join(local, 'last.txt'), spec.last_file); }
    removeTreeSync(local, { onError: say });
  }

  async function main() {
    say(`order on ${spec.ssh}: ${spec.worktree} (branch ${spec.branch})`);
    if (must(git(['status', '--porcelain']), 'checking the local worktree').trim()) throw new Error('Remote dispatch requires a clean local worktree; commit or preserve its changes first.');
    await stage();
    await sendLfs(pushBranch());
    await sendInbox();
    let updating;
    const timer = spec.read_only ? undefined : setInterval(() => { if (updating) return; updating = syncBack(false).catch(e => say(e.message)).then(() => sendInbox()).catch(e => say(e.message)).finally(() => { updating = undefined; }); }, spec.sync_minutes * 60000);
    let result = { code: 1 };
    for (let i = 0; i < 20; i++) {
      const port = spec.tunnel ? (spec.tunnel_base + i - 1) % 65535 + 1 : 0;
      result = await launch(port);
      if (!result.taken) break;
      say(`port ${port} is in use on ${spec.ssh}; trying the next one`);
    }
    clearInterval(timer);
    if (dispatchFailed) { await updating; throw new Error(`Remote dispatch failed: ${dispatchFailed}`); }
    await updating;
    if (spec.read_only) {
      await receiveTar(`${runDir}/result`, resultStage);
      const check = readFileSync(path.join(resultStage, 'worktree-check'), 'utf8');
      if (check === 'unchanged' && existsSync(path.join(resultStage, 'last.txt'))) cpSync(path.join(resultStage, 'last.txt'), spec.last_file);
      writeFileSync(spec.phase_check, check, 'utf8');
      return result.code ?? 1;
    }
    let synced = false;
    try { synced = await syncBack(true); } catch (e) { say(e.message); }
    if (synced) await collect();
    if (result.code === 0 && !synced) throw new Error('Remote commits could not be synchronized; results remain on the host.');
    return result.code ?? 1;
  }

  try { return await main(); } finally {
    for (const signal of ['SIGTERM', 'SIGINT']) process.off(signal, cancel);
    removeTreeSync(localStage, { onError: say });
    removeTreeSync(resultStage, { onError: say });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRemote(JSON.parse(readFileSync(process.argv[2], 'utf8'))).then(code => { process.exitCode = code; }).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
