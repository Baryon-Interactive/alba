import type { ProjectOverview } from '@api';

/** Invented regression batch used by mock mode and the overview rendering check. */
export function mockNightlyGates(): NonNullable<ProjectOverview['nightlyGates']> {
  const commit = 'b7e42ac913d50e86a72401c5da6a0f3bc829e417', started = new Date(Date.now() - 3 * 3600000).toISOString();
  const result = (gate: string, minutes: number, status: 'passed' | 'failed', value?: number) => ({ gate, commit, started, ended: new Date(Date.parse(started) + minutes * 60000).toISOString(), status, exit: status === 'failed' ? 1 : 0, timedOut: false, value,
    reason: status === 'failed' ? 'Reference scenario: expected 4a61e9, received 7b32c0.' : undefined, log: `state/nightly-gates/demo/${gate}.log` });
  const results = [result('reference-scenarios', 42, 'failed'), result('simulation-soak', 64, 'passed', 12000), result('asset-hashes', 3, 'passed', 3)];
  return { window: '01:00-06:00', only_if_merged: true, lastPass: undefined, last: { id: 'demo-night', night: started.slice(0, 10), commit, from: 'a'.repeat(40), mergedOrders: ['DEMO-A', 'DEMO-B'],
    started, ended: results[1].ended, status: 'failed', full: true, names: results.map(r => r.gate), definition: '', results }, gates: results.map(last => ({ name: last.gate, last })) };
}
