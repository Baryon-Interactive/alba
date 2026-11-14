import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { ConfigView } from '@api';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Checkbox, Skeleton } from '@/components/ui/misc';
import { ErrorBox, PageHeader, Section } from '@/components/common';
import { ChipsInput, EditCard, Field } from '@/components/EditFields';
import { ApiFailure, type ConfigEdit } from '@/lib/api';
import { numberField, parseSection, same, sectionEdit, valueAt } from '@/lib/config-edit';
import { useConfig, useEditConfig, useProjectId, useSkills } from '@/lib/queries';
import { t } from '@/i18n';

type Values = Record<string, unknown>;
const record = (v: unknown): v is Values => !!v && typeof v === 'object' && !Array.isArray(v);
const words = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const text = (v: unknown) => (v === undefined || v === null ? '' : String(v));

/** The numbers of `dispatch`, with the default the loader uses when one is not written (src/config.ts). */
const DISPATCH_NUMBERS: { key: string; label: string; whole?: boolean; fallback?: number }[] = [
  { key: 'rework_reserve', label: 'Extra slots for rework', whole: true, fallback: 1 },
  { key: 'stall_minutes', label: 'Stalled after (minutes)' },
  { key: 'long_command_minutes', label: 'A long command may run (minutes)', fallback: 240 },
  { key: 'start_receipt_minutes', label: 'Failed to start after (minutes)', fallback: 15 },
  { key: 'commit_nudge_minutes', label: 'Commit reminder after (minutes)', fallback: 45 },
  { key: 'min_free_ram_gb', label: 'Free memory to start a run (GB)' },
  { key: 'loop_idle_minutes', label: 'Idling after (minutes)', fallback: 45 },
  { key: 'loop_repeat', label: 'Same failing command, times', fallback: 3 },
  { key: 'loop_alternate', label: 'Two commands taking turns, rounds', fallback: 6 },
  { key: 'lingering_minutes', label: 'Lingering after the report (minutes)', fallback: 10 },
];

/** Dispatch: how many orders of a kind run at once, when a run counts as stalled, looping or lingering, and what then happens. */
export function DispatchSettings({ project, values }: { project: string; values: Values }) {
  const before = record(values.dispatch) ? values.dispatch : {};
  const start = () => ({
    caps: Object.entries(record(before.caps) ? before.caps : {}).map(([kind, n]) => ({ kind, n: text(n) })),
    numbers: Object.fromEntries(DISPATCH_NUMBERS.map(f => [f.key, text(before[f.key])])) as Record<string, string>,
    on_loop: text(before.on_loop), on_lingering: text(before.on_lingering), merge: text(before.merge), long_commands: words(before.long_commands),
  });
  const [draft, setDraft] = useState(start);
  const edit = useEditConfig(project, 'project');
  const problems: string[] = [];
  const caps: Values = {};
  for (const row of draft.caps) {
    const kind = row.kind.trim();
    if (!kind && !row.n.trim()) continue;
    const n = numberField(row.n);
    if (!kind) problems.push(t('Each cap needs a kind.'));
    else if (Object.hasOwn(caps, kind)) problems.push(t('{name} is listed twice.', { name: kind }));
    else if (!n.ok || n.value === undefined || !Number.isInteger(n.value) || n.value < 0) problems.push(t('The cap of {name} must be a whole number >= 0.', { name: kind }));
    else caps[kind] = n.value;
  }
  const edits: ConfigEdit[] = [...sectionEdit(['dispatch', 'caps'], before.caps, caps)];
  for (const f of DISPATCH_NUMBERS) {
    const n = numberField(draft.numbers[f.key]);
    if (!n.ok || (n.value !== undefined && (n.value < 0 || (f.whole && !Number.isInteger(n.value))))) { problems.push(t('{name} must be a number >= 0.', { name: t(f.label) })); continue; }
    edits.push(...sectionEdit(['dispatch', f.key], before[f.key], n.value));
  }
  for (const key of ['on_loop', 'on_lingering', 'merge'] as const) edits.push(...sectionEdit(['dispatch', key], before[key], draft[key] || undefined));
  edits.push(...sectionEdit(['dispatch', 'long_commands'], before.long_commands, draft.long_commands));
  const set = (patch: Partial<ReturnType<typeof start>>) => setDraft({ ...draft, ...patch });
  const setCap = (i: number, patch: Partial<{ kind: string; n: string }>) => set({ caps: draft.caps.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const action = (key: 'on_loop' | 'on_lingering', label: string) => (
    <Field label={label}>
      <Select value={draft[key]} aria-label={label} onChange={e => set({ [key]: e.target.value })}>
        <option value="">{t('report it (default)')}</option><option value="report">{t('report it')}</option><option value="stop">{t('stop the process and report it')}</option>
      </Select>
    </Field>
  );
  return (
    <EditCard title={t('Dispatch')} description={t('How many orders of a kind run at once, and when a run counts as stalled, looping or lingering. An empty field uses the default.')}
      dirty={edits.length > 0} pending={edit.isPending} error={edit.error} problems={problems} onCancel={() => { setDraft(start()); edit.reset(); }} onSave={() => edit.mutate(edits)}>
      <Field label={t('Caps by kind')} hint={t('At most this many orders of the kind run at once.')}>
        <div className="grid gap-1.5">
          {draft.caps.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input value={row.kind} onChange={e => setCap(i, { kind: e.target.value })} placeholder={t('kind')} aria-label={t('Kind')} className="w-48 font-mono" />
              <Input value={row.n} onChange={e => setCap(i, { n: e.target.value })} inputMode="numeric" aria-label={t('Cap')} className="w-24 tabular-nums" />
              <Button variant="ghost" size="icon" aria-label={t('Remove')} onClick={() => set({ caps: draft.caps.filter((_, j) => j !== i) })}><X /></Button>
            </div>
          ))}
          <div><Button size="sm" variant="outline" onClick={() => set({ caps: [...draft.caps, { kind: '', n: '1' }] })}><Plus />{t('Add a cap')}</Button></div>
        </div>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {DISPATCH_NUMBERS.map(f => (
          <Field key={f.key} label={t(f.label)}>
            <Input value={draft.numbers[f.key]} inputMode="decimal" aria-label={t(f.label)} className="tabular-nums" placeholder={f.fallback === undefined ? t('not set') : t('default {n}', { n: f.fallback })}
              onChange={e => set({ numbers: { ...draft.numbers, [f.key]: e.target.value } })} />
          </Field>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {action('on_loop', t('When a run loops'))}
        {action('on_lingering', t('When a run lingers after its report'))}
        <Field label={t('Merge')}>
          <Select value={draft.merge} aria-label={t('Merge')} onChange={e => set({ merge: e.target.value })}>
            <option value="">{t('a person merges (default)')}</option><option value="manual">{t('manual')}</option>
          </Select>
        </Field>
      </div>
      <Field label={t('Long commands')} hint={t('Words of commands that may run for a long time; they never count as idling.')}>
        <ChipsInput label={t('Long commands')} value={draft.long_commands} onChange={long_commands => set({ long_commands })} />
      </Field>
    </EditCard>
  );
}

interface ResourceRow { name: string; slots: string; exclusive: boolean; note: string; rest: Values }

/** Resources: the shared things orders hold a lease on (a machine, a lane of builds), with how many at a time. */
export function ResourceSettings({ project, values }: { project: string; values: Values }) {
  const before = record(values.resources) ? values.resources : undefined;
  const start = (): ResourceRow[] => Object.entries(before ?? {}).map(([name, v]) => {
    const { slots, exclusive, note, ...rest } = record(v) ? v : {};
    return { name, slots: text(slots), exclusive: exclusive === true, note: text(note), rest: { ...rest, ...(exclusive !== undefined ? { exclusive } : {}) } };
  });
  const [rows, setRows] = useState(start);
  const edit = useEditConfig(project, 'project');
  const problems: string[] = [];
  const after: Values = {};
  for (const r of rows) {
    const name = r.name.trim();
    const slots = numberField(r.slots);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) { problems.push(t('A resource name is letters, digits, ".", "-" and "_".')); continue; }
    if (Object.hasOwn(after, name)) { problems.push(t('{name} is listed twice.', { name })); continue; }
    if (!slots.ok || slots.value === undefined || !Number.isInteger(slots.value) || slots.value < 1) { problems.push(t('The slots of {name} must be a whole number >= 1.', { name })); continue; }
    const { exclusive: was, ...rest } = r.rest;
    after[name] = { ...rest, slots: slots.value, ...(r.exclusive ? { exclusive: true } : was !== undefined ? { exclusive: false } : {}), ...(r.note.trim() ? { note: r.note.trim() } : {}) };
  }
  // The order of the keys inside a resource does not matter; only what they say.
  const unchanged = !!before && Object.keys(after).length === Object.keys(before).length && Object.entries(after).every(([k, v]) => record(before[k]) && same(sorted(before[k] as Values), sorted(v as Values)));
  const edits = unchanged ? [] : sectionEdit(['resources'], before, after);
  const set = (i: number, patch: Partial<ResourceRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <EditCard title={t('Resources')} description={t('Shared things orders hold a lease on while they run: at most this many leases at a time. An exclusive one also keeps other orders of the kinds it blocks from starting.')}
      dirty={edits.length > 0} pending={edit.isPending} error={edit.error} problems={problems} onCancel={() => { setRows(start()); edit.reset(); }} onSave={() => edit.mutate(edits)}>
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">{t('No resource is declared.')}</p> : (
        <div className="grid gap-1.5">
          <div className="hidden grid-cols-[12rem_6rem_7rem_1fr_2rem] gap-2 text-xs text-muted-foreground sm:grid"><span>{t('Name')}</span><span>{t('Slots')}</span><span>{t('Exclusive')}</span><span>{t('Note')}</span></div>
          {rows.map((r, i) => (
            <div key={i} className="grid items-center gap-2 sm:grid-cols-[12rem_6rem_7rem_1fr_2rem]">
              <Input value={r.name} onChange={e => set(i, { name: e.target.value })} aria-label={t('Name')} className="font-mono" />
              <Input value={r.slots} onChange={e => set(i, { slots: e.target.value })} inputMode="numeric" aria-label={t('Slots')} className="tabular-nums" />
              <label className="flex items-center gap-2 text-sm"><Checkbox checked={r.exclusive} onCheckedChange={v => set(i, { exclusive: v === true })} aria-label={t('Exclusive')} />{t('Exclusive')}</label>
              <Input value={r.note} onChange={e => set(i, { note: e.target.value })} aria-label={t('Note')} />
              <Button variant="ghost" size="icon" aria-label={t('Remove {name}', { name: r.name })} onClick={() => setRows(rows.filter((_, j) => j !== i))}><X /></Button>
            </div>
          ))}
        </div>
      )}
      <div><Button size="sm" variant="outline" onClick={() => setRows([...rows, { name: '', slots: '1', exclusive: false, note: '', rest: {} }])}><Plus />{t('Add a resource')}</Button></div>
    </EditCard>
  );
}

const sorted = (v: Values) => Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)));

/** Skills: the ones every order gets, the ones each kind gets, and how many an order may get at most. */
export function SkillSettings({ project, values }: { project: string; values: Values }) {
  const before = { always: valueAt(values, ['skills', 'always']), by_kind: valueAt(values, ['skills', 'by_kind']), max: valueAt(values, ['skills', 'max_per_order']) };
  const start = () => ({ always: words(before.always), byKind: Object.entries(record(before.by_kind) ? before.by_kind : {}).map(([kind, list]) => ({ kind, skills: words(list) })), max: text(before.max) });
  const [draft, setDraft] = useState(start);
  const skills = useSkills(project);
  const names = (skills.data?.skills ?? []).map(s => s.name);
  const edit = useEditConfig(project, 'project');
  const problems: string[] = [];
  const byKind: Values = {};
  for (const row of draft.byKind) {
    const kind = row.kind.trim();
    if (!kind && !row.skills.length) continue;
    if (!kind) problems.push(t('Each line needs a kind.'));
    else if (Object.hasOwn(byKind, kind)) problems.push(t('{name} is listed twice.', { name: kind }));
    else byKind[kind] = row.skills;
  }
  const max = numberField(draft.max);
  if (!max.ok || (max.value !== undefined && (!Number.isInteger(max.value) || max.value < 1))) problems.push(t('{name} must be a whole number >= 1.', { name: t('Skills per order at most') }));
  const edits = [...sectionEdit(['skills', 'always'], before.always, draft.always), ...sectionEdit(['skills', 'by_kind'], before.by_kind, byKind), ...(max.ok ? sectionEdit(['skills', 'max_per_order'], before.max, max.value) : [])];
  const setRow = (i: number, patch: Partial<{ kind: string; skills: string[] }>) => setDraft({ ...draft, byKind: draft.byKind.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <EditCard title={t('Skills')} description={t('Skills every order gets, and the ones each kind of order gets on top.')}
      dirty={edits.length > 0} pending={edit.isPending} error={edit.error} problems={problems} onCancel={() => { setDraft(start()); edit.reset(); }} onSave={() => edit.mutate(edits)}>
      <Field label={t('Every order')}><ChipsInput label={t('Every order')} value={draft.always} options={names} onChange={always => setDraft({ ...draft, always })} /></Field>
      <Field label={t('By kind')}>
        <div className="grid gap-1.5">
          {draft.byKind.map((row, i) => (
            <div key={i} className="flex items-start gap-2">
              <Input value={row.kind} onChange={e => setRow(i, { kind: e.target.value })} placeholder={t('kind')} aria-label={t('Kind')} className="w-40 shrink-0 font-mono" />
              <ChipsInput label={t('Skills of {kind}', { kind: row.kind })} value={row.skills} options={names} onChange={list => setRow(i, { skills: list })} className="flex-1" />
              <Button variant="ghost" size="icon" aria-label={t('Remove')} onClick={() => setDraft({ ...draft, byKind: draft.byKind.filter((_, j) => j !== i) })}><X /></Button>
            </div>
          ))}
          <div><Button size="sm" variant="outline" onClick={() => setDraft({ ...draft, byKind: [...draft.byKind, { kind: '', skills: [] }] })}><Plus />{t('Add a kind')}</Button></div>
        </div>
      </Field>
      <Field label={t('Skills per order at most')} className="max-w-56">
        <Input value={draft.max} onChange={e => setDraft({ ...draft, max: e.target.value })} inputMode="numeric" placeholder={t('default {n}', { n: 16 })} aria-label={t('Skills per order at most')} className="tabular-nums" />
      </Field>
    </EditCard>
  );
}

/** A section with a nested shape, edited as JSON and sent whole: an empty box removes the section. */
export function JsonSettings({ project, view, path, title, description }: { project: string; view: ConfigView; path: string[]; title: string; description: string }) {
  const before = valueAt(view.values, path);
  const start = () => (before === undefined ? '' : JSON.stringify(before, null, 2));
  const [draft, setDraft] = useState(start);
  const edit = useEditConfig(project, view.target);
  const parsed = parseSection(draft);
  const edits = parsed.ok ? sectionEdit(path, before, parsed.value) : [];
  return (
    <EditCard title={title} description={<>{description} {t('Written as JSON; an empty box removes the section.')}</>}
      dirty={edits.length > 0 || !parsed.ok} pending={edit.isPending} error={edit.error} problems={parsed.ok ? [] : [t('Not valid JSON: {problem}', { problem: parsed.error })]}
      onCancel={() => { setDraft(start()); edit.reset(); }} onSave={() => edit.mutate(edits)}>
      <Textarea value={draft} onChange={e => { setDraft(e.target.value); edit.reset(); }} spellCheck={false} aria-label={title} aria-invalid={!parsed.ok} className="min-h-32 font-mono text-xs leading-5 whitespace-pre" placeholder={t('(not set)')} />
    </EditCard>
  );
}

/** Settings of the project file (and the quota sources of the workers file), each section saved on its own. */
export function SettingsBody({ project, own, shared }: { project: string; own: ConfigView; shared?: ConfigView }) {
  const k = (path: string[], view: ConfigView = own) => `${view.target}:${JSON.stringify(valueAt(view.values, path) ?? null)}`;
  return (
    <div className="grid gap-6">
      <Section title={<>{t('Project file')} <span className="font-mono text-xs font-normal text-muted-foreground">{own.file}</span></>}>
        <div className="grid gap-4">
          <DispatchSettings key={k(['dispatch'])} project={project} values={own.values} />
          <ResourceSettings key={k(['resources'])} project={project} values={own.values} />
          <SkillSettings key={k(['skills'])} project={project} values={own.values} />
          <JsonSettings key={k(['budget'])} project={project} view={own} path={['budget']} title={t('Budget')} description={t('Tokens and cost a day and per order: tokens_per_day, tokens_per_order, cost_per_day, currency.')} />
          <JsonSettings key={k(['usage_warnings'])} project={project} view={own} path={['usage_warnings']} title={t('Usage warnings')} description={t('When a run’s use of tokens is reported as waste.')} />
          <JsonSettings key={k(['clean'])} project={project} view={own} path={['clean']} title={t('Clean')} description={t('What alba clean may remove, and how much it keeps.')} />
        </div>
      </Section>
      {shared && (
        <Section title={<>{t('Workers file')} <span className="font-mono text-xs font-normal text-muted-foreground">{shared.file}</span></>}>
          <JsonSettings key={k(['quota_sources'], shared)} project={project} view={shared} path={['quota_sources']} title={t('Quota sources')} description={t('Where the usage windows and balances of the workers are read from.')} />
        </Section>
      )}
    </div>
  );
}

export function SettingsPage() {
  const project = useProjectId();
  const own = useConfig(project, 'project');
  const shared = useConfig(project, 'workers');
  return (
    <div>
      <PageHeader title={t('Settings')}>{t('The settings of the project file. Each section is checked with the whole file before it is written; comments are kept and the old file is copied next to it.')}</PageHeader>
      {own.isError ? <ErrorBox error={own.error} /> : !own.data ? <Skeleton className="h-64" /> : (
        <>
          {shared.isError && !(shared.error instanceof ApiFailure && shared.error.status === 404) && <div className="mb-4"><ErrorBox error={shared.error} /></div>}
          <SettingsBody project={project} own={own.data} shared={shared.data} />
        </>
      )}
    </div>
  );
}
