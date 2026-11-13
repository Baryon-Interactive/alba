import type { RoleWorkerResult, RolesView } from '@api';
import { ErrorBox, Section } from '@/components/common';
import { Select } from '@/components/ui/input';
import { useRoles, useSetRole, errorText } from '@/lib/queries';
import { toast } from 'sonner';
import { t } from '@/i18n';
import { ArrowRight } from 'lucide-react';

export function RoleResults({ results }: { results: RoleWorkerResult[] }) {
  if (!results.length) return <p className="text-sm text-muted-foreground">{t('not enough runs')}</p>;
  return <div className="overflow-x-auto"><table className="w-full text-sm">
    <thead><tr className="text-left"><th>{t('Route')}</th><th>{t('Worker')}</th><th>{t('Accepted without rework')}</th><th>{t('Median tokens')}</th><th>{t('Median wall time')}</th></tr></thead>
    <tbody>{results.map(r => <tr key={`${r.role}:${r.worker}`} className="border-t"><td className="py-2 pr-3">{r.role}</td><td className="pr-3">{r.worker}</td>
      <td className="pr-3">{r.accepted}/{r.samples} · {r.acceptedShare === null ? t('not enough runs') : `${Math.round(r.acceptedShare * 100)}%`}</td>
      <td className="pr-3">{r.medianTokens === null ? t('not enough runs') : r.medianTokens.toLocaleString()}</td>
      <td>{r.medianWallHours === null ? t('not enough runs') : `${r.medianWallHours.toFixed(2)} h`}</td></tr>)}</tbody>
  </table></div>;
}

/** A chain of workers in order; "*" reads "anyone else". */
function Chain({ members, open }: { members: string[]; open?: boolean }) {
  const list = members.filter(m => m !== '*');
  return <span className="inline-flex flex-wrap items-center gap-1">{list.map((m, i) => <span key={m} className="inline-flex items-center gap-1">{i > 0 && <ArrowRight className="size-3 text-muted-foreground" />}<span className="rounded-full border bg-background px-2 py-0.5 font-mono text-xs">{m}</span></span>)}
    {(open || members.includes('*')) && <span className="inline-flex items-center gap-1">{list.length > 0 && <ArrowRight className="size-3 text-muted-foreground" />}<span className="rounded-full border border-dashed px-2 py-0.5 text-xs text-muted-foreground">{t('anyone else')}</span></span>}</span>;
}

export function RoleDetails({ r }: { r: RolesView['roles'][number] }) {
  const open = !!r.group && !r.workers?.only;
  return <article className="mb-4 rounded-xl border bg-card p-5">
    <h2 className="text-lg font-semibold">{r.id}{r.default || r.id === 'default' ? ` · ${t('Default')}` : ''}</h2>
    <p className="mb-3 text-sm text-muted-foreground">{r.description}</p>
    <dl className="mb-4 grid gap-2 text-sm sm:grid-cols-2">
      <div><dt className="text-muted-foreground">{t('Kinds')}</dt><dd>{r.kinds?.join(', ') || (r.default || r.id === 'default' ? t('everything no other route takes') : '—')}</dd></div>
      <div><dt className="text-muted-foreground">{t('Requires')}</dt><dd>{r.requires?.join(', ') || '—'}</dd></div>
      {r.group ? <div className="sm:col-span-2"><dt className="text-muted-foreground">{t('Worker group {group}, in order', { group: r.group })}</dt><dd className="mt-1"><Chain members={r.workers?.prefer ?? []} open={open} /></dd></div>
        : <><div><dt className="text-muted-foreground">{t('Prefer (in order)')}</dt><dd>{r.workers?.prefer?.join(' → ') || '—'}</dd></div>
          {r.workers?.only && <div><dt>{t('Only')}</dt><dd>{r.workers.only.join(', ') || '—'}</dd></div>}</>}
      <div><dt className="text-muted-foreground">{t('Never chosen by itself')}</dt><dd>{r.workers?.avoid?.join(', ') || '—'}</dd></div>
      {!!r.skills?.length && <div><dt className="text-muted-foreground">{t('Skills')}</dt><dd>{r.skills.join(', ')}</dd></div>}
      {!!Object.keys(r.mcp ?? {}).length && <div><dt className="text-muted-foreground">{t('MCP servers')}</dt><dd>{Object.keys(r.mcp ?? {}).join(', ')}</dd></div>}
      {(r.effort || r.reasoning) && <div><dt>{t('Effort / reasoning hints')}</dt><dd>{[r.effort, r.reasoning].filter(Boolean).join(' / ')}</dd></div>}
    </dl>
    {r.rules && <details className="mb-4 text-sm"><summary className="cursor-pointer" title={r.rules}>{t('Rules file')}: {r.rules.split(/[\\/]/).slice(-2).join('/')}</summary><pre className="mt-2 whitespace-pre-wrap rounded border bg-muted p-3">{r.rulesText ?? r.rulesProblem}</pre></details>}
    <p className={`mb-2 text-sm ${r.qualifying.length ? '' : 'text-destructive'}`}>{r.qualifying.length ? `${t('Qualifying now')}: ${r.qualifying.join(', ')}` : t('No qualifying worker right now')}</p>
    <div className="mb-5 overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left"><th>{t('Worker')}</th><th>{t('Verdict')}</th><th>{t('Reason')}</th></tr></thead><tbody>{r.candidates.map(c => <tr className="border-t" key={c.worker}><td className="py-2 pr-3 font-medium">{c.worker}</td><td className="pr-3">{c.verdict}</td><td className="text-muted-foreground">{c.reason}</td></tr>)}</tbody></table></div>
    <RoleResults results={r.results} />
  </article>;
}

/** The worker groups: the layer above the workers that routes draw on. Changing a group changes every route that uses it. */
export function WorkerGroups({ groups }: { groups: RolesView['groups'] }) {
  if (!groups.length) return null;
  return <Section title={t('Worker groups')}>
    <div className="stagger grid gap-3 md:grid-cols-2 xl:grid-cols-3">{groups.map(g => <div key={g.name} className="lift rounded-xl border bg-card p-4">
      <div className="mb-2 flex items-center justify-between gap-2"><h3 className="font-semibold">{g.name}</h3><span className="text-xs text-muted-foreground">{g.source === 'project' ? t('project file') : t('workers file')}</span></div>
      <Chain members={g.members} />
      <p className="mt-3 text-xs text-muted-foreground">{g.routes.length ? t('Used by {routes}', { routes: g.routes.join(', ') }) : t('No route uses it')}</p>
    </div>)}</div>
  </Section>;
}

export function RolesSection({ project }: { project: string }) {
  const q = useRoles(project);
  return <>{q.data && <WorkerGroups groups={q.data.groups ?? []} />}<Section title={t('Routes')}>
    {q.isError ? <ErrorBox error={q.error} /> : !q.data ? <p>{t('Loading…')}</p> : !q.data.roles.length ? <p className="text-sm text-muted-foreground">{t('No routes: every order may go to any worker.')}</p> : q.data.roles.map(r => <RoleDetails key={r.id} r={r} />)}
  </Section></>;
}

export function OrderRoleSelect({ project, tag, role }: { project: string; tag: string; role?: { id?: string; source: string } }) {
  const q = useRoles(project), mutation = useSetRole(project, tag);
  return <div className="grid gap-1 text-sm"><label htmlFor="order-role">{t('Route')} · {role?.id || t('none')} ({role?.source || 'none'})</label>
    <Select id="order-role" aria-label={t('Route')} disabled={!q.data || mutation.isPending} value={role?.source === 'explicit' ? role.id : ''} onChange={e => mutation.mutate(e.target.value, { onError: error => toast.error(errorText(error)) })}>
      <option value="">{t('From kind')}</option>{q.data?.roles.map(r => <option key={r.id} value={r.id}>{r.id}{r.description ? ` · ${r.description}` : ''}</option>)}
    </Select>{q.isError && <ErrorBox error={q.error} />}
  </div>;
}
