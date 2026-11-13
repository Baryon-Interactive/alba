import { OrderRoleSelect } from '@/components/Roles';
import { toast } from 'sonner';
import { Bot, Puzzle, RefreshCw, Route as RouteIcon, Sparkles } from 'lucide-react';
import type { Run } from '@api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/misc';
import { ErrorBox, Section } from '@/components/common';
import { errorText, useClassify, useOrderSkills, useRoute } from '@/lib/queries';
import { layerLabel, layerTone, outcomeLabel, outcomeTone, ratePercent, sourceLabel, verdictLabel, verdictTone } from '@/lib/routing';
import { dateTime } from '@/lib/format';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';

/** What the order was classified as, and how the tick would choose a worker for it now: every worker looked at, with the reason. */
export function RoutePanel({ project, tag }: { project: string; tag: string }) {
  const q = useRoute(project, tag);
  const classify = useClassify(project, tag);
  const ask = (model: boolean) => classify.mutate(model, {
    onSuccess: r => toast.success(t('Classified as {kind} ({source})', { kind: r.routing.kind, source: sourceLabel(r.routing.source) })),
    onError: e => toast.error(errorText(e)),
  });
  const title = <><RouteIcon className="size-4" />{t('Who takes it')}</>;
  if (q.isError) return <Section title={title}><ErrorBox error={q.error} /></Section>;
  if (!q.data) return <Section title={title}><Skeleton className="h-32" /></Section>;
  const r = q.data;
  return (
    <Section
      title={title}
      actions={(
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" disabled={classify.isPending} onClick={() => ask(false)}><RefreshCw />{t('Classify again')}</Button>
          <Button size="sm" variant="outline" disabled={classify.isPending} onClick={() => ask(true)} title={t('Ask the classifier worker when the rules decide nothing')}><Bot />{t('Ask the classifier')}</Button>
        </div>
      )}
    >
      <Card>
        <CardContent className="grid gap-3">
          <OrderRoleSelect project={project} tag={tag} role={r.role} />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="primary">{t('kind {kind}', { kind: r.routing.kind })}</Badge>
            {r.routing.tags.map(x => <Badge key={x} tone="outline">{x}</Badge>)}
            <Badge tone="neutral">{sourceLabel(r.routing.source)}</Badge>
            <Badge tone={outcomeTone(r.outcome)}>{outcomeLabel(r.outcome)}{r.chosen ? `: ${r.chosen}` : ''}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">{r.routing.why}</p>
          {r.role?.definition && <div className="grid gap-1 text-sm text-muted-foreground">
            <p>{t('Requires')}: {r.role.definition.requires?.join(', ') || '—'}</p>
            <p>{t('Role skills')}: {r.role.definition.skills?.join(', ') || '—'}</p>
            <p>{t('MCP servers')}: {Object.keys(r.role.definition.mcp ?? {}).join(', ') || '—'}</p>
            <p>{t('Rules file')}: {r.role.definition.rules || '—'}</p>
            <p>{t('Prefer')}: {r.role.definition.workers?.prefer?.join(', ') || '—'} · {t('Avoid')}: {r.role.definition.workers?.avoid?.join(', ') || '—'}</p>
          </div>}
          <p className="text-sm">{r.why}</p>
          {r.candidates.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="py-1 pr-2 font-medium">{t('Worker')}</th><th className="px-2 font-medium">{t('Preference')}</th><th className="px-2 font-medium">{t('Cost')}</th>
                  <th className="px-2 font-medium">{t('Accepted')}</th><th className="px-2 font-medium">{t('Verdict')}</th><th className="pl-2 font-medium">{t('Reason')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {r.candidates.map(c => (
                  <tr key={c.worker} className={cn(c.verdict === 'chosen' && 'bg-success/6')}>
                    <td className="py-1.5 pr-2 font-medium">{c.worker}</td>
                    <td className="px-2 tabular-nums">{c.preferred && c.preference !== undefined ? c.preference + 1 : '—'}</td>
                    <td className="px-2">{c.cost === 'paid' ? <Badge tone="warning">{t('paid')}</Badge> : <Badge tone="outline">{t('included')}</Badge>}</td>
                    <td className="px-2 text-xs tabular-nums text-muted-foreground">{c.history ? (ratePercent(c.history.rate) ?? t('{n} sample(s)', { n: c.history.samples })) : '–'}</td>
                    <td className="px-2"><Badge tone={verdictTone(c.verdict)}>{verdictLabel(c.verdict)}</Badge></td>
                    <td className="pl-2 text-xs text-muted-foreground">{c.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="text-xs text-muted-foreground">{t('Calculated now; nothing is started.')}{r.routing.at ? ` ${t('Classified {when}', { when: dateTime(r.routing.at) })}` : ''}</div>
        </CardContent>
      </Card>
    </Section>
  );
}

/** The skills the next run of this order gets, with the layer and the reason for each, and what workers suggested to change. */
export function OrderSkillsPanel({ project, tag }: { project: string; tag: string }) {
  const q = useOrderSkills(project, tag);
  const title = <><Puzzle className="size-4" />{t('Skills for this order')}</>;
  if (q.isError) return <Section title={title}><ErrorBox error={q.error} /></Section>;
  if (!q.data) return <Section title={title}><Skeleton className="h-24" /></Section>;
  const d = q.data;
  return (
    <Section title={title} count={d.skills.length}>
      <Card>
        <CardContent className="grid gap-2">
          {d.skills.length === 0 ? <p className="text-sm text-muted-foreground">{t('No skill is attached to this order.')}</p> : (
            <ul className="divide-y">
              {d.skills.map(s => (
                <li key={s.name} className="py-1.5">
                  <div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-medium">{s.name}</span><Badge tone={layerTone(s.layer)}>{layerLabel(s.layer)}</Badge><span className="text-xs text-muted-foreground">{s.why}</span></div>
                  <div className="text-xs text-muted-foreground">{s.description}</div>
                </li>
              ))}
            </ul>
          )}
          {d.mountedAt.length > 0 && <div className="text-xs text-muted-foreground">{t('Put into the worktree at:')} <span className="font-mono">{d.mountedAt.join(', ')}</span></div>}
          {d.suggestions.length > 0 && (
            <div className="rounded-md border-l-[3px] border-primary bg-primary/6 px-3 py-1.5 text-sm">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium"><Sparkles className="size-3.5" />{t('Workers suggest changing')}</div>
              {d.suggestions.map((s, i) => <div key={i} className="text-xs"><span className="font-mono">{s.path}</span>: {s.reason}{s.run ? <span className="text-muted-foreground"> · {s.run}</span> : null}</div>)}
            </div>
          )}
        </CardContent>
      </Card>
    </Section>
  );
}

/** Why this run's worker was chosen and which skills it was given, under its row in the runs table. */
export function RunRoutingNote({ r }: { r: Run }) {
  if (!r.routing && !r.skills?.length) return null;
  return (
    <div className="grid gap-0.5 text-xs text-muted-foreground">
      {r.routing && <div>{r.routing.why}</div>}
      {r.skills && r.skills.length > 0 && <div>{t('{n} skill(s)', { n: r.skills.length })}: {r.skills.join(', ')}</div>}
    </div>
  );
}
