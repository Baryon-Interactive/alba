import { useState, type ReactNode } from 'react';
import { Check, Plus, Power, RotateCcw, Stethoscope, Wrench, X } from 'lucide-react';
import type { DoctorResult, PluginsView, PluginView, ToolJobView } from '@api';
import { Badge, type Tone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/misc';
import { Empty, EmptyState, ErrorBox, PageHeader, Section, TagLink } from '@/components/common';
import { ChipsInput, EditCard } from '@/components/EditFields';
import { nth } from '@/components/motion';
import { autoEdits, autoRows, baseName, kindEdits, kindRows, pluginsBlock, settingsDraft, settingsEdits, toggleEdits, toggleLoses, type AutoRow, type KindRow, type PluginsBlock, type SettingsDraft } from '@/lib/plugins';
import { errorText, useConfig, useEditConfig, usePluginDoctor, usePlugins, useProjectId } from '@/lib/queries';
import { ago, dateTime } from '@/lib/format';
import { t } from '@/i18n';

type Values = Record<string, unknown>;

function statusLabel(status: ToolJobView['status']): string {
  switch (status) {
    case 'queued': return t('queued');
    case 'waiting-quote': return t('waiting for a quote');
    case 'running': return t('running');
    case 'done': return t('done');
    case 'failed': return t('failed');
    case 'refused': return t('refused');
  }
}
const statusTone = (status: ToolJobView['status']): Tone => (status === 'done' ? 'success' : status === 'failed' || status === 'refused' ? 'danger' : status === 'waiting-quote' ? 'warning' : status === 'running' ? 'info' : 'neutral');

/** A server's command line, as one line of text. */
const commandLine = (command: string, args: string[]) => [command, ...args.map(a => (/\s/.test(a) || !a ? JSON.stringify(a) : a))].join(' ');

/** The settings of one tool: a value per setting, the default as the placeholder. Only an enabled tool's settings can be written. */
function PluginSettings({ project, tool, block }: { project: string; tool: PluginView; block: PluginsBlock }) {
  const written = block.settings[tool.id];
  const start = () => settingsDraft(written, tool.settings.map(s => s.name));
  const [draft, setDraft] = useState<SettingsDraft>(start);
  const edit = useEditConfig(project, 'project');
  const edits = tool.enabled ? settingsEdits(tool.id, written, draft) : [];
  if (!tool.settings.length) return null;
  return (
    <div className="grid gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{t('Settings')}</h3>
      <div className="grid gap-2">
        {tool.settings.map(s => {
          const value = draft[s.name];
          const label = t('Setting {name}', { name: s.name });
          return (
            <div key={s.name} className="grid items-start gap-x-3 gap-y-1 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <div className="pt-1.5 font-mono text-xs break-all">{s.name}</div>
              <div className="grid gap-1">
                {tool.enabled ? (
                  <div className="flex items-center gap-1.5">
                    <Input value={value ?? ''} aria-label={label} className="font-mono text-xs" onChange={e => { setDraft({ ...draft, [s.name]: e.target.value }); edit.reset(); }}
                      placeholder={s.default === undefined ? t('not set') : s.default === '' ? t('default: empty') : t('default: {value}', { value: s.default })} />
                    {value !== undefined && <Button variant="ghost" size="icon" aria-label={t('Use the default of {name}', { name: s.name })} onClick={() => setDraft({ ...draft, [s.name]: undefined })}><RotateCcw /></Button>}
                  </div>
                ) : (
                  <div className="pt-1.5 font-mono text-xs break-all">{s.value ?? s.default ?? '—'}</div>
                )}
                <div className="text-[11px] text-muted-foreground">
                  {value === '' && <span className="mr-1 font-medium text-foreground">{t('Empty value.')}</span>}
                  {value === undefined && tool.enabled && <span className="mr-1">{t('The default.')}</span>}
                  {s.description}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {!tool.enabled && <p className="text-[11px] text-muted-foreground">{t('Turn the tool on to change its settings.')}</p>}
      {!!edit.error && <ErrorBox error={errorText(edit.error)} />}
      {tool.enabled && edits.length > 0 && (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={edit.isPending} onClick={() => { setDraft(start()); edit.reset(); }}>{t('Cancel')}</Button>
          <Button size="sm" disabled={edit.isPending} onClick={() => edit.mutate(edits)}>{edit.isPending ? t('Working…') : t('Save settings')}</Button>
        </div>
      )}
    </div>
  );
}

function DoctorChecks({ result }: { result: DoctorResult }) {
  return (
    <div className="grid gap-1 rounded-lg border bg-muted/30 px-3 py-2" data-doctor={result.id}>
      <div className="flex items-center gap-2 text-xs font-medium">
        <Badge tone={result.ok ? 'success' : 'danger'}>{result.ok ? t('All checks passed') : t('A check failed')}</Badge>
      </div>
      {result.checks.map((c, i) => (
        <div key={i} className="flex items-start gap-2 text-xs">
          {c.ok ? <Check className="mt-0.5 size-3.5 shrink-0 text-success" aria-label={t('passed')} /> : <X className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-label={t('failed')} />}
          <span className="shrink-0 font-mono">{c.name}</span>
          <span className="min-w-0 break-words text-muted-foreground">{c.detail}</span>
        </div>
      ))}
    </div>
  );
}

/** One plugin: what it is, whether the project uses it, its settings, servers and their variables, operations and the doctor's checks. */
export function PluginCard({ project, tool, block, index, doctor, checking, onCheck }: {
  project: string; tool: PluginView; block: PluginsBlock; index: number; doctor?: DoctorResult; checking: boolean; onCheck: () => void;
}) {
  const edit = useEditConfig(project, 'project');
  const toggle = () => {
    if (tool.enabled) {
      const loses = toggleLoses(block, tool.id);
      if ((loses.settings || loses.kinds.length) && typeof window !== 'undefined'
        && !window.confirm(t('Turn {id} off? Its settings and the kinds that use it ({kinds}) are taken out of the project file too; the old file is kept as a backup.', { id: tool.id, kinds: loses.kinds.join(', ') || '—' }))) return;
    }
    edit.mutate(toggleEdits(block, tool.id, !tool.enabled));
  };
  const facts: { label: string; value: ReactNode }[] = [];
  if (tool.skill) facts.push({ label: t('Skill'), value: <span className="font-mono" title={tool.skill}>{baseName(tool.skill)}</span> });
  if (tool.cli) facts.push({ label: t('Command line'), value: <span className="font-mono">{tool.cli.program}{tool.cli.fallback ? ` (${t('fallback')})` : ''}</span> });
  if (tool.probe) facts.push({ label: t('Probe'), value: <span className="font-mono text-xs break-all">{commandLine(tool.probe[0] ?? '', tool.probe.slice(1))}</span> });
  if (tool.resources.length) facts.push({ label: t('Resources'), value: tool.resources.map(r => t('{name}, {n} at a time', { name: r.name, n: r.slots })).join('; ') });
  facts.push({ label: t('Used by kinds'), value: tool.kinds.length ? <span className="font-mono">{tool.kinds.join(', ')}</span> : '—' });
  return (
    <Card id={`tool-${tool.id}`} data-tool={tool.id} className="rise scroll-mt-20" style={nth(index)}>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="flex flex-wrap items-center gap-2 font-semibold">
              <span className="font-mono">{tool.id}</span>
              <Badge tone="outline">{tool.version}</Badge>
              <Badge tone={tool.enabled ? 'success' : 'neutral'}>{tool.enabled ? t('On') : t('Off')}</Badge>
              <Badge tone="outline">{tool.origin === 'built-in' ? t('built in') : t('the project’s own')}</Badge>
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{tool.description}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={checking} onClick={onCheck}><Stethoscope />{checking ? t('Checking…') : t('Check')}</Button>
            <Button size="sm" variant={tool.enabled ? 'ghost' : 'default'} disabled={edit.isPending} onClick={toggle}><Power />{tool.enabled ? t('Turn off') : t('Turn on')}</Button>
          </div>
        </div>
        {tool.problems.length > 0 && <div className="grid gap-1">{tool.problems.map((p, i) => <ErrorBox key={i} error={p} />)}</div>}
        {!!edit.error && <ErrorBox error={errorText(edit.error)} />}
        {doctor && <DoctorChecks result={doctor} />}
        <PluginSettings key={JSON.stringify(block.settings[tool.id] ?? null) + String(tool.enabled)} project={project} tool={tool} block={block} />
        {tool.servers.length > 0 && (
          <div className="grid gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">{t('MCP servers')}</h3>
            {tool.servers.map(s => (
              <div key={s.name} className="grid gap-1.5 rounded-lg border px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-medium">{s.name}</span>
                  {!s.workers && <Badge tone="outline">{t('for operations only')}</Badge>}
                  {s.engines && <Badge tone="outline">{t('engines: {list}', { list: s.engines.join(', ') })}</Badge>}
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground" title={commandLine(s.command, s.args)}>{commandLine(s.command, s.args)}</div>
                <div className="flex flex-wrap items-center gap-1">
                  <span className="mr-1 text-[11px] text-muted-foreground">{t('Tools')}</span>
                  {s.tools ? s.tools.map(x => <Badge key={x} tone="neutral" className="font-mono">{x}</Badge>) : <span className="text-[11px]">{t('all the server offers')}</span>}
                </div>
                {s.env.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="mr-1 text-[11px] text-muted-foreground">{t('Environment')}</span>
                    {s.env.map(e => <Badge key={e.name} tone={e.set ? 'success' : 'danger'} className="font-mono" title={e.set ? t('set where Alba runs') : t('not set where Alba runs')}>{e.set ? t('{name} is set', { name: e.name }) : t('{name} is missing', { name: e.name })}</Badge>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {tool.operations.length > 0 && (
          <div className="grid gap-1.5">
            <h3 className="text-xs font-medium text-muted-foreground">{t('Operations Alba runs')}</h3>
            {tool.operations.map(o => (
              <div key={o.name} className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="font-mono font-medium">{o.name}</span>
                {o.paid ? <Badge tone="warning">{o.paid.fixed !== undefined ? t('paid: {n} {unit}', { n: o.paid.fixed, unit: o.paid.unit }) : t('paid in {unit}', { unit: o.paid.unit })}</Badge> : <Badge tone="neutral">{t('free')}</Badge>}
                <span className="min-w-0 text-xs text-muted-foreground">{o.description}</span>
              </div>
            ))}
          </div>
        )}
        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
          {facts.map(f => <div key={f.label} className="min-w-0"><dt className="text-xs text-muted-foreground">{f.label}</dt><dd className="break-words">{f.value}</dd></div>)}
        </dl>
      </CardContent>
    </Card>
  );
}

/** `plugins.by_kind`: the tools every order of a kind uses. */
function KindTools({ project, view, block }: { project: string; view: PluginsView; block: PluginsBlock }) {
  const enabled = view.tools.filter(x => x.enabled).map(x => x.id);
  const [rows, setRows] = useState<KindRow[]>(() => kindRows(block.by_kind));
  const edit = useEditConfig(project, 'project');
  const out = kindEdits(block.by_kind, rows, enabled);
  const problems = out.problems.map(p => (p.key === 'kind' ? t('Each line needs a kind.') : p.key === 'twice' ? t('{name} is listed twice.', { name: p.name ?? '' }) : t('Turn on {names} first: a kind can only use tools that are on.', { names: p.name ?? '' })));
  const set = (i: number, patch: Partial<KindRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <EditCard title={t('Tools by kind')} description={t('Every order of the kind uses these tools, besides the ones it names itself.')}
      dirty={out.edits.length > 0 || problems.length > 0} pending={edit.isPending} error={edit.error} problems={problems}
      onCancel={() => { setRows(kindRows(block.by_kind)); edit.reset(); }} onSave={() => edit.mutate(out.edits)}>
      {rows.length === 0 && <p className="text-sm text-muted-foreground">{t('No kind uses a tool by itself.')}</p>}
      {rows.map((row, i) => (
        <div key={i} className="flex items-start gap-2">
          <Input value={row.kind} onChange={e => set(i, { kind: e.target.value })} placeholder={t('kind')} aria-label={t('Kind')} className="w-36 shrink-0 font-mono" />
          <ChipsInput label={t('Tools of {kind}', { kind: row.kind })} value={row.tools} options={enabled} onChange={tools => set(i, { tools })} className="flex-1" />
          <Button variant="ghost" size="icon" aria-label={t('Remove')} onClick={() => setRows(rows.filter((_, j) => j !== i))}><X /></Button>
        </div>
      ))}
      <div><Button size="sm" variant="outline" onClick={() => setRows([...rows, { kind: '', tools: [] }])}><Plus />{t('Add a kind')}</Button></div>
    </EditCard>
  );
}

/** `plugins.auto_approve`: the quotes of tool jobs Alba approves by itself, per unit, with what it approved today and ever. */
function AutoApprove({ project, view, block }: { project: string; view: PluginsView; block: PluginsBlock }) {
  const [rows, setRows] = useState<AutoRow[]>(() => autoRows(block.auto_approve));
  const edit = useEditConfig(project, 'project');
  const out = autoEdits(block.auto_approve, rows);
  const problems = out.problems.map(p => (p.key === 'unit' ? t('A unit is letters, digits, "-" and "_".') : p.key === 'twice' ? t('{name} is listed twice.', { name: p.unit ?? '' }) : p.key === 'per_job' ? t('{name}: one job’s amount is needed, a number >= 0.', { name: p.unit ?? '' }) : t('{name}: the limits must be numbers >= 0.', { name: p.unit ?? '' })));
  const set = (i: number, patch: Partial<AutoRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const used = (unit: string) => view.auto_approve.find(a => a.unit === unit.trim());
  const missing = view.units.filter(u => !rows.some(r => r.unit.trim() === u));
  return (
    <EditCard title={t('Approved by Alba')} description={t('Quotes of tool jobs Alba approves by itself: one job up to the first amount, a UTC day and the project in all up to the others. Without a line every quote waits for a person; an unpriced quote always does.')}
      dirty={out.edits.length > 0 || problems.length > 0} pending={edit.isPending} error={edit.error} problems={problems}
      onCancel={() => { setRows(autoRows(block.auto_approve)); edit.reset(); }} onSave={() => edit.mutate(out.edits)}>
      {rows.length === 0 && <p className="text-sm text-muted-foreground">{t('Alba approves no quote by itself.')}</p>}
      {rows.length > 0 && <div className="hidden grid-cols-[8rem_6rem_6rem_6rem_1fr_2rem] gap-2 text-xs text-muted-foreground sm:grid"><span>{t('Unit')}</span><span>{t('One job')}</span><span>{t('A day')}</span><span>{t('The project')}</span><span>{t('Approved so far')}</span></div>}
      {rows.map((row, i) => {
        const u = used(row.unit);
        return (
          <div key={i} className="grid items-center gap-2 sm:grid-cols-[8rem_6rem_6rem_6rem_1fr_2rem]">
            <Input value={row.unit} onChange={e => set(i, { unit: e.target.value })} aria-label={t('Unit')} className="font-mono" />
            <Input value={row.per_job} onChange={e => set(i, { per_job: e.target.value })} inputMode="decimal" aria-label={t('One job')} className="tabular-nums" />
            <Input value={row.per_day} onChange={e => set(i, { per_day: e.target.value })} inputMode="decimal" aria-label={t('A day')} placeholder={t('ten jobs')} className="tabular-nums" />
            <Input value={row.per_project} onChange={e => set(i, { per_project: e.target.value })} inputMode="decimal" aria-label={t('The project')} placeholder={t('no limit')} className="tabular-nums" />
            <span className="text-xs text-muted-foreground tabular-nums">{u ? t('{today} today, {ever} in all', { today: u.today, ever: u.ever }) : '—'}</span>
            <Button variant="ghost" size="icon" aria-label={t('Remove')} onClick={() => setRows(rows.filter((_, j) => j !== i))}><X /></Button>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-2">
        {missing.map(u => <Button key={u} size="sm" variant="outline" onClick={() => setRows([...rows, { unit: u, per_job: '0', per_day: '', per_project: '' }])}><Plus />{t('Add {unit}', { unit: u })}</Button>)}
        <Button size="sm" variant="outline" onClick={() => setRows([...rows, { unit: '', per_job: '', per_day: '', per_project: '' }])}><Plus />{t('Add a unit')}</Button>
      </div>
    </EditCard>
  );
}

function JobsTable({ project, jobs, count }: { project: string; jobs: ToolJobView[]; count: number }) {
  return (
    <Section title={t('Tool jobs')} count={count}>
      {jobs.length === 0 ? <Empty>{t('No tool job yet. A person starts one with alba tools run, the producer with a tool-call.')}</Empty> : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
            <thead><tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-4 py-1.5 font-medium">{t('Job')}</th><th className="px-2 py-1.5 font-medium">{t('Tool')}</th><th className="px-2 py-1.5 font-medium">{t('Order')}</th>
              <th className="px-2 py-1.5 font-medium">{t('Status')}</th><th className="px-2 py-1.5 font-medium">{t('Price quote')}</th><th className="px-2 py-1.5 font-medium">{t('Spent')}</th>
              <th className="px-2 py-1.5 font-medium">{t('Files')}</th><th className="px-4 py-1.5 font-medium">{t('Made')}</th>
            </tr></thead>
            <tbody className="divide-y">
              {jobs.map(j => (
                <tr key={j.id} className="align-top" data-job={j.id}>
                  <td className="px-4 py-2 font-mono text-xs font-semibold">{j.id}</td>
                  <td className="px-2 py-2 whitespace-nowrap"><span className="font-mono text-xs">{j.tool}/{j.operation}</span><div className="text-[11px] text-muted-foreground">{t('by {who}', { who: j.by })}</div></td>
                  <td className="px-2 py-2 whitespace-nowrap">{j.order ? <TagLink project={project} tag={j.order} /> : '—'}</td>
                  <td className="px-2 py-2">
                    <Badge tone={statusTone(j.status)}>{statusLabel(j.status)}</Badge>
                    {(j.error || j.waiting || j.warning) && <div className="mt-1 max-w-72 text-[11px] break-words text-muted-foreground">{j.error ?? j.waiting ?? j.warning}</div>}
                  </td>
                  <td className="px-2 py-2 text-xs whitespace-nowrap tabular-nums">
                    {j.quote ? <>{j.quote.amount !== undefined ? `${j.quote.amount} ${j.quote.unit}` : j.quote.unit}{j.quote.id ? ` · ${j.quote.id}` : ''}{j.quote.auto && <Badge tone="info" className="ml-1">{t('by Alba')}</Badge>}{j.quote.unpriced && <Badge tone="warning" className="ml-1">{t('unpriced')}</Badge>}</> : '—'}
                  </td>
                  <td className="px-2 py-2 text-xs tabular-nums">{j.spent !== undefined ? <>{j.spent}{j.spentUnknown && <span className="text-muted-foreground"> {t('(at most)')}</span>}</> : '—'}</td>
                  <td className="px-2 py-2 text-xs">{j.files?.length ? <span className="font-mono" title={j.files.join('\n')}>{j.files.map(baseName).join(', ')}</span> : '—'}</td>
                  <td className="px-4 py-2 text-xs whitespace-nowrap text-muted-foreground" title={dateTime(j.created)}>{ago(j.created)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {count > jobs.length && <p className="mt-2 text-xs text-muted-foreground">{t('The newest {n} of {count}; alba tools jobs lists them all.', { n: jobs.length, count })}</p>}
    </Section>
  );
}

/** The page's body, for a project's plugins and the `plugins` block of its file as written there. */
export function ToolsBody({ project, view, values }: { project: string; view: PluginsView; values: Values }) {
  const block = pluginsBlock(values);
  const doctor = usePluginDoctor(project);
  const [results, setResults] = useState<Record<string, DoctorResult>>({});
  const [checking, setChecking] = useState<string[] | null>(null);
  const check = (ids?: string[]) => {
    setChecking(ids ?? view.tools.filter(x => x.enabled).map(x => x.id));
    doctor.mutate(ids, {
      onSuccess: r => setResults(prev => ({ ...prev, ...Object.fromEntries(r.results.map(x => [x.id, x])) })),
      onSettled: () => setChecking(null),
    });
  };
  const k = (path: unknown) => JSON.stringify(path ?? null);
  return (
    <div className="grid gap-6">
      <Section title={<>{t('Plugins')} <span className="font-mono text-xs font-normal text-muted-foreground">{view.file}</span></>} count={view.tools.length}
        actions={<Button size="sm" variant="outline" disabled={!!checking || !view.tools.some(x => x.enabled)} onClick={() => check()}><Stethoscope />{t('Check the tools that are on')}</Button>}>
        {!!doctor.error && <div className="mb-3"><ErrorBox error={errorText(doctor.error)} /></div>}
        {view.problems.length > 0 && <div className="mb-3 grid gap-1">{view.problems.map((p, i) => <ErrorBox key={i} error={p} />)}</div>}
        {view.tools.length === 0 ? <Empty>{t('No plugin was found.')}</Empty> : (
          <div className="grid items-start gap-4 xl:grid-cols-2">
            {view.tools.map((tool, i) => (
              <PluginCard key={tool.id} project={project} tool={tool} block={block} index={i} doctor={results[tool.id]} checking={!!checking?.includes(tool.id)} onCheck={() => check([tool.id])} />
            ))}
          </div>
        )}
      </Section>
      <div className="grid gap-4">
        <KindTools key={k(block.by_kind) + k(view.tools.filter(x => x.enabled).map(x => x.id))} project={project} view={view} block={block} />
        <AutoApprove key={k(block.auto_approve)} project={project} view={view} block={block} />
      </div>
      <JobsTable project={project} jobs={view.jobs} count={view.jobCount} />
    </div>
  );
}

export function ToolsPage() {
  const project = useProjectId();
  const plugins = usePlugins(project);
  const config = useConfig(project, 'project');
  const error = plugins.error ?? config.error;
  return (
    <div>
      <PageHeader title={t('Tools')}>{t('The tool plugins this project can use: what each one brings, whether it is on, its settings and what the last tool jobs did. A change is checked with the whole project file before it is written.')}</PageHeader>
      {error ? <ErrorBox error={error} /> : !plugins.data || !config.data ? <Skeleton className="h-64" /> : plugins.data.tools.length === 0 && plugins.data.jobs.length === 0
        ? <EmptyState icon={<Wrench />} title={t('No tool plugin')}>{t('Alba found no plugin, built in or in the project’s plugins.sources.')}</EmptyState>
        : <ToolsBody project={project} view={plugins.data} values={config.data.values} />}
    </div>
  );
}
