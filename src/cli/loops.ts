import { existsSync, readFileSync } from 'node:fs';
import type { ProjectConfig } from '../config.ts';
import { t } from '../i18n.ts';
import type { Orders } from '../orders/service.ts';
import { findLoops, idleStretches, isLongCommand, parseActions } from '../run/loops.ts';

/**
 * `alba loops [TAG] [--all]`: reads the logs of runs (open ones, or every run with `--all`) and says, for each, how many commands it ran
 * and whether it repeated itself, took turns between two commands, or went a long time between commands while its log kept growing
 * (that last one is read from the engine's own timestamps, which only some engines print). Nothing is changed.
 */
export function loopsReport(project: ProjectConfig, orders: Orders, options: { tag?: string; all?: boolean }): string {
  const d = project.dispatch;
  const rules = { repeat: d.loop_repeat, alternate: d.loop_alternate, longCommands: d.long_commands };
  const lines: string[] = [t('alba loops: repeat {r}, alternate {a} rounds, idle {m} min; long commands: {words}', { r: d.loop_repeat, a: d.loop_alternate, m: d.loop_idle_minutes, words: d.long_commands.join(', ') })];
  let looking = 0, found = 0;
  for (const doc of orders.all().sort((a, b) => a.order.tag.localeCompare(b.order.tag))) {
    if (options.tag && doc.order.tag.toLowerCase() !== options.tag.toLowerCase()) continue;
    for (const run of doc.runs) {
      const file = run.events_file && existsSync(run.events_file) ? run.events_file : run.log;
      if (!file || !existsSync(file) || (!options.all && run.ended !== undefined)) continue;
      const text = readFileSync(file, 'utf8');
      const parsed = parseActions(text);
      looking++;
      const failed = parsed.actions.filter(a => a.failed).length;
      const findings = findLoops(parsed.actions, rules);
      const gaps = parsed.format === 'codex' ? idleStretches(text, d.loop_idle_minutes) : [];
      const head = `${doc.order.tag}-${run.id}  ${parsed.format}  ${t('{n} commands, {f} failed', { n: parsed.started, f: failed })}${run.ended ? '' : `  ${t('(open)')}`}`;
      if (!findings.length && !gaps.length) { lines.push(`${head}  ${t('no loop')}`); continue; }
      found += findings.length + gaps.length;
      lines.push(head);
      for (const f of findings) lines.push(`  ${f.kind}: ${f.text}`);
      for (const g of gaps) lines.push(`  idle: ${t('{min} min from the command at line {line} to the next one, the log growing meanwhile: {command}', { min: g.minutes, line: g.line, command: g.command.slice(0, 100) })}${isLongCommand(g.command, rules.longCommands) ? `  (${t('a known long command: not counted')})` : ''}`);
    }
  }
  lines.push('', t('{looked} run logs read, {n} findings', { looked: looking, n: found }));
  return lines.join('\n');
}
