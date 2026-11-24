import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Copy, Eraser, RefreshCw, TriangleAlert } from 'lucide-react';
import type { CleanItem } from '@api';
import { Badge, type Tone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/misc';
import { Empty, ErrorBox, PageHeader, Section, TagLink } from '@/components/common';
import { summarizePlan } from '@/lib/clean';
import { keys } from '@/lib/keys';
import { useCleanEvents, useCleanPlan, useProjectId } from '@/lib/queries';
import { ago, bytes, dateTime } from '@/lib/format';
import { ConfigPanel, JsonSettings, configKey, useEditToggle } from '@/components/ConfigSections';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';

const COMMAND = 'alba clean --apply';
const COMMAND_INCLUDE_IGNORED = 'alba clean --apply --include-ignored';
const actionTone: Record<CleanItem['action'], Tone> = { remove: 'danger', prune: 'warning', delete: 'danger', keep: 'neutral', skip: 'primary' };
const actionText = (a: CleanItem['action']) => ({ remove: t('remove'), prune: t('prune caches'), delete: t('delete'), keep: t('keep'), skip: t('skipped') })[a];
const kindText = (k: CleanItem['kind']) => (k === 'worktree' ? t('worktree') : k === 'build' ? t('build folder') : t('main checkout'));

function Row({ project, i }: { project: string; i: CleanItem }) {
  return (
    <tr className="align-top hover:bg-accent/40">
      <td className="px-4 py-2 whitespace-nowrap"><Badge tone={actionTone[i.action]}>{actionText(i.action)}</Badge></td>
      <td className="max-w-md px-2 py-2">
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"><span>{kindText(i.kind)}</span>{i.tag && <TagLink project={project} tag={i.tag} className="text-xs" />}{i.branch && <span className="font-mono">{i.branch}</span>}</div>
        <div className="font-mono text-xs break-all" title={i.path}>{i.path}</div>
        {i.targets.length > 0 && <div className="mt-0.5 text-xs text-muted-foreground">{t('deletes')}: <span className="font-mono">{i.targets.join(', ')}</span></div>}
        {i.links > 0 && <div className="mt-0.5 text-xs text-muted-foreground">{t('{n} junctions or links are taken apart first', { n: i.links })}</div>}
        {i.atRiskIgnored && i.atRiskIgnored.count > 0 && (
          <div className="mt-0.5 text-xs text-warning">
            {t('{n} non-regenerable ignored path(s):', { n: i.atRiskIgnored.count })}{' '}
            <span className="font-mono">{i.atRiskIgnored.paths.join(', ')}{i.atRiskIgnored.count > i.atRiskIgnored.paths.length ? ` (+${i.atRiskIgnored.count - i.atRiskIgnored.paths.length})` : ''}</span>
          </div>
        )}
      </td>
      <td className="px-2 py-2 text-sm">{i.reason}{i.result && <div className="mt-0.5 text-xs text-success">{i.result}</div>}</td>
      <td className="px-4 py-2 text-right whitespace-nowrap tabular-nums">{i.bytes !== undefined ? bytes(i.bytes) : i.measuredBytes ? t('≥ {size} measured', { size: bytes(i.measuredBytes) }) : t('Size unknown')}</td>
    </tr>
  );
}

function Table({ project, items }: { project: string; items: CleanItem[] }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[44rem] text-sm">
        <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="px-4 py-1.5 font-medium">{t('Action')}</th><th className="px-2 py-1.5 font-medium">{t('What')}</th><th className="px-2 py-1.5 font-medium">{t('Why')}</th><th className="px-4 py-1.5 text-right font-medium">{t('Size')}</th></tr></thead>
        <tbody className="divide-y">{items.map(i => <Row key={i.path + i.action} project={project} i={i} />)}</tbody>
      </table>
    </Card>
  );
}

/** The step before applying: nothing is deleted from the page. The page shows the command and asks twice before it hands it over. */
function ApplyDialog({ open, onOpenChange, count, size, includeIgnored, atRiskWorktrees }: { open: boolean; onOpenChange: (o: boolean) => void; count: number; size: string; includeIgnored: boolean; atRiskWorktrees: number }) {
  const [read, setRead] = useState(false);
  const [confirmedIgnored, setConfirmedIgnored] = useState(false);
  const [copied, setCopied] = useState(false);
  const needsIgnoredConfirm = includeIgnored && atRiskWorktrees > 0;
  const command = includeIgnored ? COMMAND_INCLUDE_IGNORED : COMMAND;
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); setCopied(true); toast.success(t('Command copied')); } catch { toast.error(t('Could not copy: select the command and copy it by hand')); }
  };
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) { setRead(false); setConfirmedIgnored(false); setCopied(false); } onOpenChange(o); }}>
      <DialogContent>
        <DialogTitle>{t('Apply the plan?')}</DialogTitle>
        <DialogDescription>{t('The board never deletes. Applying is a command you run yourself, in the project’s folder, with the same settings the board was started with.')}</DialogDescription>
        <div className="rounded-md border-l-2 border-destructive bg-muted px-3 py-2 text-sm">{t('{n} items would be changed, about {size} freed. Removed worktrees and merged branches cannot be brought back.', { n: count, size })}</div>
        {needsIgnoredConfirm && (
          <div className="rounded-md border border-warning/60 bg-warning/10 px-3 py-2 text-sm">
            {t('{n} worktree(s) contain ignored files that cannot be regenerated and will be deleted.', { n: atRiskWorktrees })}
          </div>
        )}
        <pre className="overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-sm">{command}</pre>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={read} onChange={e => setRead(e.target.checked)} className="mt-1 size-4 accent-[var(--primary)]" />{t('I have read the plan and know what it removes.')}</label>
        {needsIgnoredConfirm && (
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmedIgnored} onChange={e => setConfirmedIgnored(e.target.checked)} className="mt-1 size-4 accent-[var(--primary)]" />{t('I confirm removing worktrees that contain non-regenerable ignored files.')}</label>
        )}
        <p className="text-xs text-muted-foreground">{t('When it has run, the events of the clean appear below on this page.')}</p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('Back')}</Button>
          <Button variant="destructive" disabled={!read || (needsIgnoredConfirm && !confirmedIgnored)} onClick={() => void copy()}>{copied ? <Check /> : <Copy />}{t('Copy the command')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What `alba clean` would do: read only. */
export function CleanPage() {
  const project = useProjectId();
  const [editing, editButton] = useEditToggle();
  const client = useQueryClient();
  const [includeIgnored, setIncludeIgnored] = useState(false);
  const q = useCleanPlan(project, includeIgnored);
  const events = useCleanEvents(project);
  const [apply, setApply] = useState(false);

  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <div className="grid gap-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-48" /></div>;
  const s = summarizePlan(q.data);
  const hasAtRisk = q.data.items.some(i => (i.atRiskIgnored?.count ?? 0) > 0);
  const atRiskRemoving = s.removing.filter(i => (i.atRiskIgnored?.count ?? 0) > 0).length;
  return (
    <div>
      <PageHeader
        title={t('Clean')} count={s.removing.length}
        actions={<>
          {(hasAtRisk || includeIgnored) && (
            <label className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs">
              <input type="checkbox" checked={includeIgnored} onChange={e => setIncludeIgnored(e.target.checked)} className="size-3.5 accent-[var(--primary)]" />
              {t('Include non-regenerable ignored files')}
            </label>
          )}
          <Button variant="outline" onClick={() => { void client.invalidateQueries({ queryKey: keys.clean(project, includeIgnored) }); void client.invalidateQueries({ queryKey: keys.cleanEvents(project) }); }}><RefreshCw />{t('Read again')}</Button>{editButton}</>}
      >
        {t('The plan of `alba clean`, read only. Worked out {when}.', { when: ago(q.data.at) })}
      </PageHeader>
      {editing && <ConfigPanel project={project}>{view => <JsonSettings key={configKey(view, ['clean'])} project={project} view={view} path={['clean']} title={t('Clean')} description={t('What alba clean may remove, and how much it keeps.')} />}</ConfigPanel>}

      {q.data.errors.length > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-sm"><TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" /><div><div className="font-medium">{t('The plan is cautious because:')}</div><ul className="list-disc pl-4">{q.data.errors.map((e, i) => <li key={i}>{e}</li>)}</ul></div></div>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Card className="p-3.5"><div className="text-xs text-muted-foreground">{t('Would be changed')}</div><div className="text-xl font-semibold tabular-nums">{s.removing.length}</div></Card>
        <Card className="p-3.5"><div className="text-xs text-muted-foreground">{t('Would be freed')}</div><div className="text-xl font-semibold tabular-nums">{s.unknown > 0 ? s.bytes > 0 ? t('≥ {size} measured', { size: bytes(s.bytes) }) : t('Size unknown') : bytes(s.bytes)}</div></Card>
        <Card className="p-3.5"><div className="text-xs text-muted-foreground">{t('Left alone')}</div><div className="text-xl font-semibold tabular-nums">{s.leaving.length}</div></Card>
      </div>

      <Section title={<><Eraser className="size-4" />{t('Would be removed')}</>} count={s.removing.length} actions={s.removing.length > 0 ? <Button size="sm" variant="destructive" onClick={() => setApply(true)}>{t('Apply…')}</Button> : undefined}>
        {s.removing.length === 0 ? <Empty>{t('Nothing to clean.')}</Empty> : <Table project={project} items={s.removing} />}
      </Section>

      <Section title={t('Left alone, and why')} count={s.leaving.length}>
        {s.leaving.length === 0 ? <Empty>{t('Nothing was skipped.')}</Empty> : <Table project={project} items={s.leaving} />}
      </Section>

      <Section title={t('Events of earlier cleans')} count={events.data?.length}>
        {!events.data ? <Skeleton className="h-16" /> : events.data.length === 0 ? <Empty>{t('No clean has run yet.')}</Empty> : (
          <Card className="divide-y">
            {events.data.slice(0, 50).map(e => (
              <div key={e.id} className={cn('flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2 text-sm')}>
                <span className="font-medium">{e.type}</span>
                {e.tag && <TagLink project={project} tag={e.tag} className="text-xs" />}
                <span className="text-xs text-muted-foreground" title={dateTime(e.at)}>{ago(e.at)}</span>
                {e.data && <span className="min-w-0 font-mono text-xs break-all text-muted-foreground">{Object.entries(e.data).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('  ')}</span>}
              </div>
            ))}
          </Card>
        )}
      </Section>
      <ApplyDialog open={apply} onOpenChange={setApply} count={s.removing.length} size={s.unknown ? s.bytes ? t('≥ {size} measured', { size: bytes(s.bytes) }) : t('Size unknown') : bytes(s.bytes)} includeIgnored={includeIgnored} atRiskWorktrees={atRiskRemoving} />
    </div>
  );
}
