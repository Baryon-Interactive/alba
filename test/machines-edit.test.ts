import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { addMachine, editMachine, machineOpsFromSet } from '../src/machines/edit.ts';
import { editSshHost, readSshHost, rewriteSshHost, sshHostInfo } from '../src/machines/ssh-config.ts';
import { validateMachines } from '../src/machines/config.ts';
import { EditRefused } from '../src/yamledit.ts';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'alba-machines-edit-'));
const REGISTRY = `# studio machines
probe_minutes: 5
machines:
  # the AMD test box
  - id: gpu-amd
    name: 5700 XT box   # renamed in 2026
    os: windows
    connect: { ssh: gpu-amd }
    engine: unreal
    hardware: { cpu: Example 8-core, ram_gb: 32, gpu: AMD Radeon RX 5700 XT }
    roles: [gpu-qa]
    slots: 1
    services:
      - id: agent
        check: { process: agent.exe }
  - id: sim-linux
    name: Sim box
    os: linux
    connect: { ssh: sim-linux }
`;

test('a machine is edited field by field with comments, other machines and unnamed fields kept', () => {
  const dir = tmp(), file = path.join(dir, 'machines.yaml');
  writeFileSync(file, REGISTRY);
  const dry = editMachine(file, 'gpu-amd', machineOpsFromSet({ name: 'AMD box', slots: 2 }), { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.changed.sort(), ['name', 'slots']);
  assert.equal(readFileSync(file, 'utf8'), REGISTRY, 'a dry run writes nothing');
  const out = editMachine(file, 'gpu-amd', [
    ...machineOpsFromSet({ name: 'AMD box', slots: 2, notes: 'IP changed on 2026-11-12', roles: ['gpu-qa', 'package'], min_free_mem_gb: 6, timing_allowed: true, workspace: ['D:', 'alba'].join('/') }),
    { path: ['hardware', 'ram_gb'], value: 64 },
  ], { now: new Date('2026-11-12T10:00:00Z') });
  assert.ok(out.backup && existsSync(out.backup), 'the old file is kept');
  assert.equal(readFileSync(out.backup!, 'utf8'), REGISTRY);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^# studio machines\n/);
  assert.match(text, /# the AMD test box/);
  const machines = validateMachines(parse(text)).machines;
  const amd = machines.find(m => m.id === 'gpu-amd')!;
  assert.equal(amd.name, 'AMD box'); assert.equal(amd.slots, 2); assert.equal(amd.min_free_mem_gb, 6); assert.equal(amd.timing_allowed, true);
  assert.deepEqual(amd.hardware, { cpu: 'Example 8-core', ram_gb: 64, gpu: 'AMD Radeon RX 5700 XT' });
  assert.equal(amd.engine, 'unreal', 'a field that was not named stays');
  assert.deepEqual(amd.services.map(s => s.id), ['agent']);
  assert.deepEqual(machines.find(m => m.id === 'sim-linux'), validateMachines(parse(REGISTRY)).machines[1], 'the other machine is untouched');
  // connect: SSH alias to local and back; notes removed with null
  editMachine(file, 'gpu-amd', machineOpsFromSet({ connect: { local: true }, notes: null }));
  let again = validateMachines(parse(readFileSync(file, 'utf8'))).machines[0];
  assert.deepEqual(again.connect, { local: true }); assert.equal(again.notes, undefined);
  editMachine(file, 'gpu-amd', machineOpsFromSet({ connect: { ssh: 'amd-box' }, services: [], os: 'linux', workspace: '/data/alba', repos: { game: '/data/alba/repos/game.git' } }));
  again = validateMachines(parse(readFileSync(file, 'utf8'))).machines[0];
  assert.deepEqual(again.connect, { ssh: 'amd-box' }); assert.deepEqual(again.services, []); assert.equal(again.os, 'linux');
  assert.deepEqual(again.repos, { game: '/data/alba/repos/game.git' });
});

test('a machine edit is validated like an added machine and refuses ids, unknown fields and missing machines', () => {
  const dir = tmp(), file = path.join(dir, 'machines.yaml');
  writeFileSync(file, REGISTRY);
  const refused = (set: Record<string, unknown>, re: RegExp) => assert.throws(() => editMachine(file, 'gpu-amd', machineOpsFromSet(set)), (e: unknown) => e instanceof EditRefused && re.test(e.message));
  refused({ id: 'other' }, /id cannot be changed/);
  refused({ surprise: 1 }, /Unknown machine field/);
  refused({ slots: 0 }, /slots/);
  refused({ os: 'amiga' }, /os/);
  refused({ connect: { ssh: 'bad alias; rm' } }, /connect/);
  refused({ connect: { local: true, ssh: 'x' } }, /connect/);
  refused({ workspace: 'alba\\work' }, /workspace\b/);
  refused({ services: [{ id: 'a', check: { http: 'http://user:pw@host/' } }] }, /credentials/);
  refused({ 'services.0': 'x' }, /as a whole/);
  assert.throws(() => editMachine(file, 'missing', machineOpsFromSet({ name: 'x' })), (e: unknown) => e instanceof EditRefused && /No machine/.test(e.message));
  assert.throws(() => editMachine(file, 'gpu-amd', []), EditRefused);
  assert.equal(readFileSync(file, 'utf8'), REGISTRY, 'a refused edit writes nothing');
});

test('an added machine can be edited back and forth with CRLF line endings kept', () => {
  const dir = tmp(), file = path.join(dir, 'machines.yaml');
  addMachine(file, { id: 'box', name: 'Box', os: 'windows', connect: { ssh: 'box' } });
  writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  editMachine(file, 'box', machineOpsFromSet({ name: 'Box 2' }));
  const text = readFileSync(file, 'utf8');
  assert.ok(!/[^\r]\n/.test(text), 'CRLF kept');
  assert.equal(validateMachines(parse(text)).machines[0].name, 'Box 2');
});

const SSH = [
  '# my hosts',
  'Include ~/.ssh/config.d/*',
  '',
  'Host gpu39',
  '    HostName 192.0.2.39',
  '    User studio',
  '    IdentityFile ~/.ssh/id_ed25519',
  '',
  '# the AMD box (moved)',
  'Host gpu-box',
  '  HostName 192.0.2.57',
  '  User dev',
  '  IdentityFile "~/.ssh/id ed25519"',
  '  IdentitiesOnly yes',
  '',
  'Match host *.lan exec "true"',
  '    User lanuser',
  '',
  'Host win-dev win-dev-alt',
  '    HostName=192.0.2.40',
  '',
  'Host *',
  '    ServerAliveInterval 30',
  '',
].join('\n');

test('the SSH Host block of an alias is found and only its address lines change', () => {
  const info = sshHostInfo(SSH, 'gpu-box');
  assert.equal(info.found, true);
  assert.equal(info.line, 10);
  assert.deepEqual(info.address, { hostname: '192.0.2.57', user: 'dev' });
  assert.equal(info.block, 'Host gpu-box\n  HostName 192.0.2.57\n  User dev\n  IdentityFile "~/.ssh/id ed25519"\n  IdentitiesOnly yes\n');
  assert.deepEqual(info.problems, []);
  assert.deepEqual(info.includes, ['~/.ssh/config.d/*']);

  const out = rewriteSshHost(SSH, 'gpu-box', { hostname: '192.0.2.77', port: 2222 });
  assert.deepEqual(out.changed.sort(), ['hostname', 'port']);
  assert.equal(out.after, 'Host gpu-box\n  Port 2222\n  HostName 192.0.2.77\n  User dev\n  IdentityFile "~/.ssh/id ed25519"\n  IdentitiesOnly yes\n');
  const a = SSH.split('\n'), b = out.text.split('\n');
  assert.equal(b.length, a.length + 1);
  const diff = b.filter(l => !a.includes(l));
  assert.deepEqual(diff, ['  Port 2222', '  HostName 192.0.2.77'], 'nothing else in the file changed');
  assert.ok(b.includes('    HostName 192.0.2.39') && b.includes('    HostName=192.0.2.40') && b.includes('Match host *.lan exec "true"'));

  // the same value again changes nothing; the separator and keyword spelling of a line are kept
  assert.deepEqual(rewriteSshHost(out.text, 'gpu-box', { hostname: '192.0.2.77' }).changed, []);
  const back = rewriteSshHost(out.text, 'gpu-box', { port: null, user: 'studio' });
  assert.equal(back.after, 'Host gpu-box\n  HostName 192.0.2.77\n  User studio\n  IdentityFile "~/.ssh/id ed25519"\n  IdentitiesOnly yes\n');
  assert.equal(rewriteSshHost(SSH, 'gpu39', { port: 22 }).changed.length, 0, 'port 22 needs no line');
});

test('aliases that are shared, overridden earlier, missing or included are refused with the reason', () => {
  const refused = (text: string, alias: string, re: RegExp) => assert.throws(() => rewriteSshHost(text, alias, { hostname: '10.0.0.1' }), (e: unknown) => e instanceof EditRefused && re.test(e.message));
  refused(SSH, 'win-dev', /names win-dev-alt too/);
  refused(SSH, 'missing-box', /not in config\. It may come from an Include \(~\/\.ssh\/config\.d\/\*\)/);
  refused('Host other\n  HostName x\n', 'missing-box', /Write a Host block/);
  refused('Host gpu*\n  HostName 10.9.9.9\n\nHost gpu-box\n  HostName 10.0.0.2\n', 'gpu-box', /Line 2 sets HostName/);
  refused('HostName 10.9.9.9\nHost gpu-box\n  HostName 10.0.0.2\n', 'gpu-box', /Line 1 sets HostName/);
  // a negated pattern or a non-matching wildcard before the block does not count
  assert.equal(rewriteSshHost('Host * !gpu-box\n  HostName 10.9.9.9\nHost 5800*\n  User x\nHost gpu-box\n  HostName 10.0.0.2\n', 'gpu-box', { hostname: '10.0.0.3', user: 'me' }).changed.length, 2);
  assert.throws(() => rewriteSshHost(SSH, 'gpu-box', { hostname: 'a b' }), EditRefused);
  assert.throws(() => rewriteSshHost(SSH, 'gpu-box', { user: 'x\nProxyCommand evil' }), EditRefused);
  assert.throws(() => rewriteSshHost(SSH, 'gpu-box', { port: 70000 }), EditRefused);
  assert.throws(() => rewriteSshHost(SSH, '-oProxyCommand=x', { hostname: '10.0.0.1' }), EditRefused);
});

test('the SSH config file is rewritten with CRLF and BOM kept, a backup made, and a dry run writes nothing', () => {
  const dir = tmp(), file = path.join(dir, 'config');
  const original = '\uFEFF' + SSH.replace(/\n/g, '\r\n');
  writeFileSync(file, original);
  const dry = editSshHost('gpu-box', { hostname: '192.0.2.77' }, { dir, dryRun: true });
  assert.equal(dry.dryRun, true); assert.deepEqual(dry.changed, ['hostname']);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(readSshHost('gpu-box', { dir }).address.hostname, '192.0.2.57');
  const out = editSshHost('gpu-box', { hostname: '192.0.2.77' }, { dir, now: new Date('2026-11-12T10:00:00Z') });
  assert.ok(out.backup && readFileSync(out.backup, 'utf8') === original);
  const text = readFileSync(file, 'utf8');
  assert.ok(text.startsWith('\uFEFF'));
  assert.equal(text, original.replace('HostName 192.0.2.57', 'HostName 192.0.2.77'));
  assert.equal(readSshHost('gpu-box', { dir }).address.hostname, '192.0.2.77');
  assert.match(readSshHost('x', { dir: path.join(dir, 'none') }).problems[0], /no SSH config/);
  assert.throws(() => editSshHost('gpu-box', { hostname: '1.2.3.4' }, { dir: path.join(dir, 'none') }), EditRefused);
});

test('the edit API checks both parts before writing, rewrites the SSH alias, then tests and probes the machine', async () => {
  const { fixture } = await import('./api-fixture.ts');
  const f = await fixture({ populate: false, project: dir => {
    const file = path.join(dir, 'machines.yaml');
    writeFileSync(file, REGISTRY);
    return { machines: file };
  } });
  const sshDir = path.join(f.dir, 'ssh');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(sshDir);
  writeFileSync(path.join(sshDir, 'config'), SSH.replace('Host gpu-box', 'Host gpu-amd'));
  const tested: string[] = [];
  f.board.ctx.ssh = { dir: sshDir, test: async alias => { tested.push(alias); return { ok: false, category: 'timeout', seconds: 5 }; } };
  const registry = path.join(f.dir, 'machines.yaml');

  const host = await f.get('/api/machines/ssh-host?alias=gpu-amd');
  assert.equal(host.status, 200);
  assert.deepEqual(host.body.address, { hostname: '192.0.2.57', user: 'dev' });
  assert.match(host.body.block, /^Host gpu-amd\n  HostName 192.0.2.57\n/);
  assert.equal((await f.get('/api/machines/ssh-host?alias=bad;alias')).status, 400);
  assert.match((await f.get('/api/machines/ssh-host?alias=sim-linux')).body.problems[0], /may come from an Include/);

  assert.equal((await f.post('/api/machines/edit', { id: 'gpu-amd', set: { name: 'x' } })).status, 401, 'writes need the token');
  const dry = await f.write('/api/machines/edit', { id: 'gpu-amd', set: { name: 'AMD box' }, ssh: { hostname: '192.0.2.77' }, dryRun: true });
  assert.equal(dry.status, 200);
  assert.deepEqual(dry.body.changed, ['name']);
  assert.match(dry.body.ssh.after, /HostName 192.0.2.77/);
  assert.equal(readFileSync(registry, 'utf8'), REGISTRY);

  // one bad part refuses the whole edit: nothing is written
  const bad = await f.write('/api/machines/edit', { id: 'gpu-amd', set: { name: 'AMD box' }, ssh: { hostname: 'bad host' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.details[0].field, 'hostname');
  assert.equal(readFileSync(registry, 'utf8'), REGISTRY);
  assert.equal((await f.write('/api/machines/edit', { id: 'sim-linux', ssh: { hostname: '10.0.0.1' } })).status, 400, 'an alias from an Include is not guessed');
  assert.equal((await f.write('/api/machines/edit', { id: 'gpu-amd', ssh: { identity_file: 'x' } })).status, 400, 'key paths are not changed here');
  assert.equal((await f.write('/api/machines/edit', { id: 'missing', set: { name: 'x' } })).status, 409);
  assert.equal((await f.write('/api/machines/edit', { id: 'gpu-amd' })).status, 400);

  const out = await f.write('/api/machines/edit', { id: 'gpu-amd', set: { name: 'AMD box', notes: 'moved' }, ssh: { hostname: '192.0.2.77', port: 2200 } });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.changed.sort(), ['name', 'notes']);
  assert.ok(existsSync(out.body.backup) && existsSync(out.body.ssh.backup));
  assert.deepEqual(out.body.ssh.changed.sort(), ['hostname', 'port']);
  assert.deepEqual(out.body.connection, { ok: false, category: 'timeout', seconds: 5 });
  assert.deepEqual(tested, ['gpu-amd'], 'the new address was tested');
  const ssh = readFileSync(path.join(sshDir, 'config'), 'utf8');
  assert.match(ssh, /Host gpu-amd\n  Port 2200\n  HostName 192.0.2.77\n  User dev\n  IdentityFile "~\/\.ssh\/id ed25519"/);
  assert.match(ssh, /Host gpu39\n    HostName 192.0.2.39/);
  assert.equal(validateMachines(parse(readFileSync(registry, 'utf8'))).machines[0].name, 'AMD box');
  const events = f.orders.store.events({ limit: 10 }).map(e => e.type);
  assert.ok(events.includes('machines.edited') && events.includes('machines.ssh-config'));

  // a field change alone does not test the connection; making it local needs no SSH
  tested.length = 0;
  assert.equal((await f.write('/api/machines/edit', { id: 'gpu-amd', set: { slots: 3 } })).status, 200);
  assert.deepEqual(tested, []);
  const local = await f.write('/api/machines/edit', { id: 'gpu-amd', set: { connect: { local: true } } });
  assert.equal(local.body.connection.ok, true);
  assert.equal((await f.write('/api/machines/edit', { id: 'gpu-amd', ssh: { hostname: '10.0.0.1' } })).status, 400, 'a local machine has no SSH address');
});

test('alba machines edit shows the entry and Host block, changes fields and previews an address change', async () => {
  const { alba, projectDir } = await import('./cli-helper.ts');
  const dir = tmp(), project = projectDir(dir, 'machines: machines.yaml\n');
  const registry = path.join(dir, 'machines.yaml');
  writeFileSync(registry, REGISTRY);
  const home = path.join(dir, 'home');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(path.join(home, '.ssh'), { recursive: true });
  writeFileSync(path.join(home, '.ssh', 'config'), SSH.replace('Host gpu-box', 'Host gpu-amd'));
  const env = { USERPROFILE: home, HOME: home };
  const shown = alba(project, ['machines', 'edit', 'gpu-amd'], env);
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /name: 5700 XT box/);
  assert.match(shown.out, /Host gpu-amd\n  HostName 192.0.2.57/);
  const dry = alba(project, ['machines', 'edit', 'gpu-amd', 'name=AMD box', 'hardware.ram_gb=64', 'ssh.hostname=192.0.2.77', '--dry-run'], env);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /would change name, hardware\.ram_gb/);
  assert.match(dry.out, /--- after\nHost gpu-amd\n  HostName 192.0.2.77/);
  assert.equal(readFileSync(registry, 'utf8'), REGISTRY);
  const done = alba(project, ['machines', 'edit', 'gpu-amd', 'slots=2', 'notes=null'], env);
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /changed slots/);
  assert.equal(validateMachines(parse(readFileSync(registry, 'utf8'))).machines[0].slots, 2);
  const refused = alba(project, ['machines', 'edit', 'gpu-amd', 'id=other'], env);
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /id cannot be changed/);
  assert.match(alba(project, ['machines', 'edit', 'gpu-amd', 'ssh.identity=x'], env).err, /Unknown SSH field/);
});
