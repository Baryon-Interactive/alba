import { useState } from 'react';
import type { ChildSummary, OrderDetail } from '@api';
import { TagLink, StageBadge, Section, ErrorBox } from './common';
import { Button } from './ui/button';
import { Input, Textarea } from './ui/input';
import { useAct } from '@/lib/queries';
import { t } from '@/i18n';

export function ChildList({ project, children }: { project: string; children: ChildSummary[] }) {
  return <ul className="grid gap-2 text-sm">{children.map(child => <li key={child.tag} className="flex flex-wrap items-center gap-2">
    <TagLink project={project} tag={child.tag} /><span className="break-words">{child.title}</span><StageBadge stage={child.stage} />
    <span className="text-muted-foreground">{[child.worker, child.model].filter(Boolean).join(' / ')}</span>
  </li>)}</ul>;
}

function SplitCard({ project, tag, split }: { project: string; tag: string; split: NonNullable<OrderDetail['split']> }) {
  const act = useAct(project);
  const [rows, setRows] = useState(split.subtasks.map(task => ({ ...task, keep: true })));
  const [note, setNote] = useState('');
  const kept = rows.filter(row => row.keep);
  return <Section title={t('Proposed child orders')}>
    <div className="grid gap-3 rounded-lg border p-4">
      {rows.map((row, index) => {
        const update = (patch: Partial<typeof row>) => setRows(old => old.map((r, i) => i === index ? { ...r, ...patch } : r));
        return <fieldset key={row.key} className="grid gap-2 rounded border p-2">
          <legend><label><input type="checkbox" checked={row.keep} onChange={e => update({ keep: e.target.checked })} /> {row.key}</label></legend>
          <label>{t('Title')}<Input value={row.title} disabled={!row.keep} onChange={e => update({ title: e.target.value })} /></label>
          <label>{t('Kind')}<Input value={row.kind} disabled={!row.keep} onChange={e => update({ kind: e.target.value })} /></label>
          <div>{t('Needs')}: {row.needs?.filter(key => kept.some(r => r.key === key)).join(', ') || '?'}</div>
          <details><summary>{t('Work order')}</summary><pre className="whitespace-pre-wrap break-words">{row.body}</pre></details>
        </fieldset>;
      })}
      <Button disabled={act.isPending || kept.length < 2 || kept.some(r => !r.title.trim() || !r.kind.trim())}
        onClick={() => act.mutate({ tag, action: 'accept-split', report: split.report, edits: kept.map(({ key, title, kind }) => ({ key, title, kind })) })}>{t('Accept split')}</Button>
      <label>{t('Note for the next run (required)')}<Textarea value={note} onChange={e => setNote(e.target.value)} /></label>
      <Button variant="outline" disabled={act.isPending || !note.trim()} onClick={() => act.mutate({ tag, action: 'rework', report: split.report, note })}>{t('Send back for rework')}</Button>
      {act.isError && <ErrorBox error={act.error} />}
    </div>
  </Section>;
}

export function SplitOrders({ project, detail }: { project: string; detail: OrderDetail }) {
  return <>
    {detail.parent && <p>{t('Parent order')} <TagLink project={project} tag={detail.parent} /></p>}
    {detail.children?.length ? <Section title={t('Child orders')}><ChildList project={project} children={detail.children} /></Section> : null}
    {detail.split?.pending && <SplitCard key={detail.order.tag + ':' + detail.split.report} project={project} tag={detail.order.tag} split={detail.split} />}
  </>;
}
