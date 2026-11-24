import { useState } from 'react';
import { Link } from 'react-router';
import type { OrderDetail, ScorecardRow, UsageDashboard, UsageReport, UsageTotal } from '@api';
import { UnknownTotal } from '@/components/common';
import { getLang, t } from '@/i18n';
import { SERIES_COLORS } from '@/lib/palette';
import { useUsageScorecard } from '@/lib/queries';
import { sortScorecardRows, toggleScorecardSort, type ScorecardColumn, type ScorecardSort } from '@/lib/scorecard';

const colors = SERIES_COLORS;
export const tokenNumber = (n: number) => new Intl.NumberFormat(getLang(), { notation: 'compact', maximumFractionDigits: 2 }).format(n);
export const tokenTotal = (total: UsageTotal) => total.known || !total.unknown ? tokenNumber(total.tokens) : t('unknown');
const share = (n: number, total: number) => total ? `${Math.round(n / total * 100)}%` : '—';
export function Estimate({ total }: { total: UsageTotal }) {
  const entries = Object.entries(total.estimates);
  return <>{entries.length ? entries.map(([unit, value]) => `${value.toFixed(4)} ${unit} ${t('estimate')}`).join(' · ') : '—'}</>;
}
export function UsageGroups({ report, title }: { report: UsageReport; title: string }) {
  return <div className="space-y-2"><h3 className="text-sm font-medium">{title}</h3><div className="flex h-3 overflow-hidden rounded bg-muted" aria-label={title}>{report.rows.map((r, i) => <div key={r.key} title={`${r.key}: ${r.tokens.toLocaleString()}`} style={{ width: `${report.total.tokens ? r.tokens / report.total.tokens * 100 : 0}%`, background: colors[i % colors.length] }} />)}</div><div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">{report.rows.map((r, i) => <span key={r.key}><span style={{ color: colors[i % colors.length] }}>●</span> {r.key} <strong>{r.known ? tokenNumber(r.tokens) : t('unknown')}</strong>{r.unknown > 0 && ` · ${r.unknown} ${t('unknown')}`}</span>)}</div></div>;
}
export function UsageTable({ report, title, perOrder = false }: { report: UsageReport; title: string; perOrder?: boolean }) {
  const cache = report.rows.some(r => r.known > 0 && !r.cache_unknown && r.input > 0);
  const reasoning = report.rows.some(r => r.known > 0 && !r.reasoning_unknown && r.output > 0);
  const cost = report.rows.some(r => Object.keys(r.estimates).length > 0 && (!perOrder || r.merged_pricing_complete));
  const hidden = [!cache && t('Cached share'), !reasoning && t('Reasoning share'), !cost && t('Estimate')].filter(Boolean).join(',');
  return <section className="min-w-0 rounded-lg border bg-card p-4"><h2 className="mb-3 font-semibold">{title}</h2>{hidden && <p className="mb-3 text-xs text-muted-foreground">{t('No readings for {fields}; these columns are hidden.', { fields: hidden })}</p>}{!report.rows.length ? <p className="text-sm text-muted-foreground">{t('No usage recorded in this period.')}</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="pb-2">{t('Group')}</th><th>{t('Tokens')}</th>{cache && <th>{t('Cached share')}</th>}{reasoning && <th>{t('Reasoning share')}</th>}{cost && <th>{perOrder ? t('Estimate per merged order') : t('Estimate')}</th>}</tr></thead><tbody>{report.rows.map(r => <tr key={r.key} className="border-t"><td className="py-2 pr-4">{report.by === 'order' ? <Link className="text-primary" to={`/p/${encodeURIComponent(r.key.split('/')[0])}/orders/${encodeURIComponent(r.key.split('/')[1])}`}>{r.key}</Link> : r.key}</td><td className="pr-4 tabular-nums">{r.known ? tokenNumber(r.tokens) : '—'}{r.unknown > 0 && <span className="ml-2 text-xs text-muted-foreground">{t('{n} missing readings', { n: r.unknown })}</span>}</td>{cache && <td>{r.cache_unknown ? '—' : share(r.cached, r.input)}</td>}{reasoning && <td>{r.reasoning_unknown ? '—' : share(r.reasoning, r.output)}</td>}{cost && <td>{perOrder && !r.merged_pricing_complete ? '—' : <Estimate total={perOrder ? { ...r, estimates: Object.fromEntries(Object.entries(r.estimates).map(([unit,cost]) => [unit, cost / (r.merged_orders || 1)])) } : r} />}</td>}</tr>)}</tbody><tfoot className="border-t font-medium"><tr><td className="pt-2">{t('Total')}</td><td>{tokenTotal(report.total)}</td>{cache && <td>{report.total.cache_unknown ? '—' : share(report.total.cached, report.total.input)}</td>}{reasoning && <td>{report.total.reasoning_unknown ? '—' : share(report.total.reasoning, report.total.output)}</td>}{cost && <td><Estimate total={report.total} /></td>}</tr></tfoot></table></div>}</section>;
}
export function UsageTile({ data }: { data?: UsageDashboard }) {
  if (!data || (!data.week.total.known && !data.week.total.unknown)) return null;
  return <section className="overview-panel overview-usage"><div className="overview-panel-heading"><h2>{t('Usage and cost')}</h2><div className="flex gap-4 text-xs">{data.projects.rows.map(p => <Link className="text-primary" key={p.key} to={`/p/${encodeURIComponent(p.key)}/usage`}>{p.key} →</Link>)}</div></div><div className="grid gap-5 p-4 lg:grid-cols-3"><div className="space-y-4"><p className="text-2xl font-semibold tabular-nums">{tokenTotal(data.today.total)} <span className="text-xs font-normal text-muted-foreground">{t('Today')}</span> <span className="ml-4">{tokenTotal(data.week.total)}</span> <span className="text-xs font-normal text-muted-foreground">{t('7 days')}</span></p><UsageGroups report={data.today} title={t('Today by worker')} /><UsageGroups report={data.week} title={t('7 days by worker')} /></div><div className="space-y-4"><UsageGroups report={data.todayProjects} title={t('Today by project')} /><UsageGroups report={data.projects} title={t('7 days by project')} /><p className="text-xs">{t('Cached share')}: <strong>{data.week.total.cache_unknown ? t('unknown') : share(data.week.total.cached, data.week.total.input)}</strong> · {t('Tokens per merged order')}: {t('Median')} {data.median === undefined ? '—' : tokenNumber(data.median)} · p90 {data.p90 === undefined ? '—' : tokenNumber(data.p90)}</p></div><div><h3 className="mb-2 text-sm font-medium">{t('Most expensive open runs')}</h3>{data.open.map(r => <Link className="flex justify-between gap-2 border-t py-1.5 text-xs" key={`${r.project}/${r.order}/${r.run}`} to={`/p/${encodeURIComponent(r.project)}/orders/${encodeURIComponent(r.order)}`}><span>{r.project} · {r.order} · {r.run}</span><span>{r.total_tokens === undefined ? t('not reported yet') : tokenNumber(r.total_tokens)}{r.estimate !== undefined && ` · ${r.estimate.toFixed(4)} ${r.currency} ${t('estimate')}`}</span></Link>)}</div></div></section>;
}
export function OrderAccounting({ data }: { data?: OrderDetail['accounting'] }) {
  if (!data?.rows.length) return null;
  const runs = new Map<string, typeof data.rows>();
  for (const row of data.rows) { const list = runs.get(row.run) ?? []; list.push(row); runs.set(row.run, list); }
  return <section className="my-4 rounded-lg border bg-card p-4"><h2 className="mb-2 font-semibold">{t('Usage and cost')}</h2><p>{t('This order used {tokens} tokens; {rework}% in rework, {resume}% in resumes.', { tokens: tokenTotal(data.total), rework: Math.round(data.reworkShare * 100), resume: Math.round(data.resumeShare * 100) })} <Estimate total={data.total} /></p><div className="mt-3 space-y-1 text-xs">{[...runs].map(([id, rows]) => <div className="flex flex-wrap justify-between gap-2 border-t py-2" key={id}><span>{id} · {rows[0].worker} · {rows[0].engine} · {rows[0].model}</span><span>{rows.every(r => r.total_tokens === undefined) ? t('unknown') : tokenNumber(rows.reduce((n,r) => n + (r.total_tokens ?? 0), 0))} · {rows.map(r => r.source).filter((v,i,a) => a.indexOf(v) === i).join(', ')} {rows[0].rework && ` · ${t('Rework')}`}{rows[0].resume && ` · ${t('Resumes')}`}{rows.some(r => r.estimate !== undefined) && ` · ${rows.reduce((n,r) => n + (r.estimate ?? 0), 0).toFixed(4)} ${rows.find(r => r.currency)?.currency} ${t('estimate')}`}{rows[0].subscription && !rows[0].quota?.length && ` · ${t('Window share unknown')}`}{rows[0].quota?.map(q => ` · ${q.window}: ${q.percent.toFixed(1)}% ${q.shared ? t('shared window change') : t('window change')}`)}</span></div>)}</div>{data.total.unknown > 0 && <p className="text-sm text-muted-foreground">{t('{n} usage rows are unknown', { n: data.total.unknown })}</p>}{data.signals.map((s,i) => <p key={i} className="mt-2 text-sm text-warning">{s.text} · {s.run} · {t('Turns')} {s.turns.join('–')}</p>)}{data.warnings.map((w,i) => <p key={i} className="mt-2 text-sm text-warning">{w.text}</p>)}</section>;
}

const formatScoreUsd = (n: number) => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

function renderScoreCost(row: ScorecardRow): string {
  if (row.cost.usd !== undefined) return formatScoreUsd(row.cost.usd);
  if (row.runs > 0 && row.cost.included_runs === row.runs) return t('included');
  if (row.cost.priced_runs > 0) return t('unknown ({priced} of {runs} runs priced)', { priced: row.cost.priced_runs, runs: row.runs });
  return t('unknown');
}

function renderScoreCostPerAccept(row: ScorecardRow): string {
  if (row.cost_per_accept !== undefined) return formatScoreUsd(row.cost_per_accept);
  if (row.runs > 0 && row.cost.included_runs === row.runs) return t('included');
  if (row.cost.usd === undefined) return t('unknown');
  return '—';
}

export function ScorecardSection({ project }: { project: string }) {
  const [since, setSince] = useState<'7d' | '14d' | '30d'>('14d');
  const [allProjects, setAllProjects] = useState(false);
  const [sort, setSort] = useState<ScorecardSort>({ column: 'cost_per_accept', dir: 'asc' });
  const q = useUsageScorecard(allProjects ? undefined : project, since);

  const columns: { key: ScorecardColumn; label: string; numeric?: boolean }[] = [
    { key: 'key', label: t('Worker') },
    { key: 'kind', label: t('Kind') },
    { key: 'runs', label: t('Runs'), numeric: true },
    { key: 'accepted_first_pass', label: t('1st-pass'), numeric: true },
    { key: 'accepted_after_rework', label: t('After rework'), numeric: true },
    { key: 'reworks', label: t('Reworks'), numeric: true },
    { key: 'failed', label: t('Failed'), numeric: true },
    { key: 'cancelled', label: t('Cancelled'), numeric: true },
    { key: 'minutes', label: t('Minutes'), numeric: true },
    { key: 'cost', label: t('Cost'), numeric: true },
    { key: 'cost_per_accept', label: t('Cost / accept'), numeric: true },
    { key: 'minutes_per_accept', label: t('Min / accept'), numeric: true },
    { key: 'first_pass_rate', label: t('First-pass rate'), numeric: true },
  ];

  const rows = q.data ? sortScorecardRows(q.data.rows, sort) : [];

  return (
    <section className="min-w-0 rounded-lg border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">{t('Cost and time per accepted order')}</h2>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <div className="inline-flex overflow-hidden rounded border bg-background text-xs">
            <button
              type="button"
              className={`px-2.5 py-1 ${!allProjects ? 'bg-primary text-primary-foreground font-medium' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => setAllProjects(false)}
            >
              {t('This project')}
            </button>
            <button
              type="button"
              className={`border-l px-2.5 py-1 ${allProjects ? 'bg-primary text-primary-foreground font-medium' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => setAllProjects(true)}
            >
              {t('All projects')}
            </button>
          </div>
          <label className="flex items-center gap-2">
            {t('Period')}
            <select
              className="rounded border bg-card px-2.5 py-1 text-xs"
              value={since}
              onChange={e => setSince(e.target.value as '7d' | '14d' | '30d')}
            >
              <option value="7d">{t('7 days')}</option>
              <option value="14d">{t('14 days')}</option>
              <option value="30d">{t('30 days')}</option>
            </select>
          </label>
        </div>
      </div>
      {q.isError ? (
        <UnknownTotal error={q.error} />
      ) : !q.data ? (
        <p className="text-sm text-muted-foreground">{t('Loading…')}</p>
      ) : !rows.length ? (
        <p className="text-sm text-muted-foreground">{t('No usage recorded in this period.')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                {columns.map(col => {
                  const active = sort.column === col.key;
                  return (
                    <th
                      key={col.key}
                      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                      className="pb-2 pr-4 whitespace-nowrap"
                    >
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 font-medium hover:text-foreground"
                        onClick={() => setSort(cur => toggleScorecardSort(cur, col.key))}
                      >
                        <span>{col.label}</span>
                        {active && <span>{sort.dir === 'asc' ? '↑' : '↓'}</span>}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={`${r.key}:${r.kind}`} className="border-t">
                  <td className="py-2 pr-4 whitespace-nowrap font-medium">{r.key}</td>
                  <td className="pr-4 whitespace-nowrap">{r.kind}</td>
                  <td className="pr-4 whitespace-nowrap tabular-nums">{r.runs}</td>
                  <td className="pr-4 whitespace-nowrap tabular-nums">{r.accepted_first_pass}</td>
                  <td className="pr-4 whitespace-nowrap tabular-nums">{r.accepted_after_rework}</td>
                  <td className="pr-4 whitespace-nowrap tabular-nums">{r.reworks}</td>
                  <td className="pr-4 whitespace-nowrap tabular-nums">{r.failed}</td>
                  <td className="pr-4 whitespace-nowrap tabular-nums">{r.cancelled}</td>
                  <td className="pr-4 whitespace-nowrap tabular-nums">{Math.round(r.minutes)}</td>
                  <td className="pr-4 whitespace-nowrap tabular-nums">{renderScoreCost(r)}</td>
                  <td className="pr-4 whitespace-nowrap tabular-nums">{renderScoreCostPerAccept(r)}</td>
                  <td className="pr-4 whitespace-nowrap tabular-nums">{r.minutes_per_accept !== undefined ? Math.round(r.minutes_per_accept) : '—'}</td>
                  <td className="pr-4 whitespace-nowrap tabular-nums">{r.first_pass_rate !== undefined ? `${Math.round(r.first_pass_rate * 100)}%` : 'n<3'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
