import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { stringify } from 'yaml';
import type { ProjectConfig } from '../src/config.ts';
import { Orders } from '../src/orders/service.ts';
import { trialAcceptance } from '../src/review/acceptance.ts';
import { encodePng } from '../src/review/sheet.ts';
import { decodePng, type DecodedPng } from '../src/verify/png.ts';
import {
  evaluateTargetRule,
  histogramDistance,
  measureLuminance,
  measureMotion,
  measureSaturation,
  parseTargetSection,
  structureDistance,
} from '../src/verify/target.ts';
import { parseOrderSections } from '../src/verify/verify.ts';
import { tempOrders } from './helpers.ts';
import { testBackend, testStore, validateProject } from './state-helper.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const fakeGame = path.resolve('examples/capture/fake-game.mjs').replace(/\\/g, '/');
const cliMain = path.resolve('src/cli/main.ts');

function withLockDir<T>(lockDir: string, fn: () => T): T {
  const prev = process.env.ALBA_LOCK_DIR;
  process.env.ALBA_LOCK_DIR = lockDir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.ALBA_LOCK_DIR;
    else process.env.ALBA_LOCK_DIR = prev;
  }
}

function makeSeaPng(width: number, height: number): Buffer {
  const rgb = Buffer.alloc(width * height * 3);
  const horizon = Math.floor(height * 0.5);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      if (y < horizon) {
        const sun = x >= Math.floor(width * 0.65) && x < Math.floor(width * 0.85) && y >= Math.floor(height * 0.1) && y < Math.floor(height * 0.32);
        if (sun) {
          rgb[o] = 250;
          rgb[o + 1] = 224;
          rgb[o + 2] = 112;
        } else {
          rgb[o] = 58;
          rgb[o + 1] = 148;
          rgb[o + 2] = 246;
        }
      } else {
        const wave = ((Math.floor(x / Math.max(2, Math.floor(width / 20))) + Math.floor(y / Math.max(2, Math.floor(height / 18)))) % 2) * 28;
        rgb[o] = 16 + Math.floor(wave / 2);
        rgb[o + 1] = 104 + wave;
        rgb[o + 2] = 172 + wave;
      }
    }
  }
  return encodePng(width, height, rgb);
}

function mustDecode(buf: Buffer): DecodedPng {
  const res = decodePng(buf);
  assert.equal(res.status, 'ok');
  return res.image;
}

function desaturatePreservingLuminance(img: DecodedPng, keepChroma = 0.12): DecodedPng {
  const out = Buffer.alloc(img.width * img.height * 3);
  for (let p = 0; p < img.width * img.height; p++) {
    const i = p * img.channels;
    const r = img.pixels[i]!;
    const g = img.pixels[i + 1]!;
    const b = img.pixels[i + 2]!;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const o = p * 3;
    out[o] = Math.max(0, Math.min(255, Math.round(y + keepChroma * (r - y))));
    out[o + 1] = Math.max(0, Math.min(255, Math.round(y + keepChroma * (g - y))));
    out[o + 2] = Math.max(0, Math.min(255, Math.round(y + keepChroma * (b - y))));
  }
  return mustDecode(encodePng(img.width, img.height, out));
}

function shiftHorizontalQuarter(img: DecodedPng): DecodedPng {
  const shift = Math.floor(img.width / 4);
  const out = Buffer.alloc(img.width * img.height * 3);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const srcX = (x + shift) % img.width;
      const s = (y * img.width + srcX) * img.channels;
      const d = (y * img.width + x) * 3;
      out[d] = img.pixels[s]!;
      out[d + 1] = img.pixels[s + 1]!;
      out[d + 2] = img.pixels[s + 2]!;
    }
  }
  return mustDecode(encodePng(img.width, img.height, out));
}

test('parseTargetSection: numbered heading with note, six measured rows, two blocks, unknown line warning and unmeasured', () => {
  const d1Markdown = [
    '# T1: Noon sea look',
    '',
    '## Acceptance',
    '- Noon sea matches the art target.',
    '',
    '## 3. Target (noon sea)',
    '- shot: day',
    '- reference: art/targets/sea-noon.png',
    '- luminance: region 0,0,1,0.5 within 0.06',
    '- luminance: region 0,0.5,1,0.5 between 0.30 and 0.45',
    '- saturation: within 0.08',
    '- histogram: max 0.25',
    '- structure: cells 16x9 max 0.10',
    '- motion: day -> day-later min 3',
    '',
  ].join('\n');

  const parsed = parseTargetSection(d1Markdown);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.blocks.length, 1);
  const block = parsed.blocks[0]!;
  assert.equal(block.shot, 'day');
  assert.equal(block.reference, 'art/targets/sea-noon.png');
  assert.equal(block.unmeasured, undefined);
  assert.equal(block.rows.length, 6);
  assert.deepEqual(
    block.rows.map(r => r.metric),
    ['luminance', 'luminance', 'saturation', 'histogram', 'structure', 'motion'],
  );

  // Evaluate the 6 parsed rows against decoded pictures to confirm 6 measured TargetRow outputs
  const ref = mustDecode(makeSeaPng(160, 90));
  const laterRgb = Buffer.from(ref.pixels);
  for (let i = 0; i < laterRgb.length; i++) laterRgb[i] = Math.min(255, laterRgb[i]! + 12);
  const later = mustDecode(encodePng(160, 90, laterRgb));
  const evaluated = block.rows.map(r =>
    evaluateTargetRule(r, ref, ref, name => (name === 'day-later' ? later : ref)),
  );
  assert.equal(evaluated.length, 6);

  // Two shot: lines give two blocks
  const twoShotMd = [
    '# T2',
    '',
    '## Acceptance',
    '- Day and night match.',
    '',
    '## Target',
    '- shot: day',
    '- reference: art/targets/day.png',
    '- luminance: within 0.05',
    '- shot: night',
    '- reference: art/targets/night.png',
    '- saturation: within 0.08',
    '- histogram: max 0.25',
  ].join('\n');
  const two = parseTargetSection(twoShotMd);
  assert.deepEqual(two.warnings, []);
  assert.equal(two.blocks.length, 2);
  assert.equal(two.blocks[0]!.shot, 'day');
  assert.equal(two.blocks[0]!.rows.length, 1);
  assert.equal(two.blocks[1]!.shot, 'night');
  assert.equal(two.blocks[1]!.rows.length, 2);

  // Unknown line gives warning on both parseTargetSection and parseOrderSections and marks block unmeasured
  const badMd = [
    '# T3',
    '',
    '## Acceptance',
    '- Sea renders.',
    '',
    '## Target',
    '- shot: day',
    '- reference: art/targets/sea-noon.png',
    '- sparkle: ultra 9000',
    '- luminance: within 0.06',
  ].join('\n');
  const bad = parseTargetSection(badMd);
  assert.equal(bad.blocks.length, 1);
  assert.deepEqual(bad.warnings, ['Target line not understood: sparkle: ultra 9000']);
  assert.equal(bad.blocks[0]!.unmeasured, 'Target line not understood: sparkle: ultra 9000');
  assert.ok(parseOrderSections(badMd).warnings.includes('Target line not understood: sparkle: ultra 9000'));

  // Config validation for verify.max_visual_rounds
  const { dir: cfgDir } = tempOrders();
  try {
    const woDir = path.join(cfgDir, 'orders');
    mkdirSync(woDir, { recursive: true });
    const yamlAt = path.join(cfgDir, 'alba.yaml');
    const defCfg = validateProject({ id: 'demo', name: 'Demo', root: cfgDir, work_orders: woDir, state_dir: path.join(cfgDir, 'state') }, yamlAt);
    assert.equal(defCfg.verify.max_visual_rounds, 2);
    const zeroCfg = validateProject(
      { id: 'demo', name: 'Demo', root: cfgDir, work_orders: woDir, state_dir: path.join(cfgDir, 'state'), verify: { max_visual_rounds: 0 } },
      yamlAt,
    );
    assert.equal(zeroCfg.verify.max_visual_rounds, 0);
    assert.throws(() =>
      validateProject(
        { id: 'demo', name: 'Demo', root: cfgDir, work_orders: woDir, state_dir: path.join(cfgDir, 'state'), verify: { max_visual_rounds: -1 } },
        yamlAt,
      ),
    );
    assert.throws(() =>
      validateProject(
        { id: 'demo', name: 'Demo', root: cfgDir, work_orders: woDir, state_dir: path.join(cfgDir, 'state'), verify: { max_visual_rounds: 1.5 } },
        yamlAt,
      ),
    );
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

test('metrics: self is 0, washed-out copy passes luminance and fails histogram and saturation, quarter shift fails structure, cross-size works, self-motion is 0', () => {
  const ref = mustDecode(makeSeaPng(160, 90));

  // 1. Self against self gives 0 for histogram, structure, and motion
  assert.equal(histogramDistance(ref, ref), 0);
  assert.equal(structureDistance(ref, ref, 16, 9), 0);
  assert.equal(measureMotion(ref, ref), 0);

  // 2. Desaturated copy with same mean luminance passes luminance (within 0.06) and fails saturation (within 0.08) and histogram (max 0.25)
  const washed = desaturatePreservingLuminance(ref, 0.12);
  const refLum = measureLuminance(ref);
  const washedLum = measureLuminance(washed);
  const refSat = measureSaturation(ref);
  const washedSat = measureSaturation(washed);
  const washedHist = histogramDistance(ref, washed);

  assert.ok(Math.abs(washedLum - refLum) < 0.005, `luminance stays matched: ${washedLum} vs ${refLum}`);
  assert.ok(Math.abs(washedSat - refSat) > 0.4, `saturation drops sharply: ${washedSat} vs ${refSat}`);
  assert.ok(washedHist > 0.8, `histogram catches washed-out colours: ${washedHist}`);

  const washedRules = parseTargetSection([
    '## Target',
    '- shot: day',
    '- reference: art/targets/sea.png',
    '- luminance: within 0.06',
    '- saturation: within 0.08',
    '- histogram: max 0.25',
  ].join('\n')).blocks[0]!.rows;
  const [lumRow, satRow, histRow] = washedRules.map(r => evaluateTargetRule(r, washed, ref));
  assert.equal(lumRow!.pass, true);
  assert.equal(satRow!.pass, false);
  assert.equal(histRow!.pass, false);

  // 3. Copy shifted horizontally by a quarter of its width fails structure (cells 16x9 max 0.10)
  const asymmetricalRgb = Buffer.alloc(160 * 90 * 3);
  for (let y = 0; y < 90; y++) {
    for (let x = 0; x < 160; x++) {
      const o = (y * 160 + x) * 3;
      const bright = x < 80 ? 230 : 25;
      asymmetricalRgb[o] = bright;
      asymmetricalRgb[o + 1] = bright;
      asymmetricalRgb[o + 2] = bright;
    }
  }
  const baseStruct = mustDecode(encodePng(160, 90, asymmetricalRgb));
  const shifted = shiftHorizontalQuarter(baseStruct);
  const structDist = structureDistance(baseStruct, shifted, 16, 9);
  assert.ok(structDist > 0.3, `quarter-width shift produces large structure distance: ${structDist}`);
  const structRule = parseTargetSection('## Target\n- shot: day\n- reference: art/a.png\n- structure: cells 16x9 max 0.10\n').blocks[0]!.rows[0]!;
  assert.equal(evaluateTargetRule(structRule, shifted, baseStruct).pass, false);

  // 4. Reference of another size than the capture is measured without error
  const refSmall = mustDecode(makeSeaPng(80, 45));
  const capLarge = mustDecode(makeSeaPng(320, 180));
  const crossRules = parseTargetSection([
    '## Target',
    '- shot: day',
    '- reference: art/targets/sea.png',
    '- luminance: region 0,0,1,0.5 within 0.06',
    '- saturation: within 0.08',
    '- histogram: max 0.25',
    '- structure: cells 16x9 max 0.10',
  ].join('\n')).blocks[0]!.rows;
  for (const r of crossRules) {
    const res = evaluateTargetRule(r, capLarge, refSmall);
    assert.equal(res.pass, true, `${r.metric} (${res.label}) passes across sizes: value=${res.value}`);
  }
});

function makeRepoFixture(t: TestContext) {
  const { dir } = tempOrders();
  const root = path.join(dir, 'repo');
  const worktree = path.join(dir, 'wt-t1');
  const workOrders = path.join(dir, 'orders');
  const stateDir = path.join(dir, 'state');
  const lockDir = path.join(dir, 'locks');
  mkdirSync(path.join(root, 'art', 'targets'), { recursive: true });
  mkdirSync(workOrders, { recursive: true });
  mkdirSync(lockDir, { recursive: true });

  // Render reference day.png with fake-game onto the base commit so base commit owns the exact target PNG.
  const refPng = path.join(root, 'art', 'targets', 'day-ref.png');
  const gen = spawnSync(process.execPath, [fakeGame, '--out', refPng, '--scene', 'day', '--size', '320x180'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(gen.status, 0, gen.stderr);

  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'core.autocrlf', 'false');
  writeFileSync(path.join(root, 'scene.txt'), 'day\n', 'utf8');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base with day reference');

  git(root, 'worktree', 'add', '-qb', 'branch-t1', worktree, 'main');
  writeFileSync(path.join(worktree, 'scene.txt'), 'delivery-v1\n', 'utf8');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-qm', 'delivery');
  const head = git(worktree, 'rev-parse', 'HEAD');

  t.after(() => {
    try { git(root, 'worktree', 'remove', '--force', worktree); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir, root, worktree, workOrders, stateDir, lockDir, head };
}

test('target step & CLI: matching capture passes with 3-panel sheet, different scene misses, missing shot / worktree-only ref / no recipe are unmeasured, CLI exits 0/1/2 + --json', t => {
  const f = makeRepoFixture(t);
  const yamlFile = path.join(f.dir, 'alba.yaml');

  const writeConfig = (extra: Record<string, unknown>): ProjectConfig => {
    const raw: Record<string, unknown> = {
      id: 'demo',
      name: 'Demo',
      root: f.root,
      work_orders: f.workOrders,
      state_dir: f.stateDir,
      state: { backend: testBackend() },
      dispatch: { base_ref: 'main', worktree_parent: f.dir },
      accept: { steps: [] },
      ...extra,
    };
    writeFileSync(yamlFile, stringify(raw), 'utf8');
    return validateProject(raw, yamlFile);
  };

  const orders = new Orders(testStore(f.stateDir));
  orders.add({ tag: 'T1', title: 'Noon lighting', kind: 'visual', branch: 'branch-t1', worktree: f.worktree });
  orders.runStart('T1', { worker: 'w1' });
  orders.runEnd('T1', 'completed');
  orders.report('T1', { status: 'ready', summary: 'Ready', evidence: [], commits: [f.head] });

  const targetOrderBody = (refPath: string, shotName = 'day') =>
    [
      '# T1: Noon lighting',
      '',
      '## Acceptance',
      '- Matches reference.',
      '',
      '## Target',
      `- shot: ${shotName}`,
      `- reference: ${refPath}`,
      '- luminance: region 0,0,1,0.5 within 0.06',
      '- saturation: within 0.08',
      '- histogram: max 0.25',
      '- structure: cells 16x9 max 0.10',
      '',
    ].join('\n');

  const runCli = (...args: string[]) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cliMain, '--project', yamlFile, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, ALBA_LOCK_DIR: f.lockDir },
    });

  // 1. Capture matching the reference passes; side-by-side sheet decodes with width of 3 panels; CLI exits 0 and --json
  writeFileSync(path.join(f.workOrders, 'T1.md'), targetOrderBody('art/targets/day-ref.png'), 'utf8');
  const passProject = writeConfig({
    capture: {
      recipes: [{
        name: 'demo',
        kinds: ['visual'],
        launch: [process.execPath, fakeGame, '--out', '{out}', '--size', '320x180'],
        shots: [{ name: 'day', args: ['--scene', 'day'] }],
      }],
    },
  });

  const passTrial = withLockDir(f.lockDir, () => trialAcceptance(passProject, orders, 'T1', true));
  assert.equal(passTrial.status, 'passed', passTrial.reason);
  const passStep = passTrial.steps.find(s => s.name === 'target');
  assert.ok(passStep?.target);
  assert.equal(passStep.status, 'passed');
  assert.equal(passStep.target[0]!.pass, true);
  assert.equal(passStep.target[0]!.unmeasured, undefined);
  assert.equal(passStep.target[0]!.round, 1);
  assert.equal(existsSync(passStep.target[0]!.sheet), true);

  const decodedSheet = mustDecode(readFileSync(passStep.target[0]!.sheet));
  assert.equal(decodedSheet.width, 3 * 320 + 4 * 8, 'sheet has the exact width of three 320px panels plus four 8px gaps');

  const cliPass = runCli('review', 'T1', 'target');
  assert.equal(cliPass.status, 0, cliPass.stderr);
  assert.match(cliPass.stdout, /T1 target: PASSED/);

  const cliPassJson = runCli('review', 'T1', 'target', '--json');
  assert.equal(cliPassJson.status, 0, cliPassJson.stderr);
  const parsedJson = JSON.parse(cliPassJson.stdout) as { status: string; exitCode: number; sheets: string[]; history: unknown[] };
  assert.equal(parsedJson.status, 'passed');
  assert.equal(parsedJson.exitCode, 0);
  assert.equal(parsedJson.sheets.length, 1);
  assert.equal(parsedJson.history.length, 1);

  // 2. Different scene ('night' captured against 'day' reference) misses with the row named; CLI exits 1
  const missProject = writeConfig({
    capture: {
      recipes: [{
        name: 'demo',
        kinds: ['visual'],
        launch: [process.execPath, fakeGame, '--out', '{out}', '--size', '320x180'],
        shots: [{ name: 'day', args: ['--scene', 'night'] }],
      }],
    },
  });
  const missTrial = withLockDir(f.lockDir, () => trialAcceptance(missProject, orders, 'T1', true));
  assert.equal(missTrial.status, 'failed');
  assert.match(missTrial.reason ?? '', /top half mean luminance/);
  const missStep = missTrial.steps.find(s => s.name === 'target')!;
  assert.equal(missStep.status, 'failed');
  assert.equal(missStep.target![0]!.unmeasured, undefined);
  assert.equal(missStep.target![0]!.pass, false);
  assert.equal(missStep.target![0]!.rows.some(r => !r.pass && r.label === 'top half mean luminance'), true);

  const cliMiss = runCli('review', 'T1', 'target');
  assert.equal(cliMiss.status, 1);
  assert.match(cliMiss.stdout, /T1 target: MISSED/);

  // 3. Missing shot in manifest -> unmeasured with that reason; CLI exits 2
  writeFileSync(path.join(f.workOrders, 'T1.md'), targetOrderBody('art/targets/day-ref.png', 'sunset'), 'utf8');
  const missingShotTrial = withLockDir(f.lockDir, () => trialAcceptance(passProject, orders, 'T1', true));
  assert.equal(missingShotTrial.status, 'failed');
  const missingShotTarget = missingShotTrial.steps.find(s => s.name === 'target')!.target![0]!;
  assert.match(missingShotTarget.unmeasured ?? '', /shot "sunset" is missing from capture manifest/);

  const cliUnmeasured = runCli('review', 'T1', 'target', '--json');
  assert.equal(cliUnmeasured.status, 2);
  assert.equal((JSON.parse(cliUnmeasured.stdout) as { status: string; exitCode: number }).status, 'unmeasured');

  // 4. Reference only in the worktree (not on the base commit) -> unmeasured with that reason
  const wtOnlyRel = 'art/targets/worktree-only.png';
  mkdirSync(path.join(f.worktree, 'art', 'targets'), { recursive: true });
  writeFileSync(path.join(f.worktree, wtOnlyRel), readFileSync(path.join(f.root, 'art', 'targets', 'day-ref.png')));
  git(f.worktree, 'add', wtOnlyRel);
  git(f.worktree, 'commit', '-qm', 'worker adds its own target png');
  const head2 = git(f.worktree, 'rev-parse', 'HEAD');
  orders.runStart('T1', { worker: 'w1' });
  orders.runEnd('T1', 'completed');
  orders.report('T1', { status: 'ready', summary: 'Moved target', evidence: [], commits: [head2] });

  writeFileSync(path.join(f.workOrders, 'T1.md'), targetOrderBody(wtOnlyRel, 'day'), 'utf8');
  const wtRefTrial = withLockDir(f.lockDir, () => trialAcceptance(passProject, orders, 'T1', true));
  assert.equal(wtRefTrial.status, 'failed');
  const wtRefTarget = wtRefTrial.steps.find(s => s.name === 'target')!.target![0]!;
  assert.match(wtRefTarget.unmeasured ?? '', /reference "art\/targets\/worktree-only\.png" is absent on base commit/);

  // 5. Project without a capture recipe -> unmeasured with that reason
  writeFileSync(path.join(f.workOrders, 'T1.md'), targetOrderBody('art/targets/day-ref.png', 'day'), 'utf8');
  const noRecipeProject = writeConfig({});
  const noRecipeTrial = withLockDir(f.lockDir, () => trialAcceptance(noRecipeProject, orders, 'T1', true));
  assert.equal(noRecipeTrial.status, 'failed');
  const noRecipeTarget = noRecipeTrial.steps.find(s => s.name === 'target')!.target![0]!;
  assert.match(noRecipeTarget.unmeasured ?? '', /no capture recipe matched order T1/);
});

test('UI: TargetPanel inside AcceptanceCard renders missed rows in red, trends, sheet viewer and Not converging banner', async () => {
  const uiReq = createRequire(path.resolve('ui/package.json'));
  const { createServer } = uiReq('vite') as {
    createServer: (cfg: Record<string, unknown>) => Promise<{
      ssrLoadModule: (id: string) => Promise<Record<string, unknown>>;
      close: () => Promise<void>;
    }>;
  };
  const vite = await createServer({
    root: path.resolve('ui'),
    logLevel: 'silent',
    server: { middlewareMode: true, ws: false },
    appType: 'custom',
  });

  try {
    const React = uiReq('react') as { createElement: (type: unknown, props: unknown, ...children: unknown[]) => unknown };
    const { renderToStaticMarkup } = uiReq('react-dom/server') as { renderToStaticMarkup: (el: unknown) => string };
    const rqPkgPath = uiReq.resolve('@tanstack/react-query/package.json');
    const rqPkg = JSON.parse(readFileSync(rqPkgPath, 'utf8')) as { module?: string; exports?: { '.'?: { import?: string | { default?: string } } } };
    const rqImport = typeof rqPkg.exports?.['.']?.import === 'string'
      ? rqPkg.exports['.'].import
      : rqPkg.exports?.['.']?.import?.default ?? rqPkg.module ?? 'build/modern/index.js';
    const { QueryClient, QueryClientProvider } = (await import(
      pathToFileURL(path.resolve(path.dirname(rqPkgPath), rqImport)).href
    )) as {
      QueryClient: new () => unknown;
      QueryClientProvider: unknown;
    };
    const { AcceptanceCard } = (await vite.ssrLoadModule('/src/components/AcceptanceCard.tsx')) as {
      AcceptanceCard: (props: Record<string, unknown>) => unknown;
    };
    const { setLang } = (await vite.ssrLoadModule('/src/i18n/index.ts')) as { setLang: (l: 'en' | 'zh') => void };

    const card = {
      tag: 'T1',
      title: 'Sea lighting',
      href: '/p/demo/orders/T1#acceptance',
      lint: [{ name: 'report_required', ok: true, detail: 'ok' }],
      changed: ['src/shader.hlsl'],
      images: [],
      trial: {
        id: 'trial-1',
        fingerprint: 'fp',
        report: 3,
        base: '0123456789ab',
        branch: 'abcdef123456',
        at: '2026-11-17T08:00:00Z',
        status: 'failed',
        reason: 'Step target failed: missed target',
        changed: ['src/shader.hlsl'],
        conflicts: [],
        steps: [
          {
            name: 'target',
            status: 'failed',
            duration_ms: 42,
            code: 1,
            tail: [
              'Not converging after 3 rounds:',
              '  round 1  report #1  rev 111111111111  MISS  day:top half mean luminance=0.310(MISS)',
              '  round 2  report #2  rev 222222222222  MISS [flat]  day:top half mean luminance=0.312(MISS,flat)',
              '  round 3  report #3  rev abcdef123456  MISS [stalled]  day:top half mean luminance=0.311(MISS,flat)',
              '',
              'T1 shot day (round 3)  MISS  [stalled]',
            ].join('\n'),
            target: [
              {
                shot: 'day',
                reference: 'art/targets/sea-noon.png',
                revision: 'abcdef1234567890',
                round: 3,
                pass: false,
                trend: 'stalled',
                stalled: true,
                sheet: '/state/acceptance/logs-trial-1/target/day.png',
                rows: [
                  {
                    metric: 'luminance',
                    label: 'top half mean luminance',
                    value: 0.311,
                    reference: 0.55,
                    bound: 'within 0.06',
                    pass: false,
                    trend: 'flat',
                  },
                  {
                    metric: 'saturation',
                    label: 'mean saturation',
                    value: 0.42,
                    reference: 0.41,
                    bound: 'within 0.08',
                    pass: true,
                    trend: 'closer',
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    const render = (lang: 'en' | 'zh') => {
      setLang(lang);
      return renderToStaticMarkup(
        React.createElement(
          QueryClientProvider as never,
          { client: new QueryClient() } as never,
          React.createElement(AcceptanceCard as never, { project: 'demo', card, canApprove: true } as never),
        ),
      );
    };

    const enHtml = render('en');
    assert.match(enHtml, /data-testid="target-panel"/);
    assert.match(enHtml, /data-status="miss"[^>]*class="[^"]*bg-destructive\/10 text-destructive"/);
    assert.match(enHtml, /top half mean luminance/);
    assert.match(enHtml, /0\.311/);
    assert.match(enHtml, /MISS/);
    assert.match(enHtml, /Not converging after 3 rounds:/);
    assert.match(enHtml, /stalled/);
    assert.match(enHtml, /day\.png/);
    assert.match(enHtml, /Open at 100%/);

    const zhHtml = render('zh');
    assert.match(zhHtml, /data-status="miss"/);
    assert.match(zhHtml, /0\.311/);
    setLang('en');
  } finally {
    await vite.close();
  }
});
