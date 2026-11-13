import { useEffect, useState } from 'react';
import type { Run } from '@api';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Section } from '@/components/common';
import { tokens, dateTime } from '@/lib/format';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';

type Live = NonNullable<Run['live']>;
export const livePhase = (phase: Live['phase']) => ({ thinking: t('Thinking'), running_command: t('Running a command'), editing_files: t('Editing files'), waiting_long_command: t('Waiting on a long command'), idle: t('Idle') })[phase];

export function LiveCommand({ live }: { live: Live }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const c = live.current;
  const seconds = c ? Math.floor(Math.max(c.elapsed_seconds, (now - Date.parse(c.started_at)) / 1000)) : 0;
  return <span className="min-w-0"><span className={cn('font-medium', live.phase === 'waiting_long_command' && 'text-warning')}>{livePhase(live.phase)}</span>{c && <span className="ml-2 font-mono text-xs break-all">{c.command} <span className="whitespace-nowrap text-muted-foreground tabular-nums">{t('{n} min {s} s', { n: Math.floor(seconds / 60), s: seconds % 60 })}</span></span>}</span>;
}

export function LivePanel({ live }: { live: Live }) {
  const last = live.usage.per_turn.at(-1);
  const kind = (k: string) => ({ command_execution: t('Command'), tool: t('Tool'), mcp_tool_call: t('Tool'), web_search: t('Search'), file_change: t('Files changed'), message: t('Agent message'), error: t('Error'), log: t('Log') })[k] ?? t('Activity');
  const icon = (k: string) => ({ command_execution: '›_', tool: '⚙', mcp_tool_call: '⚙', web_search: '⌕', file_change: '✎', message: '●', error: '!' })[k] ?? '·';
  return <div className="grid gap-4">
    <Card className="border-primary/30 p-4" aria-label={t('Live activity')}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{t('Live activity')}</h2><Badge tone="outline">{t('{n} turns', { n: live.usage.turns })}</Badge></div>
      <LiveCommand live={live} />
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <ol className="grid gap-1 text-sm">{live.plan?.plan.map((p, i) => <li key={i} className={cn('rounded px-2 py-1', (p.step === live.plan?.current) && 'bg-primary/10 font-medium text-primary', ['done', 'completed'].includes(p.status) && 'text-muted-foreground')}><span className="mr-2 font-mono text-xs">{['done', 'completed'].includes(p.status) ? '✓' : i + 1}</span>{p.step}</li>)}</ol>
        <div className="space-y-1 text-xs text-muted-foreground">{live.usage.turns > 0 ? <p>{t('Total input / cached / output')}: <span className="font-mono text-foreground">{tokens(live.usage.input_tokens)} / {tokens(live.usage.cached_input_tokens)} / {tokens(live.usage.output_tokens)}</span></p>
          : <p>{t('Tokens: not reported yet. Codex reports its usage only when its turn ends, which for a run is at the end.')}</p>}{last && <p>{t('Latest turn input / cached / output')}: <span className="font-mono text-foreground">{tokens(last.input_tokens)} / {tokens(last.cached_input_tokens)} / {tokens(last.output_tokens)}</span></p>}{live.last_event_at && <p>{t('Last event')}: {dateTime(live.last_event_at)}</p>}{live.plan?.note && <p>{live.plan.note}</p>}</div>
      </div>
    </Card>
    <Section title={t('Recent activity')} count={live.recent.length}><Card className="max-h-72 divide-y overflow-auto">{[...live.recent].reverse().map((a, i) => <div key={`${a.at}-${i}`} className={cn('px-3 py-2 text-xs', a.exit_code !== undefined && a.exit_code !== 0 && 'bg-destructive/5 text-destructive')}><div className="flex gap-2"><span className="w-5 shrink-0 font-mono" aria-hidden>{icon(a.kind)}</span><span className="shrink-0 text-muted-foreground">{dateTime(a.at)}</span><span className="shrink-0">{kind(a.kind)}</span><span className="min-w-0 flex-1 font-mono break-all">{a.summary}</span>{a.exit_code !== undefined && <span>{t('exit {n}', { n: a.exit_code })}</span>}{a.duration_seconds !== undefined && <span className="shrink-0 tabular-nums">{t('{n} s', { n: Math.round(a.duration_seconds) })}</span>}</div>{a.output_tail && <details className="mt-1 ml-7"><summary className="cursor-pointer">{t('Failed output')}</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono">{a.output_tail}</pre></details>}</div>)}</Card></Section>
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title={t('Agent messages')} count={live.messages.length}><Card className="max-h-64 divide-y overflow-auto">{live.messages.map((m, i) => <div key={i} className="px-3 py-2"><span className="text-xs text-muted-foreground">{dateTime(m.at)}</span><p className="mt-1 text-sm whitespace-pre-wrap">{m.text}</p></div>)}</Card></Section>
      <Section title={t('Files changed')} count={live.files_changed.length}><Card className="max-h-64 overflow-auto p-3"><ul className="space-y-1 font-mono text-xs">{live.files_changed.map(f => <li key={f}>{f}</li>)}</ul>{live.diff_stat && <pre className="mt-3 whitespace-pre-wrap font-mono text-xs text-muted-foreground">{live.diff_stat}</pre>}</Card></Section>
    </div>
  </div>;
}
