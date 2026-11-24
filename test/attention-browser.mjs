/** Run after building the UI, with ALBA_BROWSER pointing at a local Chromium executable. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DevTools, until } from './browser-devtools.mjs';
import { fixture } from './api-fixture.ts';

test('board submits answers, polls only an open Peek, and recovers a failed section', async () => {
  assert.ok(process.env.ALBA_BROWSER, 'Set ALBA_BROWSER to a Chromium executable.');
  const f = await fixture({ signIn: false, uiDir: path.resolve('ui/dist'), now: () => new Date('2026-01-01T12:00:00Z') });
  const live = f.orders.get('W1');
  live.runs[0].log = path.join(f.dir, 'demo.log');
  writeFileSync(live.runs[0].log, Array.from({ length: 250 }, (_, i) => 'line ' + i).join('\n') + '\n');
  f.orders.store.write(live);
  const profile = path.join(f.dir, 'browser');
  const browser = spawn(process.env.ALBA_BROWSER, ['--headless=new', '--no-first-run', '--disable-gpu', '--disable-background-networking',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const cdp = new DevTools();
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    await until(() => existsSync(portFile), 'browser debugger');
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    await cdp.connect(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
    await cdp.call('Page.enable');
    await cdp.call('Runtime.enable');
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.peekTimers = new Map();
      const interval = window.setInterval, clear = window.clearInterval;
      window.setInterval = (fn, ms, ...args) => {
        if (ms !== 5000) return interval(fn, ms, ...args);
        const id = interval(() => {}, 600000);
        peekTimers.set(id, fn);
        return id;
      };
      window.clearInterval = id => { peekTimers.delete(id); clear(id); };
      window.logReads = 0;
      const read = window.fetch;
      window.fetch = async (url, init) => {
        if (String(url).includes('/log?') && String(url).includes('tail=200')) logReads++;
        const response = await read(url, init);
        if (sessionStorage.getItem('break-overview') && String(url).includes('/overview')) {
          const data = await response.json(); data.mergesPerDay = null; return Response.json(data);
        }
        return response;
      };
    ` });
    const navigate = route => cdp.call('Page.navigate', { url: f.base + route });
    const waitFor = (expression, name) => until(() => cdp.js(expression), name);
    const button = (root, label) => cdp.js(`[...${root}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
    await navigate('/p/demo/board');
    await waitFor("document.body.innerText.includes('Which tileset first?')", 'card question');
    await button("document", 'Answer');
    await waitFor("!!document.querySelector('[role=dialog] textarea')", 'answer form');
    await cdp.js(`{const a=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(a,'Warm palette');a.dispatchEvent(new Event('input',{bubbles:true}));}`);
    await button("document.querySelector('[role=dialog]')", 'Answer');
    await waitFor("document.body.innerText.includes('Confirm: Answer')", 'answer confirmation');
    await button('document', 'Confirm: Answer');
    await until(() => f.orders.get('Q1').actions.at(-1)?.note === 'Warm palette', 'persisted answer');
    await waitFor("!document.querySelector('[role=dialog]')", 'answer closed');
    await button("[...document.querySelectorAll('article')].find(a => a.textContent.includes('W1'))", 'Peek');
    await waitFor("document.querySelector('[role=dialog] pre')?.textContent.includes('line 249')", 'log loaded');
    assert.equal(await cdp.js("document.querySelector('[role=dialog] pre').textContent.split('\\n').length"), 200);
    const reads = await cdp.js('logReads');
    await cdp.js('for (const fn of peekTimers.values()) fn()');
    await waitFor(`logReads > ${reads}`, 'log refreshed');
    await cdp.js("document.querySelector('[role=dialog] [aria-label=Close]').click()");
    const closed = await cdp.js('logReads');
    await cdp.js('for (const fn of peekTimers.values()) fn()');
    assert.equal(await cdp.js('logReads'), closed);
    await cdp.js("sessionStorage.setItem('break-overview','yes')");
    await navigate('/p/demo');
    await waitFor("document.body.innerText.includes('Retry')", 'recoverable section');
    assert.ok(await cdp.js("document.body.innerText.includes('Live work')"));
    await cdp.js("sessionStorage.removeItem('break-overview')");
    await button('document', 'Retry');
    await waitFor("!document.body.innerText.includes('Retry') && document.body.innerText.includes('Live work')", 'section restored');
  } finally {
    cdp.socket?.close();
    browser.kill();
  }
});
