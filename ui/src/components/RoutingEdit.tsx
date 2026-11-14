import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2, Wand2, X } from 'lucide-react';
import type { ConfigView, RoutingMigration } from '@api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { Checkbox, Skeleton } from '@/components/ui/misc';
import { ErrorBox, Section } from '@/components/common';
import { ChipsInput, EditCard, Field } from '@/components/EditFields';
import { ApiFailure, type ConfigTarget } from '@/lib/api';
import { errorText, useConfig, useEditConfig, useRoutingMigration, useWorkers } from '@/lib/queries';
import { ANYONE, addMember, groupUsers, hasLegacyRoles, moveMember, renameGroup, routingEdits, routingOf, validName, withAnyone, type RouteDraft, type RoutingDraft } from '@/lib/config-edit';
import { t } from '@/i18n';

const fileTitle = (target: ConfigTarget) => (target === 'project' ? t('Project file') : t('Workers file'));

/** One worker group being edited: its members in order, "anyone else", its name, and whether it may be deleted. */
export function GroupEditor({ name, members, blockedBy, elsewhere = [], choices, taken, onChange, onRename, onDelete }: {
  /** `blockedBy`: the routes that keep it from being deleted; `elsewhere`: those of them in the other file, which keep it from being renamed here. */
  name: string; members: string[]; blockedBy: string[]; elsewhere?: string[]; choices: string[]; taken: string[];
  onChange: (members: string[]) => void; onRename: (to: string) => void; onDelete: () => void;
}) {
  const [label, setLabel] = useState(name);
  const listed = members.filter(m => m !== ANYONE);
  const open = members.includes(ANYONE);
  const renameProblem = label === name ? undefined : !validName(label) ? t('A name is letters, digits, "-" and "_".') : taken.includes(label) ? t('{name} already exists.', { name: label }) : elsewhere.length ? t('Used by {routes} in the other file: rename it there first.', { routes: elsewhere.join(', ') }) : undefined;
  const rename = () => { if (label !== name && !renameProblem) onRename(label); };
  return (
    <div className="grid content-start gap-2.5 rounded-xl border bg-card p-4" data-group={name}>
      <div className="flex items-center gap-2">
        <Input value={label} onChange={e => setLabel(e.target.value)} onBlur={rename} onKeyDown={e => { if (e.key === 'Enter') rename(); }} aria-label={t('Group name')} className="h-8 font-mono font-semibold" />
        <Button variant="ghost" size="icon" aria-label={t('Delete group {name}', { name })} title={blockedBy.length ? t('Used by {routes}', { routes: blockedBy.join(', ') }) : t('Delete')} disabled={blockedBy.length > 0} onClick={onDelete}><Trash2 className="size-4" /></Button>
      </div>
      {renameProblem && <span className="text-xs text-destructive">{renameProblem}</span>}
      {listed.length === 0 ? <p className="text-xs text-muted-foreground">{t('No member yet.')}</p> : (
        <ol className="grid gap-1">
          {listed.map((m, i) => (
            <li key={m} className="flex items-center gap-1.5 text-sm">
              <span className="w-5 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate rounded-full border bg-background px-2 py-0.5 font-mono text-xs">{m}</span>
              <Button variant="ghost" size="icon" className="size-7" aria-label={t('Move {name} up', { name: m })} disabled={i === 0} onClick={() => onChange(moveMember(members, members.indexOf(m), -1))}><ArrowUp className="size-3.5" /></Button>
              <Button variant="ghost" size="icon" className="size-7" aria-label={t('Move {name} down', { name: m })} disabled={i === listed.length - 1} onClick={() => onChange(moveMember(members, members.indexOf(m), 1))}><ArrowDown className="size-3.5" /></Button>
              <Button variant="ghost" size="icon" className="size-7" aria-label={t('Remove {name}', { name: m })} onClick={() => onChange(members.filter(x => x !== m))}><X className="size-3.5" /></Button>
            </li>
          ))}
        </ol>
      )}
      <Select value="" aria-label={t('Add a member')} onChange={e => { if (e.target.value) onChange(addMember(members, e.target.value)); }} className="h-8 text-xs">
        <option value="">{t('Add a member…')}</option>
        {choices.filter(c => !members.includes(c) && c !== name).map(c => <option key={c} value={c}>{c}</option>)}
      </Select>
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={open} onCheckedChange={v => onChange(withAnyone(members, v === true))} />{t('Then anyone else')}</label>
      <p className="text-xs text-muted-foreground">{blockedBy.length ? t('Used by {routes}', { routes: blockedBy.join(', ') }) : t('No route uses it')}</p>
    </div>
  );
}

/** One route being edited: the kinds it takes, what it requires, its group, the workers it avoids, whether it is the default. */
export function RouteEditor({ id, route, groups, workerIds, capabilities, onChange, onDelete }: {
  id: string; route: RouteDraft; groups: string[]; workerIds: string[]; capabilities: string[]; onChange: (r: RouteDraft) => void; onDelete: () => void;
}) {
  const set = (patch: Partial<RouteDraft>) => onChange({ ...route, ...patch });
  const ownList = !route.group && !!route.workers;
  // A group orders and limits the workers itself: of a list of its own the route keeps only the workers it avoids.
  const pickGroup = (group: string) => {
    if (!group) return set({ group: undefined });
    const avoid = (route.workers as { avoid?: string[] } | undefined)?.avoid;
    set({ group, workers: avoid?.length ? { avoid } : undefined });
  };
  return (
    <article className="grid gap-3 rounded-xl border bg-card p-4" data-route={id}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-mono text-[15px] font-semibold">{id}{route.default && <Badge tone="primary" className="ml-2 font-sans">{t('Default')}</Badge>}</h3>
        <Button variant="ghost" size="icon" aria-label={t('Delete route {name}', { name: id })} title={t('Delete')} onClick={onDelete}><Trash2 className="size-4" /></Button>
      </div>
      <Field label={t('Description')}><Input value={route.description ?? ''} onChange={e => set({ description: e.target.value })} aria-label={t('Description')} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('Kinds')} hint={t('Enter adds one.')}><ChipsInput label={t('Kinds')} value={route.kinds ?? []} onChange={kinds => set({ kinds })} /></Field>
        <Field label={t('Requires')}><ChipsInput label={t('Requires')} value={route.requires ?? []} options={capabilities} onChange={requires => set({ requires })} /></Field>
        <Field label={t('Worker group')} hint={ownList ? t('This route lists its own workers; choosing a group replaces that list.') : undefined}>
          <Select value={route.group ?? ''} aria-label={t('Worker group')} onChange={e => pickGroup(e.target.value)}>
            <option value="">{t('(none)')}</option>
            {groups.map(g => <option key={g} value={g}>{g}</option>)}
          </Select>
        </Field>
        <Field label={t('Never chosen by itself')}><ChipsInput label={t('Never chosen by itself')} value={route.avoid ?? []} options={workerIds} onChange={avoid => set({ avoid })} /></Field>
      </div>
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={route.default === true} onCheckedChange={v => set({ default: v === true })} />{t('Default route: takes every kind no other route takes')}</label>
    </article>
  );
}

/** The roles → routing conversion of one file: a preview of the routing that replaces its roles, then one write. */
function ConvertRoles({ project, target, file }: { project: string; target: ConfigTarget; file: RoutingMigration['files'][number] | undefined }) {
  const [open, setOpen] = useState(false);
  const edit = useEditConfig(project, target);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/8 px-3 py-2.5 text-sm">
      <span className="flex-1">{t('This file still routes with roles. Convert them to worker groups and routes to edit them here.')}</span>
      <Button size="sm" variant="outline" disabled={!file} onClick={() => { edit.reset(); setOpen(true); }}><Wand2 />{t('Convert to routing')}</Button>
      {file && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="w-[min(94vw,44rem)]">
            <DialogTitle>{t('Convert to routing')}</DialogTitle>
            <DialogDescription>{t('The roles of {file} are replaced by this routing, which sends every order where it went before. The old file is copied next to it first.', { file: file.file })}</DialogDescription>
            <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre">{file.yaml}</pre>
            {file.notes.length > 0 && <ul className="grid gap-1 text-xs text-muted-foreground">{file.notes.map((n, i) => <li key={i}>· {n}</li>)}</ul>}
            {edit.isError && <ErrorBox error={errorText(edit.error)} />}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>{t('Back')}</Button>
              <Button disabled={edit.isPending} onClick={() => edit.mutate([{ path: ['roles'] }, { path: ['routing'], value: file.routing }], { onSuccess: () => setOpen(false) })}>{edit.isPending ? t('Working…') : t('Convert')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/** The routing of one file being edited; Save writes every change in one request. */
export function RoutingFileEditor({ project, view, other, otherTarget, workerIds, capabilities, migration }: {
  project: string; view: ConfigView; other?: RoutingDraft; otherTarget?: ConfigTarget; workerIds: string[]; capabilities: string[]; migration?: RoutingMigration['files'][number];
}) {
  const initial = useMemo(() => routingOf(view.values), [view.values]);
  const [draft, setDraft] = useState<RoutingDraft>(initial);
  const [newGroup, setNewGroup] = useState('');
  const [newRoute, setNewRoute] = useState('');
  const [round, setRound] = useState(0);
  const edit = useEditConfig(project, view.target);
  const edits = routingEdits(initial, draft);
  const allGroups = [...new Set([...Object.keys(draft.groups), ...Object.keys(other?.groups ?? {})])];
  const choices = [...new Set([...workerIds, ...allGroups])];
  const otherUsers = (name: string) => (other && !Object.hasOwn(other.groups, name) ? groupUsers(other, name) : []);
  const blockedBy = (name: string) => (other && Object.hasOwn(other.groups, name) ? [] : [...groupUsers(draft, name), ...otherUsers(name)]);
  const setGroups = (groups: Record<string, string[]>) => setDraft({ ...draft, groups });
  const groupProblem = newGroup && (!validName(newGroup) ? t('A name is letters, digits, "-" and "_".') : Object.hasOwn(draft.groups, newGroup) ? t('{name} already exists.', { name: newGroup }) : undefined);
  const routeProblem = newRoute && (!validName(newRoute) ? t('A name is letters, digits, "-" and "_".') : Object.hasOwn(draft.routes, newRoute) ? t('{name} already exists.', { name: newRoute }) : undefined);
  const problems = [
    ...Object.entries(draft.groups).filter(([, m]) => !m.length).map(([g]) => t('Group {name} has no member.', { name: g })),
    ...(Object.values(draft.routes).filter(r => r.default).length + (draft.default ? 1 : 0) > 1 ? [t('Only one route can be the default (or a default group).')] : []),
  ];
  if (hasLegacyRoles(view.values)) return (
    <Section title={<>{fileTitle(view.target)} <span className="font-mono text-xs font-normal text-muted-foreground">{view.file}</span></>}>
      <ConvertRoles project={project} target={view.target} file={migration} />
    </Section>
  );
  return (
    <Section title={<>{fileTitle(view.target)} <span className="font-mono text-xs font-normal text-muted-foreground">{view.file}</span></>}>
      <EditCard
        title={t('Routing in this file')}
        description={otherTarget ? t('Groups of the project file replace the workers file’s groups of the same name.') : undefined}
        dirty={edits.length > 0} pending={edit.isPending} error={edit.error} problems={problems}
        onCancel={() => { setDraft(initial); setRound(r => r + 1); edit.reset(); }} onSave={() => edit.mutate(edits)}
      >
        <div className="grid gap-2">
          <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t('Worker groups')}</h4>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Object.entries(draft.groups).map(([name, members]) => (
              <GroupEditor key={`${round}:${name}`} name={name} members={members} blockedBy={blockedBy(name)} elsewhere={otherUsers(name)} choices={choices} taken={Object.keys(draft.groups)}
                onChange={m => setGroups({ ...draft.groups, [name]: m })}
                onRename={to => { if (!otherUsers(name).length) setDraft(renameGroup(draft, name, to)); }}
                onDelete={() => setGroups(Object.fromEntries(Object.entries(draft.groups).filter(([k]) => k !== name)))} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input value={newGroup} onChange={e => setNewGroup(e.target.value)} placeholder={t('New group name')} aria-label={t('New group name')} className="h-8 w-48 font-mono" />
            <Button size="sm" variant="outline" disabled={!newGroup || !!groupProblem} onClick={() => { setGroups({ ...draft.groups, [newGroup]: [] }); setNewGroup(''); }}><Plus />{t('Add a group')}</Button>
            {groupProblem && <span className="text-xs text-destructive">{groupProblem}</span>}
          </div>
        </div>
        <div className="grid gap-2">
          <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t('Routes')}</h4>
          {Object.keys(draft.routes).length === 0 && <p className="text-sm text-muted-foreground">{t('No route in this file.')}</p>}
          {Object.entries(draft.routes).map(([id, route]) => (
            <RouteEditor key={`${round}:${id}`} id={id} route={route} groups={allGroups} workerIds={workerIds} capabilities={capabilities}
              onChange={r => setDraft({ ...draft, routes: { ...draft.routes, [id]: r } })}
              onDelete={() => setDraft({ ...draft, routes: Object.fromEntries(Object.entries(draft.routes).filter(([k]) => k !== id)) })} />
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Input value={newRoute} onChange={e => setNewRoute(e.target.value)} placeholder={t('New route name')} aria-label={t('New route name')} className="h-8 w-48 font-mono" />
            <Button size="sm" variant="outline" disabled={!newRoute || !!routeProblem} onClick={() => { setDraft({ ...draft, routes: { ...draft.routes, [newRoute]: {} } }); setNewRoute(''); }}><Plus />{t('Add a route')}</Button>
            {routeProblem && <span className="text-xs text-destructive">{routeProblem}</span>}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('Group of the orders no route takes')}>
            <Select value={draft.default ?? ''} aria-label={t('Group of the orders no route takes')} onChange={e => setDraft({ ...draft, default: e.target.value || undefined })}>
              <option value="">{t('(none)')}</option>
              {allGroups.map(g => <option key={g} value={g}>{g}</option>)}
            </Select>
          </Field>
          <Field label={t('Never chosen by itself, on every route')}><ChipsInput label={t('Never chosen by itself, on every route')} value={draft.avoid ?? []} options={workerIds} onChange={avoid => setDraft({ ...draft, avoid })} /></Field>
        </div>
      </EditCard>
    </Section>
  );
}

const missing = (e: unknown) => e instanceof ApiFailure && e.status === 404;

/** Edit mode of the Routing page: the routing of the project file and of the workers file, each saved on its own. */
export function RoutingEditor({ project }: { project: string }) {
  const own = useConfig(project, 'project');
  const shared = useConfig(project, 'workers');
  const migration = useRoutingMigration(project);
  const workers = useWorkers(project);
  const workerIds = (workers.data?.workers ?? []).map(w => w.id);
  const capabilities = [...new Set((workers.data?.workers ?? []).flatMap(w => w.capabilities))];
  if (own.isError) return <ErrorBox error={own.error} />;
  if (!own.data || (shared.isPending && !shared.isError)) return <Skeleton className="h-64" />;
  const views = [own.data, ...(shared.data ? [shared.data] : [])];
  return (
    <div>
      {shared.isError && !missing(shared.error) && <div className="mb-4"><ErrorBox error={shared.error} /></div>}
      {views.map(view => {
        const otherView = views.find(v => v !== view);
        return <RoutingFileEditor key={`${view.target}:${JSON.stringify(view.values)}`} project={project} view={view} other={otherView ? routingOf(otherView.values) : undefined} otherTarget={otherView?.target}
          workerIds={workerIds} capabilities={capabilities} migration={migration.data?.files.find(f => f.target === view.target)} />;
      })}
    </div>
  );
}
