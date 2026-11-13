import type { RoleWorkerResult, RolesView } from '@api';
import { ErrorBox, Section } from '@/components/common';
import { Select } from '@/components/ui/input';
import { useRoles, useSetRole, errorText } from '@/lib/queries';
import { toast } from 'sonner';
import { t } from '@/i18n';

export function RoleResults({ results }: { results: RoleWorkerResult[] }) {
  if (!results.length) return <p className="text-sm text-muted-foreground">{t('not enough runs')}</p>;
  return <div className="overflow-x-auto"><table className="w-full text-sm">
    <thead><tr className="text-left"><th>{t('Role')}</th><th>{t('Worker')}</th><th>{t('Accepted without rework')}</th><th>{t('Median tokens')}</th><th>{t('Median wall time')}</th></tr></thead>
    <tbody>{results.map(r => <tr key={`${r.role}:${r.worker}`} className="border-t"><td className="py-2 pr-3">{r.role}</td><td className="pr-3">{r.worker}</td>
      <td className="pr-3">{r.accepted}/{r.samples} · {r.acceptedShare === null ? t('not enough runs') : `${Math.round(r.acceptedShare * 100)}%`}</td>
      <td className="pr-3">{r.medianTokens === null ? t('not enough runs') : r.medianTokens.toLocaleString()}</td>
      <td>{r.medianWallHours === null ? t('not enough runs') : `${r.medianWallHours.toFixed(2)} h`}</td></tr>)}</tbody>
  </table></div>;
}

export function RoleDetails({ r }: { r: RolesView['roles'][number] }) {
  return <article className="mb-4 rounded-xl border bg-card p-5">
    <h2 className="text-lg font-semibold">{r.id}{r.default || r.id === 'default' ? ` · ${t('Default')}` : ''}</h2>
    <p className="mb-3 text-sm text-muted-foreground">{r.description}</p>
    <dl className="mb-4 grid gap-2 text-sm sm:grid-cols-2">
      <div><dt className="text-muted-foreground">{t('Kinds')}</dt><dd>{r.kinds?.join(', ') || '—'}</dd></div>
      <div><dt className="text-muted-foreground">{t('Requires')}</dt><dd>{r.requires?.join(', ') || '—'}</dd></div>
      <div><dt className="text-muted-foreground">{t('Skills')}</dt><dd>{r.skills?.join(', ') || '—'}</dd></div>
      <div><dt className="text-muted-foreground">{t('MCP servers')}</dt><dd>{Object.keys(r.mcp ?? {}).join(', ') || '—'}</dd></div>
      <div><dt className="text-muted-foreground">{t('Prefer (in order)')}</dt><dd>{r.workers?.prefer?.join(' → ') || '—'}</dd></div>
      <div><dt className="text-muted-foreground">{t('Avoid')}</dt><dd>{r.workers?.avoid?.join(', ') || '—'}</dd></div>
      {r.workers?.only && <div><dt>{t('Only')}</dt><dd>{r.workers.only.join(', ') || '—'}</dd></div>}
      {(r.effort || r.reasoning) && <div><dt>{t('Effort / reasoning hints')}</dt><dd>{[r.effort, r.reasoning].filter(Boolean).join(' / ')}</dd></div>}
    </dl>
    {r.rules && <details className="mb-4 text-sm"><summary className="cursor-pointer" title={r.rules}>{t('Rules file')}: {r.rules.split(/[\\/]/).slice(-2).join('/')}</summary><pre className="mt-2 whitespace-pre-wrap rounded border bg-muted p-3">{r.rulesText ?? r.rulesProblem}</pre></details>}
    <p className={`mb-2 text-sm ${r.qualifying.length ? '' : 'text-destructive'}`}>{r.qualifying.length ? `${t('Qualifying now')}: ${r.qualifying.join(', ')}` : t('No qualifying worker right now')}</p>
    <div className="mb-5 overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left"><th>{t('Worker')}</th><th>{t('Verdict')}</th><th>{t('Reason')}</th></tr></thead><tbody>{r.candidates.map(c => <tr className="border-t" key={c.worker}><td className="py-2 pr-3 font-medium">{c.worker}</td><td className="pr-3">{c.verdict}</td><td className="text-muted-foreground">{c.reason}</td></tr>)}</tbody></table></div>
    <RoleResults results={r.results} />
  </article>;
}

export function RolesSection({ project }: { project: string }) {
  const q = useRoles(project);
  return <Section title={t('Role definitions')}>
    {q.isError ? <ErrorBox error={q.error} /> : !q.data ? <p>{t('Loading…')}</p> : !q.data.roles.length ? <p className="text-sm text-muted-foreground">{t('No roles configured')}</p> : q.data.roles.map(r => <RoleDetails key={r.id} r={r} />)}
  </Section>;
}

export function OrderRoleSelect({ project, tag, role }: { project: string; tag: string; role?: { id?: string; source: string } }) {
  const q = useRoles(project), mutation = useSetRole(project, tag);
  return <div className="grid gap-1 text-sm"><label htmlFor="order-role">{t('Role')} · {role?.id || t('none')} ({role?.source || 'none'})</label>
    <Select id="order-role" aria-label={t('Role')} disabled={!q.data || mutation.isPending} value={role?.source === 'explicit' ? role.id : ''} onChange={e => mutation.mutate(e.target.value, { onError: error => toast.error(errorText(error)) })}>
      <option value="">{t('From kind')}</option>{q.data?.roles.map(r => <option key={r.id} value={r.id}>{r.id}{r.description ? ` · ${r.description}` : ''}</option>)}
    </Select>{q.isError && <ErrorBox error={q.error} />}
  </div>;
}
