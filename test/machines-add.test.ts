import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { addMachine, appendSshHost, classifySsh, hostPublicKeys, removeMachine, setMachineRoles, sshHasHost, sshHostBlock, testSsh } from '../src/machines/edit.ts';
import { parseCapabilities, suggestRoles } from '../src/machines/capabilities.ts';
import { validateMachines } from '../src/machines/config.ts';
import { EditRefused } from '../src/yamledit.ts';
import { tmpDir } from './tmp.ts';

const tmp = () => tmpDir('alba-machines-add-');
const box = (id = 'build-box') => ({ id, name: 'Build box', os: 'windows', connect: { ssh: id }, roles: ['package'], slots: 2, min_free_mem_gb: 8,
  services: [{ id: 'agent', check: { process: 'agent.exe' }, start_hint: 'Start the agent.' }] });

test('adding a machine creates the registry, keeps comments, refuses duplicates and bad entries', () => {
  const dir = tmp(), file = path.join(dir, 'machines.yaml');
  assert.equal(addMachine(file, box(), { dryRun: true }).dryRun, true);
  assert.equal(existsSync(file), false, 'a dry run writes nothing');
  addMachine(file, box());
  assert.deepEqual(validateMachines(parse(readFileSync(file, 'utf8'))).machines.map(m => m.id), ['build-box']);
  writeFileSync(file, '# studio machines\n' + readFileSync(file, 'utf8'));
  const second = addMachine(file, { ...box('sim-linux'), os: 'linux' });
  assert.ok(second.backup && existsSync(second.backup), 'the old file is kept');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^# studio machines/);
  assert.deepEqual(validateMachines(parse(text)).machines.map(m => m.id), ['build-box', 'sim-linux']);
  assert.throws(() => addMachine(file, box()), (e: unknown) => e instanceof EditRefused && /already/.test(e.message));
  assert.throws(() => addMachine(file, { ...box('x'), connect: { ssh: 'bad alias; rm' } }), EditRefused);
  assert.throws(() => addMachine(file, { ...box('y'), surprise: 1 }), EditRefused);
  removeMachine(file, 'build-box');
  assert.deepEqual(validateMachines(parse(readFileSync(file, 'utf8'))).machines.map(m => m.id), ['sim-linux']);
  assert.throws(() => removeMachine(file, 'build-box'), EditRefused);
});

test('SSH config blocks are validated, appended once and backed up', () => {
  const dir = tmp();
  const input = { alias: 'build-box', hostname: '192.0.2.10', user: 'studio', identity_file: '~/.ssh/id_ed25519' };
  assert.equal(sshHostBlock(input), 'Host build-box\n    HostName 192.0.2.10\n    User studio\n    IdentityFile ~/.ssh/id_ed25519\n    IdentitiesOnly yes\n');
  assert.throws(() => sshHostBlock({ ...input, hostname: 'a b' }), EditRefused);
  assert.throws(() => sshHostBlock({ ...input, identity_file: '~/.ssh/id_ed25519.pub' }), EditRefused);
  assert.throws(() => sshHostBlock({ ...input, user: 'x\nProxyCommand evil' }), EditRefused);
  const first = appendSshHost(input, { dir });
  assert.equal(first.backup, undefined);
  writeFileSync(first.file, readFileSync(first.file, 'utf8') + 'Host other-box\n    HostName 192.0.2.11\n');
  const second = appendSshHost({ ...input, alias: 'sim-linux', port: 2222 }, { dir });
  assert.ok(second.backup && existsSync(second.backup));
  const text = readFileSync(second.file, 'utf8');
  assert.ok(sshHasHost(text, 'build-box') && sshHasHost(text, 'sim-linux') && sshHasHost(text, 'other-box'));
  assert.match(text, /Port 2222/);
  assert.throws(() => appendSshHost(input, { dir }), (e: unknown) => e instanceof EditRefused && /already/.test(e.message));
});

test('only public key files are offered to the guide', () => {
  const dir = tmp();
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'id_ed25519'), ['-----BEGIN', 'OPENSSH', 'PRIVATE KEY-----\nsecret\n'].join(' '));
  writeFileSync(path.join(dir, 'id_ed25519.pub'), 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample studio@host\n');
  writeFileSync(path.join(dir, 'odd.pub'), ['-----BEGIN', 'OPENSSH', 'PRIVATE KEY-----\n'].join(' '));
  assert.deepEqual(hostPublicKeys(dir), [{ file: 'id_ed25519.pub', key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample studio@host' }]);
  assert.deepEqual(hostPublicKeys(path.join(dir, 'missing')), []);
  assert.ok(readdirSync(dir).includes('id_ed25519'));
});

test('SSH failures become actionable categories without leaking the raw message', async () => {
  assert.equal(classifySsh('ssh: Could not resolve hostname build-box: No such host is known.'), 'unresolved');
  assert.equal(classifySsh('ssh: connect to host 192.0.2.10 port 22: Connection refused'), 'refused');
  assert.equal(classifySsh('ssh: connect to host 192.0.2.10 port 22: Connection timed out'), 'timeout');
  assert.equal(classifySsh('studio@192.0.2.10: Permission denied (publickey,password,keyboard-interactive).'), 'denied');
  assert.equal(classifySsh('Host key verification failed.'), 'host-key');
  assert.equal(classifySsh('kex_exchange_identification: read: Connection aborted'), 'failed');
  const seen: string[][] = [];
  const ok = await testSsh('build-box', async (program, args) => { seen.push([program, ...args]); return { code: 0, stdout: 'BUILD-BOX\r\n', stderr: '' }; });
  assert.deepEqual(ok, { ok: true, category: 'ok', remoteName: 'BUILD-BOX', seconds: ok.seconds });
  assert.ok(seen[0].includes('BatchMode=yes') && seen[0].includes('StrictHostKeyChecking=accept-new') && seen[0].at(-1) === 'hostname');
  const linux = await testSsh('sim-linux', async (_p, args) => ({ code: 0, stdout: args.at(-1) === 'uname -s' ? 'Linux\n' : 'sim-linux\n', stderr: '' }));
  assert.equal(linux.detectedOs, 'linux');
  const windows = await testSsh('build-box', async (_p, args) => args.at(-1) === 'uname -s'
    ? { code: 1, stdout: '', stderr: "'uname' is not recognized as an internal or external command," } : { code: 0, stdout: 'BUILD-BOX\r\n', stderr: '' });
  assert.equal(windows.detectedOs, 'windows');
  const denied = await testSsh('build-box', async () => ({ code: 255, stdout: '', stderr: 'studio@192.0.2.10: Permission denied (publickey).' }));
  assert.deepEqual(Object.keys(denied).sort(), ['category', 'ok', 'seconds']);
  assert.equal(denied.category, 'denied');
  assert.equal((await testSsh('build-box', async () => ({ code: 1, stdout: '', stderr: '', missing: true }))).category, 'no-ssh');
  await assert.rejects(() => testSsh('-oProxyCommand=evil'), EditRefused);
});

test('capability scans parse on Windows and Linux and suggest roles with reasons and gaps', () => {
  const win = parseCapabilities(JSON.stringify({ cpu: 'Example 6-core CPU', cores: 6, threads: 12, ram: 15.9, os: 'Windows 11 Pro 10.0',
    gpus: [{ name: 'AMD Radeon RX 5700 XT', vram: 8 * 2 ** 30 }, { name: 'Microsoft Basic Display Adapter', vram: null }],
    tools: { python: '3.13', git: '2.45.1.1', 'git-lfs': 'installed', cmake: '3.29.0', clang: '18.1.0' } }), '2026-01-01T00:00:00Z');
  assert.equal('engines' in win, false); assert.equal(win.gpus[0].vram_gb, 8); assert.equal(win.gpus[0].vendor, 'amd');
  const requirements = { sim: { tools: ['compiler', 'cmake', 'python'], min_threads: 8, min_ram_gb: 15 } };
  const s = suggestRoles('windows', win, requirements);
  assert.deepEqual(s.roles.map(r => r.role), ['sim', 'gpu-qa']);
  assert.match(s.roles.find(r => r.role === 'gpu-qa')!.reason, /AMD baseline/);
  assert.deepEqual(s.roles.find(r => r.role === 'sim')!.vars, { tools: 'compiler, cmake, python', threads: 12, ram: 15.9 });
  assert.deepEqual(s.missing, []);
  const bare = suggestRoles('windows', { ...win, tools: {} }, requirements);
  assert.deepEqual(bare.roles.map(r => r.role), ['gpu-qa']);
  assert.deepEqual(bare.missing.map(m => `${m.for}:${m.what}`), ['sim:a C++ compiler (gcc or clang)', 'sim:CMake', 'sim:Python']);
  const linux = parseCapabilities('cpu\tExample 8-core CPU\nthreads\t16\ncores\t8\nram\t30.2\nos\tExample Linux\ngpu\tNVIDIA GeForce RTX 3060 Ti\t8192\n'
    + 'pci\tNVIDIA Corporation GA104 [GeForce RTX 3060 Ti]\ntool\tgcc\tgcc (Example) 15.2.0\ntool\tcmake\tcmake version 4.4.4\ntool\tpython3\tPython 3.14.4\nend\n', '2026-01-01T00:00:00Z');
  assert.equal(linux.gpus.length, 1, 'nvidia-smi already named the card'); assert.equal(linux.gpus[0].vram_gb, 8);
  assert.deepEqual(linux.tools, { gcc: '15.2.0', cmake: '4.4.4', python: '3.14.4' });
  assert.deepEqual(suggestRoles('linux', linux, requirements).roles.map(r => r.role), ['sim', 'gpu-qa']);
  assert.throws(() => parseCapabilities('cpu\tx\n', 'now'), /Incomplete/);
  assert.deepEqual(suggestRoles('linux', { ...linux, error: 'Capability scan failed.' }), { roles: [], missing: [] });
});

test('roles can be replaced by the suggested set', () => {
  const dir = tmp(), file = path.join(dir, 'machines.yaml');
  addMachine(file, box());
  setMachineRoles(file, 'build-box', ['package', 'gpu-qa', 'package']);
  assert.deepEqual(validateMachines(parse(readFileSync(file, 'utf8'))).machines[0].roles, ['package', 'gpu-qa']);
  assert.throws(() => setMachineRoles(file, 'build-box', ['Bad Role']), EditRefused);
  assert.throws(() => setMachineRoles(file, 'missing', ['sim']), EditRefused);
});
