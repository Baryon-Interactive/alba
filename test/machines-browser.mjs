import { DevTools, until } from './browser-devtools.mjs';
import { machinesZh } from '../ui/src/i18n/machines.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { loadProject } from './state-helper.ts';
import { projectDir } from './cli-helper.ts';
import { createBoard } from '../src/web/server.ts';
import { probeMachines } from '../src/machines/probe.ts';
import { systemProbes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';

if (!process.env.ALBA_BROWSER) { console.log('Skipped: ALBA_BROWSER is unset.'); process.exit(0); }

const evidence = path.resolve('.alba/machines-evidence'); mkdirSync(evidence, { recursive: true });
const dir = mkdtempSync(path.join(evidence, 'fixture-'));
const project = loadProject(projectDir(dir, 'machines: machines.yaml\n'));
writeFileSync(project.machines, stringify({ machines: [
  { id: 'build-box', name: 'Build box', os: 'windows', connect: { ssh: 'build-box' }, hardware: { cpu: 'Example 16-core CPU', ram_gb: 64 }, roles: ['compile-helper'], slots: 2, services: [{ id: 'compile-agent', check: { process: 'compile-agent' }, start_hint: 'Open the compile helper application.' }] },
  { id: 'sim-linux', name: 'Simulation box', os: 'linux', connect: { ssh: 'sim-linux' }, roles: ['sim'], services: [{ id: 'gateway', check: { process: 'model-gateway' }, start_hint: 'Start the model gateway.' }] },
] }));
let now = new Date(Date.now() - 12 * 3600000), free = 24;
const probes = { ...systemProbes, now: () => now, runCommandAsync: async argv => {
  if (argv.includes('sim-linux')) throw new Error('Unreachable synthetic machine.');
  return JSON.stringify({ free_mem_gb: free, total_mem_gb: 64, load: 0.25, uptime_seconds: 7200, disks: [{ mount: 'system', free_gb: 60, total_gb: 200 }], services: [{ id: 'compile-agent', up: false }] });
}, worktrees: () => [], freeRamGb: () => 32 };
for (let i = 0; i < 13; i++) { free = 24 + i % 4; await probeMachines(project, probes, { force: true }); now = new Date(now.getTime() + 3600000); }
now = new Date();
const workers = validateWorkers({ workers: [{ id: 'sample-worker', engine: 'fake' }] }, path.join(dir, 'workers.yaml'));
const board = createBoard({ projects: [project], workers, probes, port: 0, uiDir: path.resolve('ui/dist'), hubCheckMs: 100000 });
await new Promise(resolve => board.server.once('listening', resolve));
const base = `http://127.0.0.1:${board.server.address().port}`;
const profile = path.join(dir, 'browser');
const browser = spawn(process.env.ALBA_BROWSER, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const cdp = new DevTools(), checks = [];
try {
  const response = await fetch(`${base}/api/machines?project=demo`, { headers: { 'x-alba-token': board.ctx.token } }); assert.equal(response.status, 200);
  assert.equal((await response.json()).machines.length, 2);
  const portFile = path.join(profile, 'DevToolsActivePort'); await until(() => existsSync(portFile), 'browser debugger');
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  await cdp.connect(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await cdp.call('Runtime.enable'); await cdp.call('Page.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: "if(!localStorage.getItem('alba-lang'))localStorage.setItem('alba-lang','en');localStorage.setItem('alba-theme','light');" });
  // the sign-in link sets the session cookie and goes on to the page
  await cdp.call('Page.navigate', { url: `${base}/login?key=${board.ctx.token}&next=${encodeURIComponent('/p/demo/machines')}` });
  for (const lang of ['en', 'zh']) {
    if (lang === 'zh') { await cdp.js("localStorage.setItem('alba-lang','zh')"); await cdp.call('Page.reload'); }
    await until(() => cdp.js(`document.querySelectorAll('[data-machine]').length===2&&document.querySelector('h1')?.textContent.includes(${JSON.stringify(lang === 'en' ? 'Machines' : machinesZh['Machines'])})`), `${lang} page`);
    assert.ok(await cdp.js(`document.body.innerText.includes(${JSON.stringify(lang === 'en' ? 'Unreachable' : machinesZh['Unreachable'])})&&document.body.innerText.includes(${JSON.stringify(lang === 'en' ? 'Down' : machinesZh['Down'])})`));
    assert.ok(await cdp.js("document.querySelector('[data-machine=build-box]').innerText.includes('Open the compile helper application.')"));
    assert.equal(await cdp.js("document.querySelectorAll('[data-memory-history] circle').length"), 13);
    assert.ok(await cdp.js("!!document.querySelector('nav a[href=\"/p/demo/machines\"][aria-current=page]')"));
    assert.ok(await cdp.js('document.documentElement.scrollWidth===innerWidth'));
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(path.join(evidence, `machines-${lang}-1440x900.png`), Buffer.from(screenshot.data, 'base64'));
    checks.push(`${lang}: cards, service status, hints, 24h history, navigation, no horizontal overflow`);
  }
  assert.equal(cdp.errors.length, 0);
  writeFileSync(path.join(evidence, 'browser-results.json'), JSON.stringify({ viewport: { width: 1440, height: 900 }, checks }, null, 2));
  console.log(checks.join('\n'));
} finally {
  cdp.socket?.close(); browser.kill(); board.hub.stop(); board.server.closeAllConnections(); board.server.close();
}
