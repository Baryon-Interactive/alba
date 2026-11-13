/** Reproduce the documented transcript using only a disposable fixture. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { designFixture, initialDesign } from './fixtures/design.ts';
import { alba } from './cli-helper.ts';
import { applyChangeSet, stableJson } from '../src/design/library.ts';
import { callProducerTool } from '../src/producer/mcp.ts';

const f = designFixture();
applyChangeSet(f.project, f.orders, initialDesign());
const show = alba(f.file, ['design', 'show', 'ECON']);
const proposal = path.join(f.root, 'conflict.json');
writeFileSync(proposal, JSON.stringify({ title: 'Stale edit', changes: [{ op: 'update', kind: 'rule', id: 'ECON-R01', base_version: 8, fields: { text: 'Stale text' } }] }));
const conflict = alba(f.file, ['design', 'apply', proposal]);
const check = alba(f.file, ['design', 'check', '--json']);
assert.equal(show.code, 0); assert.equal(conflict.code, 1); assert.equal(check.code, 0);
const producer = callProducerTool(f.project, f.orders, 'producer_read', { kind: 'design', query: 'open-gaps-without-order' });
const block = (title: string, output: string, language = 'json') => `## ${title}\n\n\`\`\`${language}\n${output.trim()}\n\`\`\`\n`;
process.stdout.write('# Design library fixture validation\n\nGenerated with `node --disable-warning=ExperimentalWarning test/design-evidence.ts`. All data comes from a disposable invented ECON fixture; no model or real project is used. The commands below use its temporary project configuration.\n\n' +
  block('alba design show ECON — exit 0', show.out) + '\n' +
  block('alba design apply conflict.json — exit 1', conflict.err, 'text') + '\n' +
  block('alba design check --json — exit 0 (warnings only)', check.out) + '\n' +
  block('producer_read {kind: "design", query: "open-gaps-without-order"}', stableJson(producer)));

// Reproduce the reviewer's removed-pointer case through the real CLI.
writeFileSync(path.join(f.root, 'content/economy.json'), '{}');
const unrelated = path.join(f.root, 'unrelated.json');
writeFileSync(unrelated, JSON.stringify({ title: 'Clarify income', changes: [{ op: 'update', kind: 'rule', id: 'ECON-R01', base_version: 1, fields: { text: 'Credit income once per turn.' } }] }));
const applied = alba(f.file, ['design', 'apply', unrelated]), stale = alba(f.file, ['design', 'check', '--json']);
assert.equal(applied.code, 0, applied.err); assert.equal(stale.code, 0, stale.err);
const result = JSON.parse(applied.out), checked = JSON.parse(stale.out);
assert.ok(result.warnings.some((i: any) => i.code === 'param-unresolved' && i.severity === 'warning'));
assert.ok(checked.issues.some((i: any) => i.code === 'param-unresolved' && i.severity === 'warning'));
process.stdout.write('\n' + block('Removed pointer: alba design apply unrelated.json — exit 0', stableJson({ applied: result.applied, changes: result.changes, warnings: result.warnings })) + '\n' + block('Removed pointer: alba design check --json — exit 0', stale.out));
