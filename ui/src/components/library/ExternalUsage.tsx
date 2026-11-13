import { AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/misc';
import { ErrorBox, Section } from '@/components/common';
import { useProjects, useUsage } from '@/lib/queries';
import { dateTime } from '@/lib/format';
import { t } from '@/i18n';

/**
 * Calls other tools recorded for this project (an image generator, for example), by day and model, for the last 7 days.
 * Times in a ledger without a zone are the machine's local time. Nothing is shown for a project without `usage_ledgers`.
 */
export function ExternalUsageSection({ project }: { project: string }) {
  const projects = useProjects();
  const on = projects.data?.find(p => p.id === project)?.library?.usage === true;
  const q = useUsage(project, on, 7);
  if (!on) return null;
  const title = t('Calls by other tools');
  if (q.isError) return <Section title={title}><ErrorBox error={q.error} /></Section>;
  if (!q.data) return <Section title={title}><Skeleton className="h-24" /></Section>;
  const d = q.data;
  const broken = d.ledgers.filter(l => !l.ok || l.unreadable > 0);
  return (
    <Section title={title} count={d.total.ok + d.total.failed}>
      <p className="mb-2 text-xs text-muted-foreground">{t('Last {days} days, local time: {ok} succeeded, {failed} failed. A call counts for this project when the folder it ran in, or the file it wrote, is under the project.', { days: d.days, ok: d.total.ok, failed: d.total.failed })}</p>
      {broken.length > 0 && (
        <ul className="mb-2 grid gap-1 rounded-md border border-warning/40 bg-warning/8 px-3 py-2 text-xs">
          {broken.map(l => <li key={l.id} className="flex items-start gap-1.5"><AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" /><span><span className="font-mono">{l.id}</span>: {l.ok ? t('{n} line(s) could not be read', { n: l.unreadable }) : l.problem}</span></li>)}
        </ul>
      )}
      {d.byDay.length === 0 ? (
        <Card className="p-3.5 text-sm text-muted-foreground">{t('No calls for this project in the last {days} days.', { days: d.days })}{d.ledgers.map(l => l.last ? ` ${t('{id}: last call {when}', { id: l.id, when: dateTime(l.last) })}` : '').join('')}</Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[24rem] text-sm">
              <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="px-4 py-1.5 font-medium">{t('Day')}</th><th className="px-2 py-1.5 font-medium">{t('Model')}</th><th className="px-2 py-1.5 text-right font-medium">{t('Succeeded')}</th><th className="px-4 py-1.5 text-right font-medium">{t('Failed')}</th></tr></thead>
              <tbody className="divide-y">
                {d.byDay.map(r => (
                  <tr key={`${r.day}|${r.ledger}|${r.model}`}>
                    <td className="px-4 py-1.5 whitespace-nowrap tabular-nums">{r.day}</td>
                    <td className="px-2 py-1.5">{r.model}{d.ledgers.length > 1 && <Badge tone="outline" className="ml-1.5">{r.ledger}</Badge>}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.ok}</td>
                    <td className={`px-4 py-1.5 text-right tabular-nums ${r.failed ? 'text-destructive' : 'text-muted-foreground'}`}>{r.failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card className="divide-y self-start">
            {d.byModel.map(m => (
              <div key={`${m.ledger}|${m.model}`} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                <span className="min-w-0 truncate">{m.model}</span>
                <span className="tabular-nums"><span>{m.ok}</span>{m.failed > 0 && <span className="ml-1.5 text-destructive">/ {m.failed}</span>}</span>
              </div>
            ))}
          </Card>
        </div>
      )}
    </Section>
  );
}
