import { useState, type ReactNode } from 'react';
import { Link, NavLink, useParams, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/misc';
import { Empty, ErrorBox, PageHeader, TagLink } from '@/components/common';
import { DesignEdit } from '@/components/DesignEdit';
import { useDecisions, useProjectId } from '@/lib/queries';
import { useDesign, useDesignStale, useMeasureNow } from '@/lib/design-queries';
import { idOf, liveParams, outside, paramsCsv, searchEntities, systemHistory, systemStats, targetState, type DesignBundle, type DesignKind, type Entity, type LiveParam, type Rule, type StaleSystem } from '@/lib/design';
import { t } from '@/i18n';

const baseOf = (project: string) => `/p/${encodeURIComponent(project)}/design`;
const labels: Record<DesignKind, string> = { system: 'Systems', rule: 'Rules', formula: 'Formulas', param: 'Params', target: 'Targets', gap: 'Gaps', milestone: 'Milestones', term: 'Terms', decision_link: 'Decision links' };
const tabs: [string, DesignKind | 'history'][] = [['Rules', 'rule'], ['Formulas', 'formula'], ['Params', 'param'], ['Targets', 'target'], ['Gaps', 'gap'], ['Decisions', 'decision_link'], ['History', 'history']];
export function DesignState({ value }: { value: string }) {
  return <Badge tone={['failing', 'retired'].includes(value) ? 'danger' : ['passing', 'done'].includes(value) ? 'success' : ['partial', 'prototype', 'active', 'stale'].includes(value) ? 'warning' : 'neutral'}>{t(value)}</Badge>;
}
function DesignNav({ project }: { project: string }) {
  return <nav aria-label={t('Design')} className="mb-5 flex gap-1 border-b pb-2">{[['', 'Systems'], ['/milestones', 'Milestones'], ['/terms', 'Terms']].map(([path, text]) => <NavLink key={path} end={path === ''} to={baseOf(project) + path} className={({ isActive }) => `rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-primary/10 font-semibold text-primary' : 'text-muted-foreground hover:bg-accent'}`}>{t(text)}</NavLink>)}</nav>;
}
function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return <Card className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b bg-muted/30"><tr>{headers.map((h, i) => <th key={i} className="px-3 py-2 text-xs font-medium whitespace-nowrap text-muted-foreground">{t(h)}</th>)}</tr></thead><tbody className="divide-y [&_td]:px-3 [&_td]:py-3 [&_td]:align-top">{children}</tbody></table></Card>;
}
function DecisionRef({ project, id }: { project: string; id: string }) { const ledger = useDecisions(project); const label = ledger.data?.items.find(d => d.id === id)?.displayId ?? id; return <Link className="text-primary hover:underline" to={`/p/${encodeURIComponent(project)}/decisions?query=${encodeURIComponent(id)}`}>{label}</Link>; }
function EntityRef({ project, data, id }: { project: string; data: DesignBundle; id: string }) {
  const hit = searchEntities(data, id).find(h => idOf(h.kind, h.row) === id);
  if (!hit) return <span className="font-mono text-xs">{id}</span>;
  const row = hit.row;
  const system = 'system' in row ? row.system : hit.kind === 'system' ? id : null;
  const to = hit.kind === 'term' ? `${baseOf(project)}/terms` : hit.kind === 'milestone' ? `${baseOf(project)}/milestones` : system ? `${baseOf(project)}/${encodeURIComponent(system)}?tab=${hit.kind}#${encodeURIComponent(id)}` : baseOf(project);
  return <Link className="font-mono text-xs text-primary hover:underline" to={to}>{id}</Link>;
}
function Refs({ ids, project, data }: { ids: string[]; project: string; data: DesignBundle }) { return <div className="flex flex-wrap gap-x-2 gap-y-1">{ids.map(id => <EntityRef key={id} project={project} data={data} id={id} />)}</div>; }
function Evidence({ items, project }: { items: { kind: string; ref: string }[]; project: string }) { return <div className="grid gap-1 text-xs">{items.map((e, i) => <div key={i}>{e.kind === 'order' || e.kind === 'report' ? <TagLink project={project} tag={e.ref.split('#')[0]} /> : <span className="font-mono break-all">{e.ref}</span>}</div>)}</div>; }
function RuleBar({ counts }: { counts: ReturnType<typeof systemStats>['rules'] }) {
  const total = counts.done + counts.partial + counts.none;
  return <div className="min-w-28"><div aria-label={t('Rules: {done} done, {partial} partial, {none} none', counts)} className="mb-1 flex h-1.5 overflow-hidden rounded bg-muted">{(['done', 'partial', 'none'] as const).map((key, i) => <span key={key} className={['bg-success', 'bg-warning', 'bg-muted-foreground/40'][i]} style={{ width: `${total ? counts[key] / total * 100 : 0}%` }} />)}</div><div className="text-[11px] tabular-nums text-muted-foreground">{counts.done} / {counts.partial} / {counts.none}</div></div>;
}
type Edit = (kind: DesignKind, row?: Entity, retire?: boolean) => void;
function EditButton({ kind, row, edit }: { kind: DesignKind; row: Entity; edit: Edit }) { return <Button size="sm" variant="ghost" aria-label={t('Edit {id}', { id: idOf(kind, row) })} onClick={() => edit(kind, row)}>{t('Edit')}</Button>; }

export function SystemsList({ data, project, stale, edit }: { data: DesignBundle; project: string; stale: StaleSystem[]; edit: Edit }) {
  const [query, setQuery] = useState(''), [status, setStatus] = useState(''), [filter, setFilter] = useState(''), [sort, setSort] = useState('code');
  const hits = searchEntities(data, query);
  const rows = data.system.filter(s => {
    const stats = systemStats(data, s.code);
    return (!status || s.status === status) && (!filter || (filter === 'failing' ? stats.failing > 0 : stats.unassigned > 0)) && (!query.trim() || hits.some(h => h.kind === 'system' && idOf(h.kind, h.row) === s.code || 'system' in h.row && h.row.system === s.code || h.kind === 'decision_link' && data.decision_link.some(l => l === h.row && data[l.kind].some(e => idOf(l.kind, e) === l.entity && 'system' in e && e.system === s.code))));
  }).sort((a, b) => {
    if (sort === 'failing' || sort === 'unassigned') return systemStats(data, b.code)[sort] - systemStats(data, a.code)[sort] || a.code.localeCompare(b.code);
    return (sort === 'status' ? a.status.localeCompare(b.status) : sort === 'name' ? a.name.localeCompare(b.name) : a.code.localeCompare(b.code));
  });
  return <><PageHeader title={t('Systems')} count={data.system.length} actions={<Button onClick={() => edit('system')}>{t('New system')}</Button>}>{t('Rules, live values and delivery gaps across the game.')}</PageHeader>
    <div className="mb-4 flex flex-wrap gap-2"><Input aria-label={t('Search all design entities')} placeholder={t('Search all design entities')} className="max-w-sm" value={query} onChange={e => setQuery(e.target.value)} /><Select aria-label={t('Status')} className="w-40" value={status} onChange={e => setStatus(e.target.value)}><option value="">{t('Any status')}</option>{['not-started', 'prototype', 'playable', 'done'].map(v => <option key={v} value={v}>{t(v)}</option>)}</Select><Select aria-label={t('Filter')} className="w-52" value={filter} onChange={e => setFilter(e.target.value)}><option value="">{t('All systems')}</option><option value="failing">{t('Failing targets')}</option><option value="unassigned">{t('Open gaps without order')}</option></Select><Select aria-label={t('Sort')} className="w-44" value={sort} onChange={e => setSort(e.target.value)}>{[['code', 'Code'], ['name', 'Name'], ['status', 'Status'], ['failing', 'Failing targets'], ['unassigned', 'Open gaps without order']].map(([v, label]) => <option key={v} value={v}>{t(label)}</option>)}</Select></div>
    {rows.length ? <Table headers={['System', 'Status', 'Rules · done / partial / none', 'Formulas', 'Params', 'Targets · pass / fail / unmeasured', 'Gaps · with / without order', 'Verified date', '']}>
      {rows.map(s => { const n = systemStats(data, s.code); return <tr key={s.code}><td><Link to={`${baseOf(project)}/${encodeURIComponent(s.code)}`} className="font-semibold text-primary hover:underline">{s.code}</Link><div className="mt-0.5 font-medium">{s.name}</div></td><td><DesignState value={s.status} />{stale.some(x => x.system === s.code) && <div className="mt-1"><DesignState value="stale" /></div>}</td><td><RuleBar counts={n.rules} /></td><td>{n.formulas}</td><td>{n.params}</td><td><span className="text-success">{n.passing}</span> / <span className={n.failing ? 'font-bold text-destructive' : ''}>{n.failing}</span> / {n.unmeasured}</td><td>{n.assigned} / <span className={n.unassigned ? 'font-bold text-warning' : ''}>{n.unassigned}</span></td><td className="whitespace-nowrap text-xs text-muted-foreground">{s.verified_at?.slice(0, 10) ?? t('Unverified')}</td><td><EditButton kind="system" row={s} edit={edit} /></td></tr>; })}
    </Table> : <Empty>{t('No design entities match.')}</Empty>}
    {query.trim() && <div className="mt-5"><h2 className="mb-2 text-sm font-semibold">{t('Search results')} ({hits.length})</h2><div className="grid gap-2">{hits.map(h => <Card key={`${h.kind}:${idOf(h.kind, h.row)}`} className="flex items-start justify-between gap-3 p-3"><div><span className="mr-2 text-xs text-muted-foreground">{t(labels[h.kind])}</span><EntityRef project={project} data={data} id={idOf(h.kind, h.row)} /><p className="mt-1 text-sm">{'meaning' in h.row ? h.row.meaning : 'text' in h.row ? h.row.text : 'name' in h.row ? h.row.name : 'metric' in h.row ? h.row.metric : 'expression' in h.row ? h.row.expression : ''}</p></div><EditButton kind={h.kind} row={h.row} edit={edit} /></Card>)}</div></div>}
  </>;
}

export function ParamsTable({ rows, project, data, edit }: { rows: LiveParam[]; project: string; data: DesignBundle; edit: Edit }) {
  return <Table headers={['Parameter / meaning', 'Live value', 'Type / unit', 'Range', 'Source', 'Location', 'Used by', '']}>{rows.map(p => <tr key={p.id} id={p.id}><td><span className="font-mono text-xs font-semibold">{p.id}</span><p className="mt-1 max-w-60 text-muted-foreground">{p.meaning}</p></td><td><strong className={outside(p.value, p.range_min, p.range_max) ? 'text-destructive' : ''}>{p.error ? t('Unresolved') : JSON.stringify(p.value) ?? '—'}</strong>{p.error && <p className="max-w-48 text-xs text-destructive">{p.error}</p>}{outside(p.value, p.range_min, p.range_max) && <div className="mt-1"><Badge tone="danger">{t('Out of range')}</Badge></div>}</td><td><span className="font-mono text-xs">{p.type}</span><div className="text-muted-foreground">{p.unit}</div></td><td className="whitespace-nowrap">{p.range_min ?? '−∞'} … {p.range_max ?? '∞'}</td><td className="text-xs"><DesignState value={p.source} /><p className="mt-1">{p.source === 'decision' ? <DecisionRef project={project} id={p.source_ref} /> : p.source_ref}</p></td><td className="max-w-48 font-mono text-xs break-all">{p.location.file}<div className="mt-1 text-muted-foreground">{p.location.pointer}</div></td><td><Refs ids={[...p.rules, ...p.formulas]} project={project} data={data} /></td><td><EditButton kind="param" row={p} edit={edit} /></td></tr>)}</Table>;
}
function RuleRows({ rows, project, data, edit }: { rows: Rule[]; project: string; data: DesignBundle; edit: Edit }) {
  return <Table headers={['Rule', 'Implementation', 'Sources', 'Evidence', '']}>{rows.map(r => <tr key={r.id} id={r.id}><td className="min-w-64"><div className="font-mono text-xs font-semibold">{r.id}</div><p className="mt-1">{r.text}</p>{r.superseded_by && <div className="mt-2 text-xs">{t('Superseded by')}: {data.rule.some(x => x.id === r.superseded_by) ? <EntityRef project={project} data={data} id={r.superseded_by} /> : <DecisionRef project={project} id={r.superseded_by} />}</div>}</td><td><DesignState value={r.implementation} /></td><td className="text-xs">{r.sources.map((s, i) => <div key={i}>{s.kind === 'decision' ? <DecisionRef project={project} id={s.ref} /> : <span className="font-mono break-all">{s.ref}</span>}</div>)}</td><td><Evidence items={r.evidence} project={project} /></td><td><EditButton kind="rule" row={r} edit={edit} />{r.status === 'active' && <Button size="sm" variant="ghost" onClick={() => edit('rule', r, true)}>{t('Retire')}</Button>}</td></tr>)}</Table>;
}
function CopyCommand({ command }: { command: string }) {
  const [state, setState] = useState('');
  return <div><code className="block max-w-64 text-xs whitespace-pre-wrap break-all">{command}</code><Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(command).then(() => setState(t('Copied')), () => setState(t('Copy failed. Select the command to copy it.')))}>{t('Copy command')}</Button>{state && <p role="status" className="text-xs">{state}</p>}</div>;
}

function TargetMeasurement({ project, target, data }: { project: string; target: DesignBundle['target'][number]; data: DesignBundle }) {
  const run = useMeasureNow(project), view = data.measurements?.find(v => v.target === target.id);
  const outcome = run.data?.[0];
  return <div className="min-w-44 max-w-64 text-xs">
    <div className="mb-1 flex gap-1">{view?.running ? <Badge tone="primary">{t('Measuring')}</Badge> : view?.due ? <Badge tone="warning">{t('Due')}</Badge> : null}{view?.last && <Badge tone={view.last.status === 'ok' ? 'success' : 'danger'}>{t(view.last.status === 'ok' ? 'Measurement ok' : 'Measurement failed')}</Badge>}</div>
    {view?.last && <p className="mb-1 text-muted-foreground">{t('Last attempt')}: {view.last.at}</p>}
    {view?.last?.reason && <p className="mb-2 text-destructive">{view.last.reason}</p>}
    {view?.last?.status === 'ok' && <p className="mb-1">{t('Result')}: {view.last.value} {target.unit}</p>}
    <p className="text-muted-foreground">{t('Measured date')}: {target.measured_at ?? '—'}</p><code className="break-all">{target.measured_commit ?? '—'}</code>
    <Evidence items={target.evidence} project={project} />
    <Button className="mt-2" size="sm" variant="outline" disabled={!target.measure || view?.running || run.isPending} onClick={() => run.mutate(target.id)} aria-label={t('Measure {id} now', { id: target.id })}>{t(run.isPending ? 'Measuring' : 'Measure now')}</Button>
    {!target.measure && <p className="mt-1 text-muted-foreground">{t('No structured measurement')}</p>}
    {outcome?.status === 'waiting' && <p role="status" className="mt-1 text-warning">{outcome.reason}</p>}
    {run.isError && <p role="alert" className="mt-1 text-destructive">{run.error.message}</p>}
  </div>;
}

export function SystemDetail({ data, project, code, stale, edit }: { data: DesignBundle; project: string; code: string; stale: StaleSystem[]; edit: Edit }) {
  const [params, setParams] = useSearchParams();
  const ledger = useDecisions(project);
  const tab = tabs.some(([, value]) => value === params.get('tab')) ? params.get('tab')! : 'rule';
  const system = data.system.find(s => s.code === code);
  if (!system) return <Empty>{t('System not found.')}</Empty>;
  const rules = data.rule.filter(r => r.system === code), formulas = data.formula.filter(r => r.system === code), targets = data.target.filter(r => r.system === code), gaps = data.gap.filter(r => r.system === code);
  const owned = new Set([code, ...rules.map(r => r.id), ...formulas.map(r => r.id), ...data.param.filter(p => p.system === code).map(p => p.id), ...targets.map(r => r.id), ...gaps.map(r => r.id), ...data.term.filter(r => r.system === code).map(r => r.term)]);
  const links = data.decision_link.filter(l => owned.has(l.entity));
  const decisionIds = new Set([...links.map(l => l.decision), ...rules.flatMap(r => r.sources.filter(s => s.kind === 'decision').map(s => s.ref)), ...data.param.filter(p => p.system === code && p.source === 'decision').map(p => p.source_ref)]);
  const warning = stale.find(s => s.system === code);
  const exportCsv = () => { const url = URL.createObjectURL(new Blob([paramsCsv(liveParams(data, code))], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = `${code}-params.csv`; a.click(); URL.revokeObjectURL(url); };
  return <><PageHeader title={`${system.code} · ${system.name}`} actions={<EditButton kind="system" row={system} edit={edit} />}><DesignState value={system.status} /><span className="ml-2">{system.summary}</span></PageHeader>
    <div className="mb-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground"><span>{t('Verified commit')}: <code>{system.verified_commit ?? '—'}</code></span><span>{t('Verified date')}: {system.verified_at ?? t('Unverified')}</span></div>
    {warning && <div role="status" className="mb-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"><strong>{t('Verification is stale.')}</strong> {t('Code changed after verification, or changed paths are unknown.')} <div className="mt-1 flex gap-2">{[...warning.orders, ...warning.unknown_orders].map(tag => <TagLink key={tag} project={project} tag={tag} />)}</div></div>}
    <div role="tablist" aria-label={t('System detail')} className="mb-4 flex flex-wrap gap-1 border-b">{tabs.map(([label, value]) => <button key={value} role="tab" aria-selected={tab === value} className={`border-b-2 px-3 py-2 text-sm ${tab === value ? 'border-primary font-semibold text-primary' : 'border-transparent text-muted-foreground'}`} onClick={() => setParams({ tab: value })}>{t(label)}</button>)}</div>
    <div role="tabpanel"><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">{t(tabs.find(([, value]) => value === tab)![0])}</h2><div className="flex gap-2">{tab === 'param' && <Button size="sm" variant="outline" onClick={exportCsv}>{t('Export CSV')}</Button>}{tab !== 'history' && <Button size="sm" onClick={() => edit(tab as DesignKind)}>{t('New')}</Button>}</div></div>
    {tab === 'rule' && <><RuleRows rows={rules.filter(r => r.status === 'active')} project={project} data={data} edit={edit} />{!!rules.some(r => r.status === 'retired') && <details className="mt-4"><summary className="mb-2 cursor-pointer text-sm text-muted-foreground">{t('Retired rules')} ({rules.filter(r => r.status === 'retired').length})</summary><RuleRows rows={rules.filter(r => r.status === 'retired')} project={project} data={data} edit={edit} /></details>}</>}
    {tab === 'formula' && <div className="grid gap-3">{formulas.map(f => <Card id={f.id} key={f.id} className="p-4"><div className="flex items-center justify-between"><span className="font-mono text-xs font-semibold">{f.id}</span><EditButton kind="formula" row={f} edit={edit} /></div><pre className="my-2 overflow-x-auto rounded bg-muted p-3 text-sm">{f.expression}</pre><Refs ids={f.variables} project={project} data={data} /><dl className="mt-3 grid gap-2 text-xs sm:grid-cols-4">{[[t('Number kind'), t(f.number_kind)], [t('Rounding'), f.rounding], [t('Timing'), f.timing], [t('Code references'), f.code_refs.join(', ')]].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 font-mono break-all">{value}</dd></div>)}</dl>{f.notes && <p className="mt-3 text-sm text-muted-foreground">{f.notes}</p>}</Card>)}</div>}
    {tab === 'param' && <ParamsTable rows={liveParams(data, code)} project={project} data={data} edit={edit} />}
    {tab === 'target' && <Table headers={['Target / metric', 'Range', 'Last value', 'State', 'Measurement', 'Command', '']}>{targets.map(r => <tr key={r.id} id={r.id}><td><div className="font-mono text-xs font-semibold">{r.id}</div><p className="mt-1">{r.metric}</p></td><td className="whitespace-nowrap">{r.min ?? '−∞'} … {r.max ?? '∞'} {r.unit}</td><td className="font-semibold tabular-nums">{r.last_value ?? '—'}</td><td><DesignState value={targetState(r)} /></td><td><TargetMeasurement project={project} target={r} data={data} /></td><td><CopyCommand command={r.command} /></td><td><EditButton kind="target" row={r} edit={edit} /></td></tr>)}</Table>}
    {tab === 'gap' && <Table headers={['Gap', 'References', 'Order', 'Status', '']}>{gaps.map(g => <tr key={g.id} id={g.id}><td><div className="font-mono text-xs font-semibold">{g.id}</div><p className="mt-1">{g.text}</p>{g.closed_by && <p className="mt-1 text-xs">{t('Closed by')}: {g.closed_by}</p>}</td><td><Refs ids={g.refs} project={project} data={data} /></td><td>{g.order ? <TagLink project={project} tag={g.order} /> : <Badge tone="warning">{t('No order')}</Badge>}</td><td><DesignState value={g.status} /></td><td><EditButton kind="gap" row={g} edit={edit} /></td></tr>)}</Table>}
    {tab === 'decision_link' && <div className="grid gap-3">{ledger.isError && <ErrorBox error={ledger.error} />}{ledger.isPending && <Skeleton className="h-20" />}{[...decisionIds].map(id => <Card key={id} className="p-3"><DecisionRef project={project} id={id} /><p className="mt-1 text-sm">{ledger.data?.items.find(d => d.id === id)?.text ?? t('Ledger entry unavailable.')}</p><div className="mt-1 text-xs text-muted-foreground">{ledger.data?.items.find(d => d.id === id)?.date}</div></Card>)}{links.map(l => <Card key={idOf('decision_link', l)} className="flex items-center justify-between p-3 text-sm"><div><DecisionRef project={project} id={l.decision} /> → <EntityRef project={project} data={data} id={l.entity} /></div><EditButton kind="decision_link" row={l} edit={edit} /></Card>)}</div>}
    {tab === 'history' && <div className="grid gap-4">{systemHistory(data, code).map(h => <Card key={h.id} className="p-4"><div className="mb-3 flex flex-wrap items-center gap-2 text-xs"><strong className="font-mono">{h.entity}</strong><Badge>{t(h.op)}</Badge><span className="text-muted-foreground">{h.at} · {h.by}</span>{h.order && <TagLink project={project} tag={h.order} />}{h.decision && <DecisionRef project={project} id={h.decision} />}</div><div className="grid gap-3 sm:grid-cols-2">{[[t('Before'), h.before], [t('After'), h.after]].map(([label, value], i) => <div key={i}><h3 className="mb-1 text-xs font-semibold">{String(label)}</h3><pre className="max-h-80 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap break-all">{JSON.stringify(value, null, 2)}</pre></div>)}</div></Card>)}</div>}
    </div></>;
}

export function MilestoneBoard({ data, project, edit }: { data: DesignBundle; project: string; edit: Edit }) {
  return <><PageHeader title={t('Milestones')} count={data.milestone.length} actions={<Button onClick={() => edit('milestone')}>{t('New milestone')}</Button>} />
    <div className="grid gap-4">{[...data.milestone].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).map(m => {
      const passing = m.criteria.filter(c => 'target' in c && targetState(data.target.find(r => r.id === c.target)) === 'passing').length;
      return <Card key={m.id} className={`p-4 ${m.status === 'active' ? 'border-primary/60 bg-primary/3' : ''}`}><div className="mb-3 flex items-start justify-between gap-3"><div><div className="flex items-center gap-2"><span className="font-mono text-xs text-muted-foreground">{m.id}</span><DesignState value={m.status} /></div><h2 className="mt-1 text-lg font-semibold">{m.name}</h2><p className="mt-1 text-sm text-muted-foreground">{t('{passing} / {total} criteria passing', { passing, total: m.criteria.length })}</p></div><EditButton kind="milestone" row={m} edit={edit} /></div><ul className="divide-y rounded-md border bg-background/60">{m.criteria.map((c, i) => { const target = 'target' in c ? data.target.find(r => r.id === c.target) : undefined; return <li key={i} className="flex items-center justify-between gap-4 px-3 py-2 text-sm"><div>{'target' in c ? <><EntityRef project={project} data={data} id={c.target} /><span className="ml-3">{target?.metric}</span></> : c.text}</div><div className="flex items-center gap-3">{target && <span className="text-xs tabular-nums text-muted-foreground">{target.last_value ?? '—'} {target.unit} · {target.min ?? '−∞'} … {target.max ?? '∞'}</span>}<DesignState value={'target' in c ? targetState(target) : 'manual'} /></div></li>; })}</ul></Card>;
    })}</div></>;
}
function Terms({ data, project, edit }: { data: DesignBundle; project: string; edit: Edit }) {
  const [query, setQuery] = useState('');
  const rows = data.term.filter(r => JSON.stringify(r).toLowerCase().includes(query.trim().toLowerCase()));
  return <><PageHeader title={t('Terms')} count={data.term.length} actions={<Button onClick={() => edit('term')}>{t('New term')}</Button>} /><Input aria-label={t('Search terms')} placeholder={t('Search terms')} value={query} onChange={e => setQuery(e.target.value)} className="mb-4 max-w-sm" /><Table headers={['Term', 'Meaning', 'Avoid', 'System', '']}>{rows.map(r => <tr key={r.term}><td className="font-semibold">{r.term}</td><td>{r.meaning}</td><td>{r.avoid.join(', ') || '—'}</td><td>{r.system ? <EntityRef data={data} project={project} id={r.system} /> : '—'}</td><td><EditButton kind="term" row={r} edit={edit} /></td></tr>)}</Table>{!rows.length && <Empty>{t('No design entities match.')}</Empty>}</>;
}
export function DesignPage({ view = 'systems' }: { view?: 'systems' | 'system' | 'milestones' | 'terms' }) {
  const project = useProjectId(), { system = '' } = useParams();
  const query = useDesign(project), stale = useDesignStale(project);
  const [editing, setEditing] = useState<{ project: string; kind: DesignKind; row?: Entity; retire?: boolean }>();
  const edit: Edit = (kind, row, retire) => setEditing({ project, kind, row, retire });
  if (query.isError) return <ErrorBox error={query.error} />;
  if (!query.data) return <Skeleton className="h-64" />;
  const data = query.data;
  return <div><DesignNav project={project} />{stale.isError && <ErrorBox error={stale.error} />}
    {view === 'systems' && <SystemsList data={data} project={project} stale={stale.data ?? []} edit={edit} />}
    {view === 'system' && <SystemDetail data={data} project={project} code={system} stale={stale.data ?? []} edit={edit} />}
    {view === 'milestones' && <MilestoneBoard data={data} project={project} edit={edit} />}
    {view === 'terms' && <Terms data={data} project={project} edit={edit} />}
    {editing?.project === project && <DesignEdit {...editing} system={view === 'system' ? system : undefined} onClose={() => setEditing(undefined)} />}
  </div>;
}
