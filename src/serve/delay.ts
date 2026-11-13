import { monitorEventLoopDelay } from 'node:perf_hooks';
import { debuglog } from 'node:util';

export interface LoopDelay { p99Ms: number; maxMs: number }
/** Values cover the current minute; logging resets the histogram for the next window. */
export function watchLoopDelay() {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const read = (): LoopDelay => ({ p99Ms: histogram.count ? histogram.percentile(99) / 1e6 : 0, maxMs: histogram.count ? histogram.max / 1e6 : 0 });
  const log = debuglog('alba:serve');
  const timer = setInterval(() => { log('event-loop delay %j', read()); histogram.reset(); }, 60_000).unref();
  return { read, close() { clearInterval(timer); histogram.disable(); } };
}
