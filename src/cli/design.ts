import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import type { Orders } from '../orders/service.ts';
import { applyChangeSets, designHistory, exportDesign, readChangeSet, readLibrary, requireDesign, stableJson } from '../design/library.ts';
import { checkDesign, searchDesign, showDesign } from '../design/read.ts';
import { DesignError } from '../design/model.ts';
import { designTemplate } from '../design/template.ts';

export function runDesign(project: ProjectConfig, orders: Orders, command: string | undefined, args: string[], options: { out?: string; json?: boolean; order?: string; 'dry-run'?: boolean }, exit: (code: number) => void): string {
  requireDesign(project);
  if (command === 'systems') return stableJson(readLibrary(project).system);
  if (command === 'show' && args[0]) return stableJson(showDesign(project, args[0]));
  if (command === 'search' && args.length) return stableJson(searchDesign(project, args.join(' ')));
  if (command === 'history') return stableJson(designHistory(project, args[0]));
  if (command === 'export') return stableJson({ out: exportDesign(project, options.out ? path.resolve(options.out) : project.design!.export_dir) });
  if (command === 'import-template') return stableJson(designTemplate());
  if (command === 'apply' && args[0]) {
    const results = applyChangeSets(project, orders, args.map(readChangeSet), { dryRun: options['dry-run'], order: options.order ? orders.get(options.order).order.tag : undefined, idempotent: true });
    if (results.some(result => result.export_error)) exit(1);
    return stableJson(results.length === 1 ? results[0] : results);
  }
  if (command === 'check') {
    const result = checkDesign(project, orders); if (!result.ok) exit(1);
    return options.json ? stableJson(result) : [...result.issues.map(i => `${i.severity}: ${i.entity}: ${i.message}`), `${result.issues.filter(i => i.severity === 'error').length} errors, ${result.issues.filter(i => i.severity === 'warning').length} warnings`].join('\n');
  }
  throw new DesignError('Usage: alba design systems | show <id> | search <text> | history [id] | export [--out dir] | import-template | apply <file>... [--order TAG] [--dry-run] | check [--json] | measure [<target>...] [--dry-run]');
}
