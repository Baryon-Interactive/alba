import { useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowRightLeft, Ban, CircleCheck, CircleDollarSign, Copy, CreditCard, Link2, Pencil, Plus, Server, Trash2 } from 'lucide-react';
import type { QuotaPoint, Worker } from '@api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress, Skeleton } from '@/components/ui/misc';
import { Empty, ErrorBox, PageHeader, Section } from '@/components/common';
import { QuoteCard } from '@/components/QuoteCard';
import { ResourcesSection } from '@/components/Monitoring';
import { ExternalUsageSection } from '@/components/library/ExternalUsage';
import { NewWorkerDialog, RemoveWorkerDialog, WorkerEditDialog } from '@/components/WorkerEdit';
import { useCredits, useProjectId, useQuotaHistory, useWorkers } from '@/lib/queries';
import { totalsByUnit } from '@/lib/spend';
import { dateTime, usd } from '@/lib/format';
import { groupByQuota, sameModelNote } from '@/lib/workers';
import { ConfigPanel, JsonSettings, ResourceSettings, configKey, useEditToggle } from '@/components/ConfigSections';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';

function windowTone(p: number) { return p >= 90 ? 'bad' : p >= 70 ? 'warn' : 'ok'; }

function WindowBars({ quota }: { quota?: QuotaPoint }) {
  if (!quota) return <span className="text-xs text-muted-foreground">{t('no quota source')}</span>;
  if (!quota.ok) return <Badge tone="danger">{t('quota unreadable')}</Badge>;
  return (
    <div className="grid gap-1.5">
      {quota.windows.map(w => (
        <div key={w.name}>
          <div className="mb-0.5 flex justify-between text-xs"><span className="font-medium">{w.name}</span><span className="tabular-nums text-muted-foreground">{Math.round(w.usedPercent)}%{w.resetsAt ? ` · ${t('resets {when}', { when: dateTime(w.resetsAt) })}` : ''}</span></div>
          <Progress value={w.usedPercent} tone={windowTone(w.usedPercent)} />
        </div>
      ))}
      {quota.windows.length === 0 && quota.note && <div className="text-xs text-muted-foreground">{quota.note}</div>}
      {quota.balance && <div className="text-sm"><span className="text-muted-foreground">{t('Balance')}:</span> <span className="font-medium tabular-nums">{quota.balance.raw}</span></div>}
    </div>
  );
}

function History({ project, worker }: { project: string; worker: Worker }) {
  const q = useQuotaHistory(project, worker.id);
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <Skeleton className="h-44" />;
  const points = q.data.points.filter(p => p.ok);
  const hasBalance = points.some(p => p.balance?.amount !== undefined);
  const names = [...new Set(points.flatMap(p => p.windows.map(w => w.name)))];
  if (points.length < 2) return <div className="py-6 text-center text-xs text-muted-foreground">{t('Nothing recorded yet. Each tick that records adds one reading.')}</div>;
  const data = points.map(p => ({ at: Date.parse(p.at), balance: p.balance?.amount, ...Object.fromEntries(p.windows.map(w => [w.name, Math.round(w.usedPercent)])) }));
  const colors = ['var(--primary)', 'var(--warning)', 'var(--success)'];
  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="at" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={v => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })} stroke="var(--muted-foreground)" fontSize={11} tickLine={false} />
          <YAxis stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} domain={hasBalance ? ['auto', 'auto'] : [0, 100]} unit={hasBalance ? '' : '%'} />
          <Tooltip contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} labelFormatter={v => dateTime(new Date(v as number).toISOString())} />
          {hasBalance
            ? <Line type="monotone" dataKey="balance" name={t('Balance')} stroke={colors[0]} dot={false} strokeWidth={2} isAnimationActive={false} />
            : names.map((n, i) => <Line key={n} type="monotone" dataKey={n} name={n} stroke={colors[i % colors.length]} dot={false} strokeWidth={2} isAnimationActive={false} />)}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SupplyDetails({ w }: { w: Worker }) {
  return <div className="grid gap-2 border-t pt-2.5">
    <div className="flex flex-wrap gap-1.5"><span className="text-xs text-muted-foreground">{t('Capabilities')}:</span>{w.capabilities.map(c => <Badge key={c} tone="outline">{c}</Badge>)}</div>
    {w.model && <p className="text-sm">{t('Model')}: {w.model}</p>}
    {w.maxTokensPerRun && <p className="text-xs">{t('Tokens per run')}: {w.maxTokensPerRun.toLocaleString()}</p>}
    {w.notes && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{w.notes}</p>}
  </div>;
}

function WorkerCard({ project, w, onEdit, onCopy, onRemove }: { project: string; w: Worker; onEdit: (w: Worker) => void; onCopy: (w: Worker) => void; onRemove: (w: Worker) => void }) {
  const [open, setOpen] = useState(false);
  const state = !w.enabled ? <Badge tone="neutral"><Ban />{t('turned off')}</Badge>
    : w.available ? <Badge tone="success"><CircleCheck />{t('available')}</Badge>
    : <Badge tone="danger"><Ban />{t('not available')}</Badge>;
  return (
    <Card id={w.id}>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2"><span className="text-[15px] font-semibold">{w.id}</span>{state}<Button variant="ghost" size="icon" className="size-7" aria-label={t('Edit {id}', { id: w.id })} title={t('Edit')} onClick={() => onEdit(w)}><Pencil className="size-3.5" /></Button><Button variant="ghost" size="icon" className="size-7" aria-label={t('Copy {id}', { id: w.id })} title={t('Copy as a new worker')} onClick={() => onCopy(w)}><Copy className="size-3.5" /></Button><Button variant="ghost" size="icon" className="size-7" aria-label={t('Remove {id}', { id: w.id })} title={t('Remove from the workers file')} onClick={() => onRemove(w)}><Trash2 className="size-3.5" /></Button></div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>{w.engine}</span>{w.route && <span>· {w.route}</span>}
              {w.host && <Badge tone="primary" title={t('Runs on {host} over SSH', { host: w.host })}><Server />{w.host}</Badge>}
              {w.paid && <Badge tone="warning"><CreditCard />{t('paid')}</Badge>}
              {w.cost === 'included' && <Badge tone="success">{t('included in a plan')}</Badge>}
              {w.cardOnly && <Badge tone="outline">{t('cards only')}</Badge>}
              {w.canResume && <Badge tone="outline">{t('can resume')}</Badge>}
              {w.onLimit === 'rotate' && <Badge tone="primary" title={t('When its usage runs out, the order is handed to another worker')}><ArrowRightLeft />{t('hands over when out')}</Badge>}
              {w.rotatePaid && <Badge tone="warning" title={t('A capacity or quota ending may hand the order to a paid worker')}>{t('paid hand-over')}</Badge>}
              {w.modelFamily && <Badge tone="neutral" title={sameModelNote(w)}>{w.modelFamily}</Badge>}
              {w.sameModelAs.length > 0 && <Badge tone="warning" title={sameModelNote(w)}>{t('same model, different shell')}</Badge>}
              {!w.hasLaunch && !w.cardOnly && <Badge tone="danger" title={t('alba has no way to start it: it is not chosen')}>{t('no launch template')}</Badge>}
            </div>
          </div>
          <div className="flex gap-6 text-right">
            <div><div className="text-xs text-muted-foreground">{t('Running')}</div><div className="text-lg font-semibold tabular-nums">{w.cardOnly ? '–' : `${w.running}/${w.concurrency}`}</div></div>
            <div><div className="text-xs text-muted-foreground">{t('Runs today')}</div><div className="text-lg font-semibold tabular-nums">{w.runsToday}{w.dailyRuns !== undefined ? <span className="text-sm text-muted-foreground"> / {w.dailyRuns}</span> : null}</div></div>
            <div><div className="text-xs text-muted-foreground">{t('Spend today')}</div><div className={cn('text-lg font-semibold tabular-nums', w.overCap && 'text-destructive')}>{spendUnknown(w) ? <span className="text-muted-foreground">{t('unknown')}</span> : usd(w.spendTodayUsd)}{w.dailyCapUsd !== undefined ? <span className="text-sm text-muted-foreground"> / {usd(w.dailyCapUsd)}</span> : null}</div></div>
          </div>
        </div>
        <SupplyDetails w={w} />
        {w.enabled && !w.available && w.reasons.length > 0 && <div className="rounded-md bg-destructive/8 px-2.5 py-1.5 text-xs text-destructive">{w.reasons.join('; ')}</div>}
        {w.overCap && <div className="rounded-md bg-warning/15 px-2.5 py-1.5 text-xs">{t('The daily spend cap is reached: the tick starts nothing on this worker.')}</div>}
        <WindowBars quota={w.quota} />
        {w.price && <div className="text-xs text-muted-foreground">{t('Price per million tokens')}: {[w.price.input_per_mtok !== undefined && `${t('input')} $${w.price.input_per_mtok}`, w.price.output_per_mtok !== undefined && `${t('output')} $${w.price.output_per_mtok}`, w.price.per_mtok !== undefined && `$${w.price.per_mtok}`].filter(Boolean).join(' · ')} ({t('used for estimates')})</div>}
        {w.quota && <div><button className="text-xs text-primary hover:underline" onClick={() => setOpen(o => !o)}>{open ? t('Hide history') : t('Show quota history')}</button>{open && <History project={project} worker={w} />}</div>}
      </CardContent>
    </Card>
  );
}

/** Quotes for paid resources on all orders: what was asked, what is allowed, what was spent. Units are never added together. */
function QuotesSection({ project }: { project: string }) {
  const q = useCredits(project);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  if (q.isError) return <Section title={t('Quotes for paid resources')}><ErrorBox error={q.error} /></Section>;
  if (!q.data) return <Section title={t('Quotes for paid resources')}><Skeleton className="h-24" /></Section>;
  const items = q.data.items;
  if (items.length === 0) return null;
  const totals = totalsByUnit(items);
  const shown = [...(filter === 'open' ? items.filter(x => x.status !== 'rejected') : items)].sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.created.localeCompare(a.created));
  return (
    <Section
      title={<><CircleDollarSign className="size-4" />{t('Quotes for paid resources')}</>} count={shown.length}
      actions={<button className="text-xs text-primary hover:underline" onClick={() => setFilter(f => (f === 'open' ? 'all' : 'open'))}>{filter === 'open' ? t('Show rejected too') : t('Hide rejected')}</button>}
    >
      <div className="mb-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {totals.map(u => (
          <Card key={u.unit} className="p-3.5">
            <div className="text-xs text-muted-foreground">{u.unit}</div>
            <div className="text-lg font-semibold tabular-nums">{u.spent} <span className="text-sm font-normal text-muted-foreground">/ {u.approved} {t('approved')}</span></div>
            {u.pending > 0 && <div className="text-xs text-warning">{t('{n} waiting for approval', { n: u.pending })}</div>}
          </Card>
        ))}
      </div>
      <div className="grid gap-3 xl:grid-cols-2">{shown.map(x => <QuoteCard key={x.tag + x.id} project={project} quote={x} />)}</div>
    </Section>
  );
}

/** Runs happened but no cost came out of them (the engine printed none and there is no price): that is unknown, not $0. */
const spendUnknown = (w: { spendTodayUsd: number; runsToday: number; price?: unknown }) => w.spendTodayUsd === 0 && w.runsToday > 0 && !w.price;

export function WorkersPage() {
  const project = useProjectId();
  const [editingConfig, editButton] = useEditToggle();
  const q = useWorkers(project);
  const [editing, setEditing] = useState<string | undefined>();
  const [copying, setCopying] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | undefined>();
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <div className="grid gap-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-40" /><Skeleton className="h-40" /></div>;
  const workers = q.data.workers;
  const totalSpend = workers.reduce((n, w) => n + w.spendTodayUsd, 0);
  const card = (w: Worker) => <WorkerCard key={w.id} project={project} w={w} onEdit={x => setEditing(x.id)} onCopy={x => { setCopying(x.id); setAdding(true); }} onRemove={x => setRemoving(x.id)} />;
  const editingWorker = workers.find(w => w.id === editing);
  return (
    <div>
      <PageHeader title={t('Workers')} count={workers.length} actions={<><Button variant="outline" onClick={() => { setCopying(undefined); setAdding(true); }}><Plus />{t('New worker')}</Button>{editButton}</>}>{t('{n} runs and {cost} today', { n: workers.reduce((n, w) => n + w.runsToday, 0), cost: totalSpend === 0 && workers.some(spendUnknown) ? t('unknown') : usd(totalSpend) })}</PageHeader>
      {editingConfig && <>
        <ConfigPanel project={project}>{view => <ResourceSettings key={configKey(view, ['resources'])} project={project} values={view.values} />}</ConfigPanel>
        <ConfigPanel project={project} target="workers">{view => <JsonSettings key={configKey(view, ['quota_sources'])} project={project} view={view} path={['quota_sources']} title={t('Quota sources')} description={t('Where the usage windows and balances of the workers are read from.')} />}</ConfigPanel>
      </>}
      {workers.length === 0 ? <Empty>{t('No workers file was given (--workers or ALBA_WORKERS).')}</Empty> : (
        <Section title={t('Registry')}>
          {groupByQuota(workers).map(g => g.source ? (
            <div key={g.source} className="mb-4 rounded-xl border border-warning/40 bg-warning/5 p-3">
              <div className="mb-2.5 flex flex-wrap items-center gap-2 text-sm"><Link2 className="size-4 text-warning" /><span className="font-medium">{g.source}</span><Badge tone="warning">{t('same subscription quota')}</Badge><span className="text-xs text-muted-foreground">{t('These workers draw on one limit: runs on both at once use it up twice as fast.')}</span></div>
              <div className="grid gap-3 xl:grid-cols-2">{g.workers.map(card)}</div>
            </div>
          ) : <div key="own" className="grid gap-3 xl:grid-cols-2">{g.workers.map(card)}</div>)}
        </Section>
      )}
      <ResourcesSection />
      <QuotesSection project={project} />
      <ExternalUsageSection project={project} />
      {editingWorker && <WorkerEditDialog project={project} worker={editingWorker} kinds={[]} open onOpenChange={o => { if (!o) setEditing(undefined); }} />}
      {removing && <RemoveWorkerDialog project={project} id={removing} open onOpenChange={o => { if (!o) setRemoving(undefined); }} />}
      <NewWorkerDialog project={project} workers={workers} copyFrom={copying} open={adding} onOpenChange={o => { setAdding(o); if (!o) setCopying(undefined); }} />
      {q.data.sources.length > 0 && (
        <Section title={t('Quota sources')} count={q.data.sources.length}>
          <Card className="divide-y">
            {q.data.sources.map(s => (
              <div key={s.source} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
                <span className="w-36 font-medium">{s.source}</span>
                <span className="text-xs text-muted-foreground">{s.latest ? dateTime(s.latest.at) : t('never read')}</span>
                <span className="text-xs">{s.latest?.balance?.raw}</span>
                <span className="text-xs text-muted-foreground">{s.latest?.windows.map(w => `${w.name} ${Math.round(w.usedPercent)}%`).join(' · ')}</span>
              </div>
            ))}
          </Card>
        </Section>
      )}
    </div>
  );
}
