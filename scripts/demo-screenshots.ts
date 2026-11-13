/** Capture real console pages using only examples/demo; no model or image service. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { removeTreeSync } from '../src/fs/remove-tree.mjs';
import path from 'node:path';
import { runDemo } from '../examples/demo/run.ts';
import { loadProject } from '../src/config.ts';
import { loadWorkers } from '../src/workers/config.ts';
import { closeStateStores } from '../src/orders/backend.ts';
import { createBoard } from '../src/web/server.ts';
import { systemProbes } from '../src/tick/gather.ts';
import { stopTreeAsync } from '../src/run/kill-tree.ts';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'docs/img');
const browserPath = process.env.ALBA_BROWSER ?? [
  path.join(process.env.ProgramFiles ?? '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
  path.join(path.sep, 'usr/bin/chromium'), path.join(path.sep, 'usr/bin/google-chrome'),
  path.join(path.sep, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
].find(file => existsSync(file));
assert.ok(browserPath, 'Set ALBA_BROWSER to a local Chromium executable.');
assert.ok(existsSync(path.join(root, 'ui/dist/index.html')), 'Run pnpm -C ui build first.');
const demo = await runDemo({ showcase: true }), project = loadProject(path.join(demo.directory, 'project/alba.yaml'));
const workers = loadWorkers(path.join(project.root, 'workers.yaml'));
const profile = path.join(demo.directory, 'browser');
const board = createBoard({ projects: [project], workers, port: 0, probes: { ...systemProbes, freeRamGb: () => 16 }, background: false, uiDir: path.join(root, 'ui/dist') });
if (!board.server.listening) await once(board.server, 'listening');
const address = board.server.address(); assert.ok(address && typeof address !== 'string');
const before = Date.now();
const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket: WebSocket | undefined;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) { if (await check()) return; await pause(100); }
  throw new Error(`Timed out: ${label}`);
}
let sequence = 0;
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
const browserErrors: string[] = [];
function call(method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Debugger timeout: ${method}`)); }, 15_000);
    pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
    socket!.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression: string) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
try {
  const portFile = path.join(profile, 'DevToolsActivePort');
  await until(() => existsSync(portFile), 'browser debugger');
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
  socket = new WebSocket(tabs.find(tab => tab.type === 'page')!.webSocketDebuggerUrl);
  socket.onmessage = event => { const message = JSON.parse(String(event.data)); if (message.method === 'Runtime.exceptionThrown') browserErrors.push(JSON.stringify(message.params.exceptionDetails)); const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id); if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result); };
  await once(socket, 'open');
  await call('Page.enable'); await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await call('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('alba-lang','en');localStorage.setItem('alba-theme','dark');" });
  mkdirSync(output, { recursive: true });
  const captures: { file: string; route: string; sha256: string }[] = [];
  for (const [name, route] of [['console', '/'], ['board', '/p/demo/board?empty=hide']]) {
    await call('Page.navigate', { url: `http://127.0.0.1:${address.port}/login?key=${board.ctx.token}&next=${encodeURIComponent(route)}` });
    try {
      await until(() => evaluate("document.body.innerText.includes('Alba Demo') && !!document.querySelector('main') && !document.body.innerText.includes('Loading')"), 'demo content');
    } catch (error) {
      console.error(JSON.stringify({ page: await evaluate('document.body.innerText'), browserErrors }, null, 2));
      throw error;
    }
    await evaluate('document.fonts.ready'); await pause(300);
    const text = String(await evaluate('document.body.innerText'));
    assert.ok(text.includes('DEMO1'), 'The console displays the demo order.');
    if (name === 'board') {
      await evaluate("{ const lane = [...document.querySelectorAll('main div')].find(el => el.classList.contains('overflow-x-auto') && el.scrollWidth > el.clientWidth); if (lane) lane.scrollLeft = lane.scrollWidth; }");
      await pause(300);
      for (const tag of ['DEMO1', 'DEMO2', 'DEMO3', 'DEMO4']) assert.equal(await evaluate(`{ const rect = document.querySelector('a[href="/p/demo/orders/${tag}"]')?.getBoundingClientRect(); !!rect && rect.left >= 0 && rect.right <= innerWidth; }`), true, `${tag} is visible in the viewport.`);
    } else {
      assert.ok(!text.includes('Tokens unknown') && !text.includes('Cost unknown'), 'Sample usage and prices are populated.');
    }
    assert.equal(browserErrors.length, 0, 'The built console has no uncaught browser errors.');
    assert.ok(!text.includes(root) && !text.includes(demo.directory), 'No checkout or demo filesystem paths on screen.');
    assert.ok(!/[A-Za-z]:[\\/]|[\\/](?:Users|home)[\\/]/.test(text), 'No absolute paths or usernames on screen.');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'No horizontal overflow.');
    const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const bytes = Buffer.from(screenshot.data, 'base64');
    writeFileSync(path.join(output, `${name}.png`), bytes);
    captures.push({ file: `${name}.png`, route: route!, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  writeFileSync(path.join(output, 'provenance.json'), JSON.stringify({ source: 'examples/demo', scenario: 'Real DEMO1 dispatch plus examples/demo/showcase.ts synthetic running, decision and review records; fictional usage and prices', stages: ['running', 'awaiting-user', 'awaiting-review', 'merged'], method: 'Chromium DevTools Page.captureScreenshot', width: 1440, height: 900, language: 'en', theme: 'dark', generatedImages: 0, captures }, null, 2) + '\n');
  console.log(`Captured ${captures.length} demo console screenshots; no image-generation calls.`);
} finally {
  if (socket?.readyState === WebSocket.OPEN) { socket.send(JSON.stringify({ id: ++sequence, method: 'Browser.close' })); socket.close(); }
  if (browser.exitCode === null) {
    await Promise.race([once(browser, 'exit'), pause(5000)]);
    if (browser.exitCode === null && browser.pid) await stopTreeAsync({ pid: browser.pid, notBefore: before, ownsRoot: true }, 30_000);
  }
  board.server.closeAllConnections(); await new Promise<void>(resolve => board.server.close(() => resolve()));
  closeStateStores();
  assert.ok(path.resolve(demo.directory).startsWith(path.join(root, '.alba/demo') + path.sep));
  removeTreeSync(demo.directory, { onError: console.error });
}
