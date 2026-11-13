import type { ProducerFacts as FactsResponse } from '@api';
import { Section, Empty, TagLink } from '@/components/common';
import { Card } from '@/components/ui/card';
import { dateTime } from '@/lib/format';
import { t } from '@/i18n';

type Snapshot = NonNullable<FactsResponse['snapshot']>;
const fmt = (n: number | null, suffix = '') => n === null ? '—' : `${Number(n.toFixed(1)).toLocaleString()}${suffix}`;
const percent = (n: number | null) => n === null ? '—' : fmt(n * 100, '%');
const factKey = (s: string) => encodeURIComponent(s).replace(/\./g, '%2E');
const colors: Record<string, string> = { unqueued: '#9A98B4', queued: '#F5A524', working: '#6CB4EE', monitoring: '#9C8CF2', acceptor: '#3FBF9A', stopped: '#F0785A', held: '#f97316', done: '#22c55e' };

export function FlowFacts({ snapshot, project }: { snapshot: Snapshot | null; project: string }) {
  if (!snapshot) return <Section title={t('Flow')}><Empty>{t('Facts will appear after the first tick.')}</Empty></Section>;
  const d = snapshot.windows['7d'], stages = Object.keys(colors), max = Math.max(1, ...d.cumulative.map(p => Object.values(p.stages).reduce((a, b) => a + b, 0)));
  return <Section title={t('Flow')}>
    <p className="mb-3 text-xs text-muted-foreground">{t('7 days · Snapshot {at} · Slot averages sampled every 10 minutes', { at: dateTime(snapshot.at) })}</p>
    <div className="grid gap-4 xl:grid-cols-2">
      <Card className="p-4"><h3 className="mb-3 text-sm font-semibold">{t('Slot occupancy')}</h3>{d.slots.length ? d.slots.map(s => <div key={s.cap} className="mb-4" title={`F:slot.${factKey(s.cap)}.monitoring.7d`}>
        <div className="mb-1 flex justify-between text-sm"><strong>{t('{cap} · cap {limit}', { cap: s.cap, limit: s.limit })}</strong><span>{t('{count} samples', { count: s.samples })}</span></div>
        <div className="flex h-5 overflow-hidden rounded bg-muted" role="img" aria-label={t('{cap}: {working} working, {monitoring} monitoring, {idle} idle on average', { cap: s.cap, working: fmt(s.working), monitoring: fmt(s.monitoring), idle: fmt(s.idle) })}>
          {(['working', 'monitoring', 'idle'] as const).map(stage => <span key={stage} style={{ width: `${s[stage] / Math.max(s.limit, s.working + s.monitoring, 1) * 100}%`, background: colors[stage] ?? '#94a3b8' }} />)}
        </div><div className="mt-1 text-xs text-muted-foreground">{t('Average: {working} working / {monitoring} monitoring / {idle} idle', { working: fmt(s.working), monitoring: fmt(s.monitoring), idle: fmt(s.idle) })}<br />{t('Now: {working} working / {monitoring} monitoring / {idle} idle', { ...s.current })}</div>
      </div>) : <Empty>{t('No project caps configured.')}</Empty>}</Card>
      <Card className="p-4"><h3 className="mb-3 text-sm font-semibold">{t('Non-ready report causes')}</h3><div className="grid gap-2">{d.causes.map(c => <div key={c.cause} className="flex justify-between text-sm" title={`F:cause.${c.cause}.7d`}><span>{t(c.cause)}</span><strong>{c.count}</strong></div>)}</div>
        {d.unclassified.length > 0 && <details className="mt-3 text-xs"><summary>{t('Unclassified outcomes ({count})', { count: d.unclassified.length })}</summary><ul className="mt-2 space-y-2">{d.unclassified.map((u, i) => <li key={`${u.tag}-${u.at}-${i}`}><TagLink project={project} tag={u.tag} /> · {u.summary}</li>)}</ul></details>}
      </Card>
      <Card className="min-w-0 p-4"><h3 className="mb-3 text-sm font-semibold">{t('Cumulative flow')}</h3><svg viewBox="0 0 600 190" className="w-full" role="img" aria-label={t('Cumulative flow by stage over seven days')}>
        {stages.map((stage, index) => {
          const point = (i: number, sum: number) => `${i / Math.max(1, d.cumulative.length - 1) * 600},${175 - sum / max * 165}`;
          const top = d.cumulative.map((p, i) => point(i, stages.slice(0, index + 1).reduce((n, s) => n + p.stages[s as keyof typeof p.stages], 0)));
          const bottom = d.cumulative.map((p, i) => point(i, stages.slice(0, index).reduce((n, s) => n + p.stages[s as keyof typeof p.stages], 0))).reverse();
          return <polygon key={stage} fill={colors[stage]} opacity=".8" points={[...top, ...bottom].join(' ')}><title>{t(stage)}</title></polygon>;
        })}<text x="0" y="189" fontSize="10" fill="currentColor">{t('7 days ago')}</text><text x="575" y="189" fontSize="10" fill="currentColor">{t('Now')}</text>
      </svg><div className="flex flex-wrap gap-3 text-xs">{stages.map(s => <span key={s}><i className="mr-1 inline-block size-2 rounded" style={{ background: colors[s] }} />{t(s)}</span>)}</div></Card>
      <Card className="min-w-0 p-4"><h3 className="mb-3 text-sm font-semibold">{t('Open item age against kind p85')}</h3><div className="max-h-80 overflow-auto"><table className="w-full text-left text-sm"><thead><tr><th>{t('Order / kind')}</th><th>{t('Stage')}</th><th>{t('Age')}</th><th>{t('p85')}</th><th>{t('Age / p85')}</th></tr></thead><tbody>{d.aging.map(a => <tr key={a.tag} className="border-t border-border" title={`F:order.${encodeURIComponent(a.tag)}.age_p85_ratio.7d`}><td className="py-2"><TagLink project={project} tag={a.tag} /><span className="ml-2 text-xs text-muted-foreground">{a.kind}</span></td><td>{t(a.stage)}</td><td>{fmt(a.hours, t('h'))}</td><td>{fmt(a.p85 !== null && a.p85 > 0 ? a.p85 : null, t('h'))}</td><td className={a.ratio !== null && a.ratio > 1 ? 'text-warning' : ''}>{percent(a.p85 !== null && a.p85 > 0 ? a.ratio : null)}</td></tr>)}</tbody></table></div>{!d.aging.length && <Empty>{t('No open items.')}</Empty>}<p className="mt-2 text-xs text-muted-foreground">{t('— means no completed sample for this kind in the window.')}</p></Card>
    </div>
  </Section>;
}

export function RoutingFacts({ snapshot }: { snapshot: Snapshot | null }) {
  const rows = snapshot?.windows['7d'].routing ?? [];
  return <Section title={t('Dispatch results')}><Card className="overflow-x-auto p-4"><p className="mb-3 text-xs text-muted-foreground">{t('7 days · Comparisons are hidden until a worker has at least five decided orders of a kind. Tokens and hours are attributed to that worker on orders it delivered for merge.')}</p><table className="w-full text-left text-sm"><thead><tr>{['Worker', 'Kind', 'Orders', 'Runs', 'First-pass yield', 'Mean rework', 'Median tokens', 'Median hours', 'Main failure cause'].map(h => <th key={h} className="whitespace-nowrap pr-4 pb-2">{t(h)}</th>)}</tr></thead><tbody>{rows.map(r => <tr key={`${r.worker}/${r.kind}`} className="border-t border-border"><td className="py-2 pr-4">{r.worker}</td><td className="pr-4">{r.kind}</td><td>{r.orders}</td><td>{r.runs}</td>{r.comparable ? <><td>{percent(r.yield)}</td><td>{fmt(r.rework)}</td><td>{fmt(r.tokens)}</td><td>{fmt(r.hours)}</td><td>{r.cause ? t(r.cause) : '—'}</td></> : <td colSpan={5} className="text-muted-foreground">{t('Fewer than five decided orders of this kind')}</td>}</tr>)}</tbody></table>{!rows.length && <Empty>{t('No routing samples yet.')}</Empty>}</Card></Section>;
}
