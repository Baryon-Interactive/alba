import { Link } from 'react-router';
import { Moon } from 'lucide-react';
import type { ProjectOverview } from '@api';
import { Badge } from '@/components/ui/badge';
import { ago, dateTime, duration } from '@/lib/format';
import { t } from '@/i18n';

const labels = { passed: 'Gate passed', failed: 'Gate failed', running: 'Gates running', waiting: 'Gates waiting', error: 'Gate setup error', abandoned: 'Gates abandoned' } as const;

export function NightlyGatesCard({ gates, project }: { gates: ProjectOverview['nightlyGates']; project: string }) {
  if (!gates) return null;
  const run = gates.last;
  return <section className="overflow-hidden rounded-lg border bg-card" data-testid="nightly-gates">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5"><h2 className="flex items-center gap-2 text-sm font-semibold"><Moon className="size-4 text-primary" />{t('Nightly gates')}</h2><Link className="text-xs text-primary hover:underline" to={`/p/${encodeURIComponent(project)}/producer?tab=activity`}>{t('View activity')}</Link></div>
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 text-xs">
      {run ? <><Badge tone={run.status === 'failed' ? 'danger' : run.status === 'passed' ? 'success' : 'warning'}>{t(labels[run.status])}</Badge><span className="text-muted-foreground">{t('Last gate run')}: <time dateTime={run.started} title={dateTime(run.started)}>{ago(run.started)}</time></span><span>{t('Commit')}: <code title={run.commit}>{run.commit.slice(0, 12)}</code></span>{!run.full && <Badge tone="outline">{t('Selected gates only')}</Badge>}</> : <span className="text-muted-foreground">{t('No nightly run yet')}</span>}
      <span className="ml-auto text-muted-foreground">{t('Factory local window')}: {gates.window}</span>
    </div>
    {run?.reason && <p className="border-t px-4 py-2 text-xs text-warning">{run.reason}</p>}
    <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="border-y bg-muted/30 text-muted-foreground"><tr>{['Gate', 'Result', 'Duration', 'Value', 'Commit'].map(key => <th key={key} className="px-4 py-2 font-medium">{t(key)}</th>)}</tr></thead><tbody className="divide-y">{gates.gates.map(g => <tr key={g.name} className={g.last?.status === 'failed' ? 'bg-destructive/5' : ''}>
      <td className="px-4 py-2.5 font-medium">{g.name}</td><td className="max-w-md px-4 py-2.5">{g.last ? <><Badge tone={g.last.status === 'passed' ? 'success' : 'danger'}>{t(labels[g.last.status])}</Badge>{g.last.reason && <p className="mt-1.5 break-words text-destructive">{g.last.reason}</p>}</> : <span className="text-muted-foreground">{t('Gate not run')}</span>}</td>
      <td className="whitespace-nowrap px-4 py-2.5 tabular-nums">{g.last ? duration(g.last.started, g.last.ended) : '—'}</td><td className="px-4 py-2.5 tabular-nums">{g.last?.value ?? '—'}</td><td className="px-4 py-2.5 font-mono text-muted-foreground" title={g.last?.commit}>{g.last?.commit.slice(0, 12) ?? '—'}</td>
    </tr>)}</tbody></table></div>
  </section>;
}
