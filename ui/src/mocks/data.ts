// Made-up data for `pnpm dev:mock` (a neutral demo project; nothing here comes from a real project).
import type {
  CheckResult, Decision, DecisionEntry, DiffFile, Lesson, OrderAction, OrderDefinition, OrderEvent, MonitorView, OrderSpend, Overview, ProgressView, ProjectInfo, ResourceView, QuotaPoint, Quote, Question, Report, Run, Stage, WaitingFor, Worker,
} from '@api';
import { mockDecisions, mockLessons } from './extra-data.ts';
import { hasLibrary, pendingPicks } from './library-data.ts';

export interface MockOrder {
  def: OrderDefinition;
  stage: Stage;
  why: string;
  runs: Run[];
  reports: Report[];
  decisions: Decision[];
  lastCheck?: CheckResult;
  spend?: OrderSpend;
  file?: string;
  quietMinutes?: number;
  openCommand?: string;
  waitingFor?: WaitingFor;
  monitor?: MonitorView;
  progress?: ProgressView;
  uses?: string[];
  questions?: Question[];
  quotes?: Quote[];
  diff?: { base: string; head: string; commits: { hash: string; subject: string; at: string }[]; files: DiffFile[] };
}

export interface MockProject {
  info: Omit<ProjectInfo, 'orderCount' | 'stages'>;
  orders: Map<string, MockOrder>;
  events: OrderEvent[];
  decisions: DecisionEntry[];
  lessons: Lesson[];
}

const MIN = 60_000;
export const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const ACTIONS: Record<Stage, OrderAction[]> = {
  cancelled: [], merged: [], held: ['run', 'release', 'cancel'], 'awaiting-user': ['answer', 'cancel', 'hold'],
  'awaiting-review': ['approve', 'rework', 'cancel'], blocked: ['rework', 'queue', 'cancel'], failed: ['rework', 'queue', 'cancel'],
  dropped: ['queue', 'cancel'], running: ['stop', 'hold', 'cancel'], monitoring: ['hold', 'cancel'], idle: ['queue', 'hold', 'cancel'],
  'waiting-needs': ['hold', 'cancel'], queued: ['run', 'hold', 'cancel'], planned: ['cancel'], draft: ['queue', 'cancel'],
};
/** What the server allows: `answer` only when the order waits for an answer, not for a click on a card. */
export const actionsFor = (s: Stage, waitingFor?: WaitingFor) => (s === 'awaiting-user' && waitingFor === 'card' ? ACTIONS[s].filter(a => a !== 'answer') : ACTIONS[s]);

const WHY: Record<Stage, string> = {
  cancelled: 'the last action is cancel', merged: 'approved and not sent back', held: 'hold without a later release',
  'awaiting-user': 'the current report is waiting and has a question', 'awaiting-review': 'the current report is ready',
  blocked: 'the current report is blocked', failed: 'the current report is failed', dropped: 'the current report is dropped',
  running: 'a run is open', monitoring: 'the current report is monitoring and no run is open', idle: 'the last run ended and nothing is queued', 'waiting-needs': 'queued, but a needed order is not merged',
  queued: 'queued and ready', planned: 'waiting for producer drafting', draft: 'no action, run or report yet',
};
export const whyFor = (s: Stage) => WHY[s];

function def(tag: string, title: string, kind: string, o: Partial<OrderDefinition> = {}): OrderDefinition {
  return { tag, title, kind, needs: [], created: iso(3 * 86400_000), updated: iso(2 * 3600_000), ...o };
}

function run(tag: string, n: number, worker: string, startedAgo: number, endedAgo: number | undefined, extra: Partial<Run> = {}): Run {
  return {
    id: `r${n}`, key: `${tag}:r${n}`, seq: n * 2, worker, started: iso(startedAgo), ended: endedAgo === undefined ? undefined : iso(endedAgo),
    outcome: endedAgo === undefined ? undefined : 'completed', imported: false, hasLog: true, usage: { source: 'unknown' }, ...extra,
  };
}

function report(seq: number, status: Report['status'], summary: string, agoMs: number, extra: Partial<Report> = {}): Report {
  return { seq, at: iso(agoMs), status, summary, evidence: [], commits: [], ...extra };
}

function ev(project: MockProject, tag: string, type: string, by: string, agoMs: number, data?: Record<string, unknown>) {
  project.events.push({ id: project.events.length + 1, at: iso(agoMs), tag, type, by, data });
}

const FILE_A = `# Pause menu

Adds a pause menu to the platformer. The menu opens with Escape, freezes the simulation and shows Resume / Options / Quit.

## Done when
- Escape toggles the menu in every level
- the simulation does not advance while it is open
- the check passes
`;

const PATCH_PAUSE = `diff --git a/src/ui/pause_menu.ts b/src/ui/pause_menu.ts
new file mode 100644
index 0000000..3b1c2a4
--- /dev/null
+++ b/src/ui/pause_menu.ts
@@ -0,0 +1,24 @@
+import { Game } from '../game';
+
+export class PauseMenu {
+  private open = false;
+
+  constructor(private game: Game) {}
+
+  toggle() {
+    this.open = !this.open;
+    this.game.setPaused(this.open);
+  }
+
+  get isOpen() {
+    return this.open;
+  }
+
+  items() {
+    return ['Resume', 'Options', 'Quit'];
+  }
+
+  render(ctx: CanvasRenderingContext2D) {
+    if (!this.open) return;
+    ctx.fillStyle = 'rgba(0,0,0,0.6)';
+    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
+  }
+}
`;
const PATCH_GAME = `diff --git a/src/game.ts b/src/game.ts
index 91c4e0d..5a77f21 100644
--- a/src/game.ts
+++ b/src/game.ts
@@ -10,13 +10,21 @@ export class Game {
   private last = 0;
   private paused = false;

+  setPaused(value: boolean) {
+    this.paused = value;
+    this.audio.setMuffled(value);
+  }
+
   tick(now: number) {
-    const dt = now - this.last;
-    this.last = now;
-    this.world.step(dt);
+    const dt = now - this.last;
+    this.last = now;
+    if (!this.paused) {
+      this.world.step(dt);
+    }
     this.render();
   }

   render() {
     this.renderer.draw(this.world);
+    this.pauseMenu.render(this.ctx);
   }
 }
`;
const PATCH_INPUT = `diff --git a/src/input.ts b/src/input.ts
index c0ffee1..d00d1e2 100644
--- a/src/input.ts
+++ b/src/input.ts
@@ -4,7 +4,10 @@ export function bindKeys(game: Game) {
   window.addEventListener('keydown', (e) => {
     if (e.key === 'ArrowLeft') game.player.left();
     if (e.key === 'ArrowRight') game.player.right();
-    if (e.key === 'Escape') game.quit();
+    if (e.key === 'Escape') game.pauseMenu.toggle();
   });
 }
`;

function worlds(): MockProject[] {
  const a: MockProject = {
    info: { id: 'demo-platformer', name: 'Demo Platformer', design: { enabled: true }, hasWorkers: true, workOrdersDir: 'work-orders', tableWriteBack: true, checks: true, library: { picks: true, art: true, credits: true, usage: true } },
    orders: new Map(),
    events: [],
    decisions: mockDecisions(),
    lessons: mockLessons(),
  };
  const add = (o: MockOrder) => a.orders.set(o.def.tag, o);

  add({
    def: def('MV3', 'Player movement: coyote time and jump buffering', 'gameplay', { worker: 'codex', branch: 'order/mv3', base_ref: 'main', updated: iso(30 * 86400_000 / 30) }),
    stage: 'merged', why: WHY.merged, runs: [run('MV3', 1, 'codex', 5 * 86400_000, 5 * 86400_000 - 50 * MIN, { usage: { source: 'codex-log', total_tokens: 412_800, cost_usd: 1.62, cost_estimated: true } })],
    reports: [report(3, 'ready', 'Coyote time and jump buffering in, tuned to 6 frames', 5 * 86400_000 - 51 * MIN, { commits: ['a41be02'] })], decisions: [{ seq: 4, at: iso(4.9 * 86400_000), kind: 'approve' }],
    spend: { total_tokens: 412_800, cost_usd: 1.62, estimated: true, runs_with_usage: 1, runs_unknown: 0, over_cap: false },
  });
  add({
    def: def('TR2', 'Tilemap: vary the grass tiles', 'art', { worker: 'codex', tags: ['art', 'ui'], needs: ['MV3'], branch: 'order/tr2', base_ref: 'main', mandate: { quote: 'The ground looks too repetitive, vary it.', spend_cap: 5, protected_paths: ['assets/shared/'] } }),
    stage: 'awaiting-review', why: WHY['awaiting-review'], file: FILE_A.replace('Pause menu', 'Tilemap variation'),
    runs: [
      run('TR2', 1, 'codex', 7 * 3600_000, 6 * 3600_000, { outcome: 'completed', usage: { source: 'codex-log', total_tokens: 622_400, input_tokens: 540_000, output_tokens: 82_400, cached_tokens: 310_000, turns: 18, cost_usd: 2.31, cost_estimated: true } }),
      run('TR2', 2, 'codex', 5 * 3600_000, 3.2 * 3600_000, { note: 'Tiles still repeat visibly in the second level, vary the grass.', usage: { source: 'codex-log', total_tokens: 701_000, input_tokens: 610_000, output_tokens: 91_000, turns: 21, cost_usd: 2.64, cost_estimated: true } }),
    ],
    reports: [
      report(3, 'ready', 'Grass tiles vary by hash of the cell; first level only', 6 * 3600_000, { run: 'r1', commits: ['7c01d3a'] }),
      report(6, 'ready', 'Grass and dirt tiles now vary in all levels; added a seed option', 3.2 * 3600_000, { run: 'r2', evidence: ['docs/tilemap-variation.md', 'shots/level2.png'], commits: ['7c01d3a', 'e9b24f0', '04ac7d9'] }),
    ],
    decisions: [{ seq: 5, at: iso(5.1 * 3600_000), kind: 'rework', note: 'Tiles still repeat visibly in the second level, vary the grass.' }],
    spend: { total_tokens: 1_323_400, cost_usd: 4.95, estimated: true, runs_with_usage: 2, runs_unknown: 0, cap_usd: 5, over_cap: false },
    lastCheck: {
      tag: 'TR2', at: iso(3 * 3600_000), ok: false, base: 'main', worktree: '../worktrees/tr2',
      general: [
        { name: 'branch is ahead of base', ok: true, detail: '3 commits' },
        { name: 'work tree is clean', ok: true, detail: 'no uncommitted files' },
        { name: 'protected paths untouched', ok: true, detail: 'assets/shared/ not changed' },
        { name: 'evidence files exist', ok: false, detail: 'shots/level2.png is missing from the branch' },
      ],
      results: ['results/tr2-metrics.json'],
      refs: {
        same: 14,
        other: [
          { name: 'tiles.unique_variants', status: 'different', reference: '6', got: '9', from: 'reference-values.yaml', why: 'more variants than planned' },
          { name: 'tiles.repeat_run_max', status: 'different', reference: '3', got: '5', from: 'reference-values.yaml' },
          { name: 'tiles.seed', status: 'new', got: '1337' },
          { name: 'tiles.dirt_variants', status: 'missing', reference: '4' },
        ],
      },
    },
    diff: {
      base: 'main', head: 'order/tr2',
      commits: [
        { hash: '04ac7d9', subject: 'Vary dirt tiles too, add seed option', at: iso(3.3 * 3600_000) },
        { hash: 'e9b24f0', subject: 'Apply variation in every level', at: iso(4 * 3600_000) },
        { hash: '7c01d3a', subject: 'Vary grass tiles by cell hash', at: iso(6.1 * 3600_000) },
      ],
      files: [
        { path: 'src/ui/pause_menu.ts', status: 'added', insertions: 24, deletions: 0, binary: false, patch: PATCH_PAUSE, truncated: false },
        { path: 'src/game.ts', status: 'modified', insertions: 11, deletions: 4, binary: false, patch: PATCH_GAME, truncated: false },
        { path: 'src/input.ts', status: 'modified', insertions: 1, deletions: 1, binary: false, patch: PATCH_INPUT, truncated: false },
        { path: 'assets/tiles/grass_b.png', status: 'added', insertions: 0, deletions: 0, binary: true, truncated: false },
        { path: 'assets/tiles/grass_c.png', status: 'added', insertions: 0, deletions: 0, binary: true, truncated: false },
      ],
    },
  });
  add({
    def: def('AU1', 'Audio: footstep sounds by surface', 'audio', { worker: 'opencode', tags: ['audio'], mandate: { decisions: 'DEC104', quote: 'Footsteps should change with the ground.' } }),
    stage: 'awaiting-review', why: WHY['awaiting-review'], quietMinutes: undefined,
    runs: [run('AU1', 1, 'opencode', 20 * 3600_000, 19 * 3600_000, { usage: { source: 'opencode-json', total_tokens: 220_000, cost_usd: 0.41 } })],
    reports: [report(3, 'ready', 'Footsteps for grass, stone and wood, pitch varies per step', 19 * 3600_000, { commits: ['b8820ce'], evidence: ['docs/footsteps.md'] })], decisions: [],
    spend: { total_tokens: 220_000, cost_usd: 0.41, estimated: false, runs_with_usage: 1, runs_unknown: 0, over_cap: false, credits: { credits: { approved: 200, spent: 120, pending: 0 } } },
    quotes: [{
      id: 'Q1', project: 'demo-platformer', tag: 'AU1', service: 'sound generation', unit: 'credits', unitPrice: 2, quantity: 90, total: 180, capRequested: 200,
      created: iso(22 * 3600_000), by: 'executor', status: 'approved', approval: { cap: 200, note: 'ok, but no more', by: 'web', at: iso(21.5 * 3600_000) }, spent: 120, remaining: 80,
      ledger: [{ at: iso(20.5 * 3600_000), amount: 80, what: 'grass, stone steps', by: 'executor' }, { at: iso(19.5 * 3600_000), amount: 40, what: 'wood steps', by: 'executor' }],
    }],
    questions: [{
      id: 'QA1', text: 'Should the footsteps stay on while the player is in the air?', askedBy: 'reviewer', at: iso(18 * 3600_000),
      options: [
        { key: '1', label: 'Only on the ground', note: 'Matches the surface under the feet', images: [], recommended: true },
        { key: '2', label: 'Soft whoosh in the air', images: [], recommended: false },
      ],
    }],
    diff: {
      base: 'main', head: 'order/au1', commits: [{ hash: 'b8820ce', subject: 'Footsteps by surface', at: iso(19 * 3600_000) }],
      files: [{ path: 'src/input.ts', status: 'modified', insertions: 1, deletions: 1, binary: false, patch: PATCH_INPUT, truncated: false }],
    },
  });
  add({
    def: def('TS1', 'Pause menu', 'ui', { worker: 'codex', needs: ['MV3'], mandate: { quote: 'Add a pause menu.' } }),
    stage: 'awaiting-user', why: WHY['awaiting-user'], file: FILE_A,
    runs: [run('TS1', 1, 'codex', 4 * 3600_000, 3.5 * 3600_000, { session: 'sess-5c1d', usage: { source: 'codex-log', total_tokens: 188_000, cost_usd: 0.7, cost_estimated: true } })],
    reports: [report(3, 'waiting', 'The menu is drawn and freezes the world; one thing is not decided', 3.5 * 3600_000, { run: 'r1', question: 'When the menu is open, should the music keep playing at low volume, or stop completely?' })], decisions: [],
  });
  add({
    def: def('SV2', 'Save slot screen layout', 'ui', { worker: 'claude-card', tags: ['ui'] }),
    stage: 'awaiting-user', why: 'the current report is waiting for a click on a card', waitingFor: 'card',
    runs: [run('SV2', 1, 'claude-card', 3 * 3600_000, 2.9 * 3600_000, { hasLog: false })],
    reports: [report(3, 'waiting', 'The card for the save slot screen is ready: open it in a session and click through the three steps', 2.9 * 3600_000, { waitingFor: 'card' })], decisions: [],
  });
  add({
    def: def('CH1', 'Character select: art direction', 'art', { worker: 'codex', tags: ['art'] }),
    stage: 'awaiting-user', why: WHY['awaiting-user'], waitingFor: 'answer',
    runs: [run('CH1', 1, 'codex', 5 * 3600_000, 4.6 * 3600_000, { usage: { source: 'codex-log', total_tokens: 96_000, cost_usd: 0.31, cost_estimated: true } })],
    reports: [report(3, 'waiting', 'Three looks for the select screen, all with the same layout', 4.6 * 3600_000, {
      run: 'r1', waitingFor: 'answer', question: 'Which look should the character select screen have?',
      options: [
        { key: '1', label: 'Chalk sketch', note: 'Rough lines, warm paper; matches the menu', images: ['artifacts/evidence/CH1/look-a.png', 'artifacts/evidence/CH1/look-a-detail.png'], recommended: true },
        { key: '2', label: 'Flat colour', note: 'Clean shapes, high contrast', images: ['artifacts/evidence/CH1/look-b.png'], recommended: false },
        { key: '3', label: 'Pixel portraits', images: ['artifacts/evidence/CH1/look-c.png'], recommended: false },
      ],
    })], decisions: [],
    quotes: [{
      id: 'Q1', project: 'demo-platformer', tag: 'CH1', service: 'image generation', unit: 'credits', unitPrice: 4, quantity: 30, total: 120, capRequested: 150,
      note: 'Final art for the chosen look, 30 portraits', created: iso(4.4 * 3600_000), by: 'executor', status: 'pending', spent: 0, ledger: [],
    }],
  });
  add({
    def: def('PH2', 'Physics: slopes and one-way platforms', 'gameplay', { worker: 'codex', needs: ['MV3'] }),
    stage: 'blocked', why: WHY.blocked,
    runs: [run('PH2', 1, 'codex', 9 * 3600_000, 8 * 3600_000, { usage: { source: 'codex-log', total_tokens: 301_000, cost_usd: 1.1, cost_estimated: true } })],
    reports: [report(3, 'blocked', 'Needs the collision layer to be split first; the tilemap order changes the same file', 8 * 3600_000, { question: 'Wait for TR2 to be merged, or split the collision layer now?' })], decisions: [],
  });
  add({
    def: def('NET1', 'Leaderboard client', 'online', { worker: 'grok' }),
    stage: 'failed', why: WHY.failed,
    runs: [run('NET1', 1, 'grok', 26 * 3600_000, 25 * 3600_000, { outcome: 'failed', usage: { source: 'grok-end', turns: 6, cost_usd: 0.19 } })],
    reports: [report(3, 'failed', 'The test server is not reachable from the sandbox', 25 * 3600_000)], decisions: [],
  });
  add({
    def: def('LT1', 'Lighting: bake the clock tower', 'level', { worker: 'codex-gpu', branch: 'order/lt1', base_ref: 'main' }),
    stage: 'running', why: WHY.running, quietMinutes: 4,
    runs: [run('LT1', 1, 'codex-gpu', 36 * MIN, undefined, { pid: 7716, alive: true, attempt: 1 })],
    progress: { plan: ['Sync the worktree to gpu-box', 'Open the level in the editor', 'Bake lighting', 'Capture the four views', 'Report'].map((step, i) => ({ step, status: i < 2 ? 'done' : i === 2 ? 'doing' : 'todo' })), done: 2, total: 5, current: 'Bake lighting', note: 'editor on gpu-box:8201', at: iso(3 * MIN) },
    uses: ['ue-editor'], reports: [], decisions: [{ seq: 1, at: iso(40 * MIN), kind: 'queue' }],
  });
  add({
    def: def('CK2', 'Cook the Windows client', 'tools', { worker: 'opencode-build', branch: 'order/ck2', base_ref: 'main' }),
    stage: 'running', why: WHY.running, quietMinutes: 2,
    runs: [run('CK2', 1, 'opencode-build', 18 * MIN, undefined, { pid: 9132, alive: true, attempt: 1 })],
    progress: { plan: ['Copy the LFS objects to build-box', 'Build the editor targets', 'Cook', 'Report'].map((step, i) => ({ step, status: i < 1 ? 'done' : i === 1 ? 'doing' : 'todo' })), done: 1, total: 4, current: 'Build the editor targets', at: iso(2 * MIN) },
    uses: ['build-box'], reports: [], decisions: [{ seq: 1, at: iso(20 * MIN), kind: 'queue' }],
  });
  add({
    def: def('MV4', 'Player movement: wall slide and wall jump', 'gameplay', { worker: 'codex', needs: ['MV3'], branch: 'order/mv4', base_ref: 'main', mandate: { spend_cap: 8 } }),
    stage: 'running', why: WHY.running, quietMinutes: 7,
    runs: [run('MV4', 1, 'codex', 48 * MIN, undefined, { pid: 18232, alive: true, attempt: 1, usage: { source: 'unknown' } })],
    progress: { plan: ['Read the movement notes', 'Add the wall-contact probe', 'Clamp the slide speed', 'Wall jump impulse', 'Cover it with tests', 'Update docs/movement.md', 'Report'].map((step, i) => ({ step, status: i < 2 ? 'done' : i === 2 ? 'doing' : 'todo' })), done: 2, total: 7, current: 'Clamp the slide speed', note: 'the controller keeps touchingWall already', at: iso(4 * MIN) },
    uses: ['build-box'],
    reports: [], decisions: [{ seq: 1, at: iso(50 * MIN), kind: 'queue' }],
    spend: { total_tokens: 0, estimated: false, runs_with_usage: 0, runs_unknown: 1, cap_usd: 8, over_cap: false },
  });
  add({
    def: def('UI3', 'HUD: lives and coin counter', 'ui', { worker: 'opencode', needs: [] }),
    stage: 'running', why: WHY.running, quietMinutes: 31, openCommand: 'pnpm build',
    runs: [run('UI3', 1, 'opencode', 3 * 3600_000, 2.2 * 3600_000, { outcome: 'capacity', limit: 'quota' }), run('UI3', 2, 'codex', 2 * 3600_000, undefined, { pid: 22040, alive: true, attempt: 2, rotatedFrom: { worker: 'opencode', reason: 'its usage window was used up' }, handoffFile: 'state/runs/UI3-r2.handoff.md' })],
    reports: [], decisions: [],
  });
  add({
    def: def('LV4', 'Level 4: the clock tower', 'level', { worker: 'codex', needs: ['PH2', 'TR2'] }),
    stage: 'waiting-needs', why: WHY['waiting-needs'], runs: [], reports: [], decisions: [{ seq: 1, at: iso(8 * 3600_000), kind: 'queue' }],
  });
  add({
    def: def('PK1', 'Package the Windows build', 'tools', { worker: 'codex', branch: 'order/pk1', base_ref: 'main' }),
    stage: 'monitoring', why: WHY.monitoring, uses: ['build-box', 'package-lane'],
    runs: [run('PK1', 1, 'codex', 3 * 3600_000, 2.6 * 3600_000, { outcome: 'completed' })],
    reports: [report(3, 'monitoring', 'The package step runs on its own; the monitor watches for the build folder', 2.6 * 3600_000, { run: 'r1' })],
    monitor: { spec: { check: ['python', 'tools/package_status.py', '--json'], cwd: '../worktrees/pk1', done_when: { file_exists: 'Saved/Packaged/WindowsClient/Game.exe' }, fail_when: { output_matches: 'FATAL|Error: package failed' }, deadline_minutes: 240, note: 'When it is done, run the smoke test in the packaged build and report.' }, started: iso(2.6 * 3600_000), deadline: new Date(Date.now() + 1.4 * 3600_000).toISOString(), checks: 15, lastCheckAt: iso(6 * MIN), lastResult: 'waiting', tail: 'cooking: 63% (4120 of 6540 packages)\nelapsed 02:28:11' },
    decisions: [{ seq: 1, at: iso(3.1 * 3600_000), kind: 'queue' }],
  });
  add({ def: def('EN1', 'Enemy: patrol slime', 'gameplay', { worker: 'codex', needs: ['MV3'] }), stage: 'queued', why: WHY.queued, runs: [], reports: [], decisions: [{ seq: 1, at: iso(6 * 3600_000), kind: 'queue' }] });
  add({ def: def('EN2', 'Enemy: flying bat', 'gameplay', { worker: 'codex', needs: ['MV3'] }), stage: 'queued', why: WHY.queued, runs: [], reports: [], decisions: [{ seq: 1, at: iso(6 * 3600_000), kind: 'queue' }] });
  add({ def: def('SV1', 'Save slots', 'systems', { worker: 'claude-card' }), stage: 'queued', why: WHY.queued, runs: [], reports: [], decisions: [{ seq: 1, at: iso(3 * 3600_000), kind: 'queue' }] });
  add({ def: def('CR1', 'Credits screen', 'ui', {}), stage: 'draft', why: WHY.draft, runs: [], reports: [], decisions: [] });
  add({ def: def('BG1', 'Parallax backgrounds', 'art', { worker: 'codex' }), stage: 'held', why: WHY.held, runs: [], reports: [], decisions: [{ seq: 1, at: iso(30 * 3600_000), kind: 'hold', note: 'Wait for the art direction call' }] });
  add({
    def: def('ID0', 'Idle test order', 'tools', { worker: 'opencode' }), stage: 'idle', why: WHY.idle,
    runs: [run('ID0', 1, 'opencode', 14 * 3600_000, 13 * 3600_000, { outcome: 'stalled' })], reports: [], decisions: [],
  });
  add({ def: def('OLD1', 'Prototype menu', 'ui', {}), stage: 'cancelled', why: WHY.cancelled, runs: [], reports: [], decisions: [{ seq: 1, at: iso(10 * 86400_000), kind: 'cancel', note: 'Replaced by TS1' }] });
  for (const [tag, title, kind] of [['SC1', 'Scene loader', 'systems'], ['AN1', 'Player animation states', 'art'], ['CF1', 'Config file', 'tools']] as const) {
    add({
      def: def(tag, title, kind, { worker: 'codex' }), stage: 'merged', why: WHY.merged,
      runs: [run(tag, 1, 'codex', 8 * 86400_000, 8 * 86400_000 - 40 * MIN, { usage: { source: 'codex-log', total_tokens: 250_000, cost_usd: 0.95, cost_estimated: true } })], reports: [], decisions: [{ seq: 4, at: iso(7.9 * 86400_000), kind: 'approve' }],
    });
  }

  // Events (oldest first).
  for (const o of a.orders.values()) {
    ev(a, o.def.tag, 'order-added', 'cli', 3 * 86400_000);
    for (const d of o.decisions) ev(a, o.def.tag, `action-${d.kind}`, d.kind === 'queue' ? 'cli' : 'web', Date.now() - Date.parse(d.at), d.note ? { note: d.note } : undefined);
    for (const r of o.runs) {
      ev(a, o.def.tag, 'run-start', 'tick', Date.now() - Date.parse(r.started), { run: r.id, worker: r.worker });
      if (r.ended) ev(a, o.def.tag, 'run-end', 'tick', Date.now() - Date.parse(r.ended), { run: r.id, outcome: r.outcome });
    }
    for (const r of o.reports) ev(a, o.def.tag, 'report', 'tick', Date.now() - Date.parse(r.at), { status: r.status });
  }
  a.events.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  a.events.forEach((e, i) => (e.id = i + 1));

  const b: MockProject = {
    info: { id: 'pixel-garden', name: 'Pixel Garden', hasWorkers: true, workOrdersDir: 'orders', tableWriteBack: false, checks: false },
    orders: new Map(),
    events: [],
    decisions: [],
    lessons: [],
  };
  const addB = (o: MockOrder) => b.orders.set(o.def.tag, o);
  addB({ def: def('PG1', 'Watering can tool', 'gameplay', { worker: 'codex' }), stage: 'running', why: WHY.running, quietMinutes: 3, runs: [run('PG1', 1, 'codex', 25 * MIN, undefined, { pid: 4410, alive: true })], reports: [], decisions: [] });
  addB({ def: def('PG2', 'Seed catalogue', 'ui', { worker: 'codex', needs: ['PG1'] }), stage: 'waiting-needs', why: WHY['waiting-needs'], runs: [], reports: [], decisions: [] });
  addB({ def: def('PG0', 'Garden grid', 'systems', { worker: 'codex' }), stage: 'merged', why: WHY.merged, runs: [run('PG0', 1, 'codex', 2 * 86400_000, 2 * 86400_000 - 40 * MIN, { usage: { source: 'codex-log', total_tokens: 140_000, cost_usd: 0.5, cost_estimated: true } })], reports: [], decisions: [] });
  b.events.push({ id: 1, at: iso(25 * MIN), tag: 'PG1', type: 'run-start', by: 'tick' });
  return [a, b];
}

export const createWorld = worlds;

export function makeWorkers(project: MockProject): Worker[] {
  const running = new Map<string, number>();
  for (const o of project.orders.values()) for (const r of o.runs) if (!r.ended && r.alive) running.set(r.worker, (running.get(r.worker) ?? 0) + 1);
  const q = (source: string, w: [string, number, number][], balance?: number): QuotaPoint => ({
    source, at: iso(4 * MIN), ok: true, windows: w.map(([name, usedPercent, resetIn]) => ({ name, usedPercent, resetsAt: new Date(Date.now() + resetIn * MIN).toISOString() })),
    balance: balance === undefined ? undefined : { raw: `$${balance.toFixed(2)}`, amount: balance },
  });
  const base = { onLimit: 'wait' as const, rotatePaid: false, aliases: [] as string[], sharesQuotaWith: [] as string[], sameModelAs: [] as string[], disabledWhen: [] as Worker['disabledWhen'], hasLaunch: true, cost: 'included' as const, capabilities: ['shell', 'edit', 'git'], extraCapabilities: [] as string[], paid: false, concurrency: 2, enabled: true, cardOnly: false, canResume: true, available: true, reasons: [] as string[], spendTodayUsd: 0, overCap: false };
  const list: Worker[] = [
    { ...base, id: 'codex', engine: 'codex', notes: 'Weekly included window; two concurrent sessions.', model: 'example-coder', route: 'subscription', dailyRuns: 12, runsToday: 5, running: running.get('codex') ?? 0, spendTodayUsd: 7.9, quota: q('codex-sub', [['5h', 38, 142], ['weekly', 71, 3600]]), price: { input_per_mtok: 1.25, output_per_mtok: 10 } },
    { ...base, id: 'opencode', engine: 'opencode', cost: 'paid' as const, notes: 'Daily spend is capped at five dollars.', route: 'gateway', paid: true, runsToday: 2, running: running.get('opencode') ?? 0, spendTodayUsd: 0.62, dailyCapUsd: 5, quota: q('gateway', [], 41.7), price: { per_mtok: 2 } },
    { ...base, id: 'grok', engine: 'grok-cli', quotaSource: 'gateway-grok', modelFamily: 'example-family', cost: 'paid' as const, capabilities: ['shell', 'edit', 'fast'], notes: 'Shares its daily quota with opencode-heavy.', route: 'direct', paid: true, concurrency: 1, runsToday: 1, running: 0, spendTodayUsd: 0.19, available: false, reasons: ['quota: window "daily" at 96% (limit 90%)', 'quota shared with opencode-heavy'], quota: q('gateway-grok', [['daily', 96, 380]]) },
    { ...base, id: 'opencode-heavy', engine: 'opencode', cost: 'paid' as const, capabilities: ['shell', 'edit', 'git', 'long-context'], notes: 'Shares its daily quota with grok.', route: 'gateway-grok', paid: true, runsToday: 0, running: 0, quotaSource: 'gateway-grok', modelFamily: 'example-family', available: false, reasons: ['quota: window "daily" at 96% (limit 90%)', 'quota shared with grok'], quota: q('gateway-grok', [['daily', 96, 380]]) },
    { ...base, id: 'codex-gpu', engine: 'codex', host: 'gpu-box', notes: 'Runs on the GPU box over SSH; editors open on its desktop.', model: 'example-coder', route: 'subscription', capabilities: ['shell', 'edit', 'git', 'gpu'], concurrency: 2, runsToday: 3, running: running.get('codex-gpu') ?? 0, quotaSource: 'codex-sub', quota: q('codex-sub', [['5h', 38, 142], ['weekly', 71, 3600]]) },
    { ...base, id: 'opencode-build', engine: 'opencode', host: 'build-box', cost: 'paid' as const, notes: 'Builds and cooks on the build box.', route: 'gateway', paid: true, capabilities: ['shell', 'edit', 'git', 'build'], concurrency: 3, runsToday: 4, running: running.get('opencode-build') ?? 0, spendTodayUsd: 1.4, dailyCapUsd: 10 },
    { ...base, id: 'claude-card', engine: 'claude', notes: 'Start a session manually from its card.', capabilities: ['vision', 'long-context'], cardOnly: true, canResume: false, concurrency: 1, runsToday: 0, running: 0 },
    { ...base, id: 'spare', engine: 'codex', route: 'subscription', enabled: false, runsToday: 0, running: 0 },
  ];
  return withEdits(project, list);
}

/** What the mock's console changed in the workers (the real thing writes the workers file). */
const workerEdits = new WeakMap<MockProject, { patch: Map<string, Partial<Worker>>; added: Worker[] }>();
export const editsOf = (project: MockProject) => workerEdits.get(project) ?? workerEdits.set(project, { patch: new Map(), added: [] }).get(project)!;

function withEdits(project: MockProject, list: Worker[]): Worker[] {
  const e = editsOf(project);
  const all = [...list, ...e.added].map(w => ({ ...w, ...e.patch.get(w.id) }));
  return all.map(w => ({
    ...w,
    sharesQuotaWith: w.quotaSource ? all.filter(o => o.id !== w.id && o.quotaSource === w.quotaSource).map(o => o.id) : [],
    sameModelAs: w.modelFamily ? all.filter(o => o.id !== w.id && o.modelFamily === w.modelFamily).map(o => o.id) : [],
  }));
}

/** The shared resources of the demo project, with who holds them. The perf one has a lease that outlived its run. */
export function makeResources(project: MockProject): ResourceView[] {
  if (project.info.id !== 'demo-platformer') return [];
  const lease = (resource: string, tag: string, minutes: number, limit = 480) => ({ resource, tag, since: iso(minutes * MIN), expires: new Date(Date.now() - minutes * MIN + limit * MIN).toISOString(), expired: minutes > limit, heldMinutes: minutes });
  return [
    { name: 'build-box', slots: 3, used: 2, note: 'builds on the Windows dev box', exclusive: false, blocks: [], leases: [lease('build-box', 'MV4', 48), lease('build-box', 'PK1', 156)] },
    { name: 'package-lane', slots: 1, used: 1, note: 'one packaging job at a time', exclusive: false, blocks: [], leases: [lease('package-lane', 'PK1', 156)] },
    { name: 'perf-exclusive', slots: 1, used: 1, note: 'frame-time runs need the box to themselves', exclusive: true, blocks: ['ue'], leases: [lease('perf-exclusive', 'ID0', 655)] },
    { name: 'sim-host', slots: 2, used: 0, exclusive: false, blocks: [], leases: [] },
  ];
}

export function makeHistory(source: string, withBalance: boolean): QuotaPoint[] {
  const out: QuotaPoint[] = [];
  const n = 72;
  for (let i = 0; i < n; i++) {
    const t = Date.now() - (n - i) * 20 * MIN;
    const k = i / n;
    const base: QuotaPoint = { source, at: new Date(t).toISOString(), ok: true, windows: [] };
    if (withBalance) { const amount = 52 - k * 10.3 - Math.max(0, k - 0.6) * 4; base.balance = { raw: `$${amount.toFixed(2)}`, amount }; }
    else base.windows = [{ name: '5h', usedPercent: Math.min(98, 10 + ((i % 30) * 3.1)) }, { name: 'weekly', usedPercent: 40 + k * 31 }];
    out.push(base);
  }
  return out;
}

export function makeOverview(project: MockProject): Overview {
  const orders = [...project.orders.values()];
  const summary = (o: MockOrder) => summarize(project, o);
  const needs = orders.filter(o => ['awaiting-user', 'awaiting-review', 'blocked', 'failed', 'dropped'].includes(o.stage)).map(summary);
  const running = orders.filter(o => o.stage === 'running').map(summary);
  const workers = makeWorkers(project);
  const stages: Partial<Record<Stage, number>> = {};
  for (const o of orders) stages[o.stage] = (stages[o.stage] ?? 0) + 1;
  const problems = [] as Overview['problems']['items'];
  if (orders.some(o => o.def.tag === 'UI3' && o.stage === 'running')) problems.push({ kind: 'stalled', tag: 'UI3', text: 'UI3: no commit or log for 31 min, a command (pnpm build) is still open' });
  if (orders.some(o => o.def.tag === 'UI3' && o.stage === 'running')) problems.push({ kind: 'looping', tag: 'UI3', text: 'UI3: the run is going round in circles: the same command failed 4 times with the same error', evidence: ['command: pnpm test --filter hud', 'error: Cannot find module ./coin_counter', 'seen 4 times in a row, last at 14:02'] });
  if (project.info.id === 'demo-platformer' && orders.some(o => o.def.tag === 'ID0')) problems.push({ kind: 'lease-expired', tag: 'ID0', text: 'ID0: has held perf-exclusive for 655 min, longer than its lease (480 min); release it if the run is gone.' });
  if (orders.some(o => o.def.tag === 'PG1' && o.stage === 'running')) problems.push({ kind: 'start-failed', tag: 'PG1', text: 'PG1: the run began 25 min ago and has written no start receipt (PG1.progress.json) and made no commit (limit 15 min): it probably did not start properly.' });
  if (project.info.id === 'demo-platformer') problems.push({ kind: 'quota', text: 'grok: window "daily" at 96%, orders for it wait' });
  const moves: Overview['next']['moves'] = [];
  for (const o of orders) {
    if (o.stage === 'queued' && o.def.worker === 'claude-card') moves.push({ tag: o.def.tag, mode: 'card', worker: 'claude-card' });
    else if (o.stage === 'queued') moves.push({ tag: o.def.tag, mode: 'dispatch', worker: o.def.worker ?? 'codex' });
  }
  return {
    project: project.info.id, name: project.info.name, at: new Date().toISOString(),
    needsYou: { count: needs.length, items: needs }, problems: { count: problems.length, items: problems },
    running: { count: running.length, items: running }, workers: { count: workers.length, items: workers }, stages,
    ...(hasLibrary(project.info.id) ? { pendingPicks: { count: pendingPicks(project.info.id).length, items: pendingPicks(project.info.id) } } : {}),
    pendingQuotes: (() => { const items = orders.flatMap(o => o.quotes ?? []).filter(q => q.status === 'pending'); return { count: items.length, items }; })(),
    next: { moves: moves.slice(0, 3), heldBack: [{ tag: 'EN2', why: 'one order at a time for kind gameplay' }] }, machine: { freeRamGb: 14.2, minFreeRamGb: 4 },
  };
}

export function summarize(project: MockProject, o: MockOrder) {
  const open = o.runs.find(r => !r.ended);
  const current = [...o.reports].reverse()[0];
  return {
    project: project.info.id, tag: o.def.tag, title: o.def.title, kind: o.def.kind, heavy: o.def.heavy, stage: o.stage, why: o.why, worker: o.def.worker,
    needs: o.def.needs, updated: o.def.updated, tags: o.def.tags, waitingFor: o.stage === 'awaiting-user' ? o.waitingFor ?? 'answer' : undefined,
    report: ['awaiting-user', 'awaiting-review', 'blocked', 'failed', 'dropped'].includes(o.stage) ? current : undefined,
    run: open ? { id: open.id, key: open.key, worker: open.worker, started: open.started, imported: open.imported, alive: open.alive } : undefined,
    quietMinutes: o.quietMinutes, openCommand: o.openCommand, spend: o.spend, branch: o.def.branch, monitor: o.monitor, progress: o.progress, uses: o.uses, actions: actionsFor(o.stage, o.waitingFor ?? 'answer'),
  };
}

const ESC = String.fromCharCode(27);
const c = (n: number, s: string) => `${ESC}[${n}m${s}${ESC}[0m`;

export function seedLog(tag: string): string[] {
  const out = [
    c(90, `[${new Date(Date.now() - 48 * MIN).toISOString().slice(11, 19)}]`) + ' session id: 019a3f2e-77c1-7d20-8a14-5be3c1a2f001',
    c(36, 'user') + ' Work order MV4: wall slide and wall jump. Read docs/movement.md first.',
    c(33, 'thinking') + ' I will start by reading the player controller and the collision tests.',
  ];
  const steps = ['src/player.ts', 'src/collision.ts', 'test/player.test.ts', 'docs/movement.md'];
  for (const f of steps) {
    out.push(c(32, 'exec') + ` sed -n '1,200p' ${f}`);
    for (let i = 0; i < 6; i++) out.push(`  ${String(i + 1).padStart(3)}  ${i % 2 ? 'export function ' : 'const '}${f.split('/').pop()?.split('.')[0]}${i}()`);
  }
  out.push(c(35, 'codex') + ' The controller keeps `grounded` and `touchingWall` flags; wall slide is a clamp on vertical speed.');
  out.push(c(32, 'exec') + ' pnpm test --filter player');
  out.push(c(31, '  FAIL') + ' test/player.test.ts > wall jump pushes away from the wall');
  out.push(c(31, '  AssertionError:') + ' expected 0 to be greater than 3');
  out.push(c(35, 'codex') + ' The test expects a horizontal push; adding it to the jump impulse.');
  out.push(c(32, 'apply_patch') + ' src/player.ts (+14 -2)');
  out.push(c(32, 'exec') + ' pnpm test --filter player');
  out.push(c(32, '  PASS') + ' 12 tests');
  out.push(`${tag}: ${c(90, 'tokens used')} 412,883`);
  return out;
}
