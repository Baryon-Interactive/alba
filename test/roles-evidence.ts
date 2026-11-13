/** Reproducible acceptance evidence. Only fake spawn probes; all state stays under ignored .alba/evidence. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadProject } from '../src/config.ts';
import { Orders } from '../src/orders/service.ts';
import { stateStore } from '../src/orders/backend.ts';
import { startRun } from '../src/run/launch.ts';
import type { Probes } from '../src/tick/gather.ts';
import { loadWorkers } from '../src/workers/config.ts';
import { alba, projectDir } from './cli-helper.ts';

const evidence = path.resolve('.alba/evidence/roles');
mkdirSync(evidence, { recursive: true });
const dir = mkdtempSync(path.join(evidence, 'fixture-'));
const file = projectDir(dir, `workers: workers.yaml
dispatch:
  worktree_parent: trees
  base_ref: refs/heads/main
roles:
  art:
    kinds: [art]
    description: Artwork
    rules: rules/art.md
    workers: { prefer: [visual] }
    mcp:
      image: { command: image-tool-server, args: [--stdio], env_from: [IMAGE_API_TOKEN] }
  designer:
    kinds: [design]
    description: Read-only design review
`);
mkdirSync(path.join(dir, 'rules'));
writeFileSync(path.join(dir, 'rules/art.md'), 'Check silhouettes before delivery.\n');
writeFileSync(path.join(dir, 'workers.yaml'), `workers:
  - { id: economical, engine: codex-cli, cost: included, launch: { program: fake-engine, args: [exec, '{prompt_file}'] } }
  - { id: visual, engine: claude-cli, cost: paid, launch: { program: fake-engine, args: ['{prompt_file}'] } }
`);
const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { stdio: 'pipe' });
git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'Example project');
writeFileSync(path.join(dir, 'orders/SAMPLE.md'), '# Artwork\n');
const cli = (args: string[]) => { const r = alba(file, ['--workers', path.join(dir, 'workers.yaml'), ...args], { ALBA_WORKERS: '' }); assert.equal(r.code, 0, r.err); return r.out; };
cli(['orders', 'add', 'SAMPLE', '--title', 'Artwork', '--kind', 'art', '--role', 'art', '--queue']);
assert.equal(JSON.parse(cli(['route', 'SAMPLE', '--json']))[0].role.source, 'explicit');
cli(['orders', 'set', 'SAMPLE', '--role', '']);
assert.equal(JSON.parse(cli(['roles', 'list'])).roles.length, 2);
const show = cli(['roles', 'show', 'art']);
const route = cli(['route', 'SAMPLE']);
assert.match(route, /→ visual/);
const cfg = loadProject(file), orders = new Orders(stateStore(cfg)), workers = loadWorkers(path.join(dir, 'workers.yaml'));
const commands: { engine: string; argv: string[]; environment: string; servers: string[]; warnings: string[] }[] = [];
const prior = process.env.IMAGE_API_TOKEN;
process.env.IMAGE_API_TOKEN = 'fake-value-never-print';
try {
  for (const engine of ['claude-cli', 'codex-cli', 'opencode', 'grok-cli']) {
    const w = workers.workers[1];
    w.engine = engine;
    w.launch!.args = engine === 'codex-cli' ? ['exec', '{prompt_file}'] : engine === 'opencode' ? ['run', '{prompt_file}'] : ['{prompt_file}'];
    let argv: string[] = [];
    const probes = { now: () => new Date(), spawnDetached: (_program: string, args: string[]) => { argv = args; return 123; } } as unknown as Probes;
    startRun({ project: cfg, orders, workers, probes }, 'SAMPLE', 'visual');
    const run = orders.get('SAMPLE').runs.at(-1)!;
    assert.match(readFileSync(run.prompt_file!, 'utf8'), /^## Role rules/);
    commands.push({ engine, argv: ['fake-engine', ...argv], environment: 'IMAGE_API_TOKEN=<redacted>', servers: run.mcp_servers ?? [], warnings: run.role_warnings ?? [] });
    assert.ok(!JSON.stringify(orders.store.events()).includes('fake-value-never-print'));
    orders.runEnd('SAMPLE'); orders.act('SAMPLE', 'queue', { force: true });
  }
} finally { if (prior === undefined) delete process.env.IMAGE_API_TOKEN; else process.env.IMAGE_API_TOKEN = prior; }
const normalize = (text: string) => text.replaceAll(dir.replaceAll('\\', '/'), '<project>').replaceAll(dir.replaceAll('\\', '\\\\'), '<project>').replaceAll(dir, '<project>').replaceAll('SAMPLE', '<TAG>');
const output = normalize(JSON.stringify({ rolesShow: JSON.parse(show), route, commands }, null, 2));
assert.ok(!output.includes('fake-value-never-print'));
writeFileSync(path.join(evidence, 'acceptance.json'), output + '\n');
console.log(output);
