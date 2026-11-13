import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../../src/config.ts';
import type { Orders } from '../../src/orders/service.ts';

/** Reproducible display fixtures, not live workers or real model bills. DEMO1 remains the real dispatch. */
export function addShowcase(project: ProjectConfig, orders: Orders): void {
  const samples = [
    ['DEMO2', 'Add keyboard navigation to the inventory', 'running'],
    ['DEMO3', 'Choose the checkpoint recovery behavior', 'awaiting-user'],
    ['DEMO4', 'Review the pause-menu accessibility pass', 'awaiting-review'],
    ['DEMO5', 'Build the save-slot preview panel', 'running'],
    ['DEMO6', 'Choose a controller prompt style', 'awaiting-user'],
    ['DEMO7', 'Review the settings persistence checks', 'awaiting-review'],
  ] as const;
  const usage = (n: number) => ({ source: 'opencode-json' as const, input_tokens: n * 3200, output_tokens: n * 800, cached_tokens: n * 1200, reasoning_tokens: 0, total_tokens: n * 5200, turns: n });
  const first = orders.get('DEMO1').runs[0]!;
  orders.patchRun('DEMO1', first.id, { model: 'demo-model', usage: usage(2) });
  for (const [index, [tag, title, stage]] of samples.entries()) {
    writeFileSync(path.join(project.work_orders, `${tag}.md`), `# ${tag}: ${title}\n\nSynthetic console demonstration.\n`);
    orders.add({ tag, title, kind: 'task', role: 'local' });
    orders.act(tag, 'queue');
    const { run } = orders.runStart(tag, { worker: 'local', extra: { engine: 'script', model: 'demo-model', usage: usage(index + 3) } });
    if (stage === 'running') continue; // A recorded display state; no background process to keep alive.
    orders.runEnd(tag);
    orders.report(tag, {
      status: stage === 'awaiting-user' ? 'waiting' : 'ready', summary: stage === 'awaiting-user' ? 'Two approaches are ready for your decision.' : 'Implementation and checks are ready for review.',
      ...(stage === 'awaiting-user' ? { question: tag === 'DEMO3' ? 'Restore at the checkpoint or at the nearest safe location?' : 'Use platform glyphs or generic button labels?' } : {}),
      evidence: [], commits: [],
    });
    if (stage !== orders.stage(orders.get(tag)).stage) throw new Error(`Unexpected showcase stage for ${tag}/${run.id}.`);
  }
}
