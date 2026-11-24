import { useEffect, useState } from 'react';
import type { EndKind, TranscriptEntry } from '@api';
import { Link, useParams, useSearchParams } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LogViewer } from '@/components/LogViewer';
import { LivePanel } from '@/components/LivePanel';
import { MessageBox } from '@/components/MessageBox';
import { TranscriptView } from '@/components/TranscriptView';
import { hasJsonStream, resolveRunTab } from '@/components/TranscriptLogic';
import { Empty, ErrorBox, Section, SectionBoundary, StageBadge, UsageText } from '@/components/common';
import { useOrder, useProjectId } from '@/lib/queries';
import { dateTime, duration, tokens } from '@/lib/format';
import { useSeenWhilePresent } from '@/components/OrderAttention';
import { RunStatus } from '@/components/RunStatus';
import { t } from '@/i18n';

const SILENT_END_KINDS: ReadonlySet<EndKind> = new Set(['stream-cut-mid-turn', 'vanished', 'output-limit', 'context-limit']);

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-28">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-medium">{children}</div>
    </div>
  );
}

export function RunPage() {
  const project = useProjectId();
  const { tag = '', runId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const q = useOrder(project, tag);
  useSeenWhilePresent(project, tag, q.data);
  const [loadedEntries, setLoadedEntries] = useState<readonly TranscriptEntry[] | undefined>(undefined);

  useEffect(() => {
    setLoadedEntries(undefined);
  }, [project, tag, runId]);

  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <div className="grid gap-3"><Skeleton className="h-8 w-72" /><Skeleton className="h-96" /></div>;
  const run = q.data.runs.find(r => r.id === runId);
  const base = `/p/${encodeURIComponent(project)}/orders/${encodeURIComponent(tag)}`;
  if (!run) return <Empty>{t('No such run.')} <Link className="text-primary hover:underline" to={base}>{tag}</Link></Empty>;

  const live = !run.ended;
  const u = run.usage;
  const silentEnd = run.end && SILENT_END_KINDS.has(run.end.kind) ? run.end : undefined;
  const jsonStream = hasJsonStream(run, undefined, loadedEntries);
  const tab = resolveRunTab(params.get('tab'), jsonStream);

  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">
        <Link className="hover:underline" to={`/p/${encodeURIComponent(project)}/runs`}>{t('Runs')}</Link> / <Link className="hover:underline" to={base}>{tag}</Link> / {run.id}
      </div>
      <h1 className="mb-3 flex flex-wrap items-center gap-2.5 text-[22px] leading-tight font-semibold tracking-[-0.02em]">
        <span className="font-mono">{tag}</span>
        <span className="font-mono text-muted-foreground">{run.id}</span>
        <span className="text-base font-normal">{q.data.order.title}</span>
        <RunStatus {...run} /><StageBadge stage={q.data.stage} />
      </h1>
      {silentEnd && (
        <div role="alert" className="mb-3 rounded-md border border-destructive/40 border-l-[3px] border-l-destructive bg-destructive/8 px-3.5 py-2.5 text-sm">
          <div className="flex flex-wrap items-center gap-2 font-medium">
            <span>{t('Silent end')}</span>
            <Badge tone="danger">{silentEnd.kind}</Badge>
            <span className="font-normal">{silentEnd.detail}</span>
          </div>
          {silentEnd.wip_ref && (
            <div className="mt-1.5 text-xs text-muted-foreground">
              <span>{t('WIP snapshot')}: </span>
              <code className="font-mono text-foreground">{silentEnd.wip_ref}</code>
              {silentEnd.wip_files !== undefined && <span> ({silentEnd.wip_files} {t('files')})</span>}
              <span className="ml-2 font-mono">git show --stat {silentEnd.wip_ref}</span>
            </div>
          )}
        </div>
      )}
      <Card className="mb-3 flex flex-wrap gap-x-6 gap-y-2.5 p-3.5">
        {run.slot !== undefined && <Stat label={t('Slot')}>{run.slot}</Stat>}
        {run.ports && <Stat label={t('Port range')}><a className="text-primary hover:underline" href={`http://localhost:${run.ports.first}`} target="_blank" rel="noreferrer">{run.ports.first}</a>–{run.ports.last}</Stat>}
        <Stat label={t('Worker')}>{run.worker}</Stat>
        <Stat label={t('Started')}>{dateTime(run.started)}</Stat>
        <Stat label={t('Duration')}>{duration(run.started, run.ended)}</Stat>
        <Stat label={t('Outcome')}>
          {live ? (
            <Badge tone="primary">{t('running')}</Badge>
          ) : (
            <Badge tone={run.outcome === 'completed' ? 'success' : 'danger'}>
              {run.limit === 'unreachable' ? t('endpoint unreachable') : run.outcome}
            </Badge>
          )}
        </Stat>
        <Stat label={t('Usage')}><UsageText usage={u} /></Stat>
        {u.source !== 'unknown' && (u.input_tokens !== undefined || u.output_tokens !== undefined) && (
          <Stat label={t('In / out / cached')}>
            <span className="tabular-nums">{tokens(u.input_tokens)} / {tokens(u.output_tokens)} / {tokens(u.cached_tokens)}</span>
          </Stat>
        )}
        {u.turns !== undefined && <Stat label={t('Turns')}>{u.turns}</Stat>}
        {run.session && <Stat label={t('Session')}><span className="font-mono text-xs">{run.session}</span></Stat>}
        {run.attempt !== undefined && run.attempt > 1 && <Stat label={t('Attempt')}>{run.attempt}</Stat>}
      </Card>
      {run.note && (
        <div className="mb-3 rounded-md border-l-[3px] border-primary bg-primary/6 px-3 py-2 text-sm whitespace-pre-wrap">
          <span className="mr-2 text-xs text-muted-foreground">{t('Note it started with')}</span>
          {run.note}
        </div>
      )}
      <div className="my-3"><SectionBoundary title={t('Messages')}><MessageBox project={project} tag={tag} d={q.data} /></SectionBoundary></div>
      {run.consults && run.consults.length > 0 && (
        <div className="my-3">
          <SectionBoundary title={t('Consults')}>
            <Section title={t('Consults')} count={run.consults.length}>
              <div className="grid gap-2">
                {run.consults.map((c, idx) => (
                  <Card key={`${c.at}-${idx}`} className="p-3.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge tone={c.outcome === 'ok' ? 'success' : 'danger'}>{c.outcome}</Badge>
                      <span className="font-medium text-foreground">{c.consultant}</span>
                      {c.model && <span className="font-mono">{c.model}</span>}
                      <span>{dateTime(c.at)}</span>
                      <span className="tabular-nums">{c.seconds}s</span>
                      {c.usage && c.usage.source !== 'unknown' && <UsageText usage={c.usage} />}
                      {c.worktree_changed && <Badge tone="warning">{t('worktree modified')}</Badge>}
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap font-medium">{c.question}</p>
                    {c.files && c.files.length > 0 && (
                      <div className="mt-1 font-mono text-xs text-muted-foreground">{c.files.join(', ')}</div>
                    )}
                    {(c.answer || c.reason) && (
                      <details className="mt-2 rounded-md border bg-muted/30 px-3 py-2">
                        <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground">
                          {c.answer ? t('Answer ({n} chars)', { n: c.answer_length }) : t('Details')}
                        </summary>
                        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                          {c.answer ?? c.reason}
                        </pre>
                      </details>
                    )}
                  </Card>
                ))}
              </div>
            </Section>
          </SectionBoundary>
        </div>
      )}

      {!run.hasLog && !run.live ? (
        <Empty>{t('No log: this run was not started by the tool.')}</Empty>
      ) : (
        <Tabs
          value={tab}
          onValueChange={v =>
            setParams(
              p => {
                const n = new URLSearchParams(p);
                n.set('tab', v);
                return n;
              },
              { replace: true },
            )
          }
        >
          <TabsList>
            <TabsTrigger value="transcript">{t('Transcript')}</TabsTrigger>
            <TabsTrigger value="activity">{t('Activity')}</TabsTrigger>
            <TabsTrigger value="log">{t('Raw log')}</TabsTrigger>
          </TabsList>
          <TabsContent value="transcript"><SectionBoundary title={t('Transcript')}>
            {tab === 'transcript' &&
              (run.hasLog ? (
                <TranscriptView
                  project={project}
                  runKey={run.key}
                  live={live}
                  runUsage={u}
                  onLoadedEntries={setLoadedEntries}
                />
              ) : (
                <Empty>{t('No log: this run was not started by the tool.')}</Empty>
              ))}
          </SectionBoundary></TabsContent>
          <TabsContent value="activity"><SectionBoundary title={t('Activity')}>
            {run.live ? <LivePanel live={run.live} /> : <Empty>{t('No live activity recorded for this run.')}</Empty>}
          </SectionBoundary></TabsContent>
          <TabsContent value="log"><SectionBoundary title={t('Raw log')}>
            {tab === 'log' &&
              (run.hasLog ? (
                <LogViewer project={project} runKey={run.key} live={live} />
              ) : (
                <Empty>{t('No log: this run was not started by the tool.')}</Empty>
              ))}
          </SectionBoundary></TabsContent>
        </Tabs>
      )}
    </div>
  );
}
