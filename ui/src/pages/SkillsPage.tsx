import { useMemo, useState } from 'react';
import { AlertTriangle, Ban, FolderOpen, Puzzle } from 'lucide-react';
import type { SkillsView } from '@api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/misc';
import { Empty, ErrorBox, PageHeader, Section, TagLink } from '@/components/common';
import { errorText, useProjectId, useSkills, useSkillUse } from '@/lib/queries';
import { layerLabel, layerTone } from '@/lib/routing';
import { skillColumns, skillMatches, useAction } from '@/lib/skills';
import { ConfigPanel, SkillSettings, configKey, useEditToggle } from '@/components/ConfigSections';
import { t } from '@/i18n';

type Skill = SkillsView['skills'][number];

/** One skill: what it is for, where it comes from, who uses it, and the one click that puts it in or out of this project. */
function SkillCard({ project, s }: { project: string; s: Skill }) {
  const use = useSkillUse(project);
  const action = useAction(s);
  return (
    <Card id={s.name} className={s.applicable ? undefined : 'border-dashed'}>
      <CardContent className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-semibold">{s.name}</span>
          {s.layers.map(l => <Badge key={l} tone={layerTone(l)}>{layerLabel(l)}</Badge>)}
          <span className="text-xs text-muted-foreground">{s.source}</span>
        </div>
        <p className="line-clamp-3 text-sm text-muted-foreground" title={s.description}>{s.description}</p>
        {!s.applicable && <div className="flex items-start gap-1.5 rounded-md bg-muted px-2 py-1 text-xs"><Ban className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /><span>{s.inapplicable}</span></div>}
        <div className="flex flex-wrap items-center gap-1.5">
          {s.engines.map(x => <Badge key={x} tone="primary">{x}</Badge>)}
          {s.tags.map(x => <Badge key={x} tone="outline">{x}</Badge>)}
          {s.included && <Badge tone="success">{t('included by the project')}</Badge>}
          {s.excluded && <Badge tone="warning">{t('left out by the project')}</Badge>}
        </div>
        <div className="font-mono text-xs text-muted-foreground" title={s.dir}>{s.dir} · {s.files} {t('files')}</div>
        {s.usedBy.orders.length > 0 && <div className="flex flex-wrap items-center gap-2 text-xs"><span className="text-muted-foreground">{t('used by')}:</span>{s.usedBy.orders.map(o => <TagLink key={o} project={project} tag={o} />)}</div>}
        {s.usedBy.workers.length > 0 && <div className="flex flex-wrap items-center gap-1.5 text-xs"><span className="text-muted-foreground">{t('Workers')}:</span>{s.usedBy.workers.map(w => <Badge key={w} tone="neutral">{w}</Badge>)}</div>}
        {action && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant={action === 'use' ? 'default' : 'outline'} disabled={use.isPending} onClick={() => use.mutate({ name: s.name, use: action === 'use' })}>
              {action === 'use' ? t('Use in this project') : t('Do not use in this project')}
            </Button>
            {use.isError && <span className="text-xs text-destructive">{errorText(use.error)}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Column({ project, title, hint, skills, empty }: { project: string; title: string; hint: string; skills: Skill[]; empty: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 flex flex-wrap items-baseline gap-2"><h3 className="text-sm font-semibold">{title}</h3><span className="text-xs tabular-nums text-muted-foreground">{skills.length}</span></div>
      <p className="mb-2.5 text-xs text-muted-foreground">{hint}</p>
      {skills.length === 0 ? <Empty>{empty}</Empty> : <div className="grid gap-3">{skills.map(s => <SkillCard key={s.name} project={project} s={s} />)}</div>}
    </div>
  );
}

/** The registry of skills as this project sees it: the ones it can use, the ones of the machine it does not use here (with the reason), and its own. */
export function SkillsPage() {
  const project = useProjectId();
  const [editing, editButton] = useEditToggle();
  const q = useSkills(project);
  const [filter, setFilter] = useState('');
  const columns = useMemo(() => skillColumns((q.data?.skills ?? []).filter(s => skillMatches(s, filter))), [q.data, filter]);
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <div className="grid gap-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-40" /><Skeleton className="h-40" /></div>;
  const d = q.data;
  const kinds = Object.entries(d.byKind);
  return (
    <div>
      <PageHeader title={<><Puzzle className="size-5" />{t('Skills')}</>} count={d.skills.length} actions={editButton}>
        {t('One registry for every worker: core skills always, project skills by kind, order skills by tag. Only the skills this project can use are put into a worktree.')}
      </PageHeader>
      {editing && <ConfigPanel project={project}>{view => <SkillSettings key={configKey(view, ['skills'])} project={project} values={view.values} />}</ConfigPanel>}

      {d.problems.length > 0 && (
        <div className="mb-6 grid gap-1 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
          {d.problems.map((p, i) => <div key={i} className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />{p}</div>)}
        </div>
      )}

      <Section title={<><FolderOpen className="size-4" />{t('Sources')}</>} count={d.sources.length}>
        {d.sources.length === 0 ? <Empty>{t('No skill source is configured (the skills key of the workers file or skills.yaml).')}</Empty> : (
          <Card className="divide-y">
            {d.sources.map(s => (
              <div key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                <span className="w-32 font-medium">{s.id}</span>
                <Badge tone={s.scope === 'project' ? 'primary' : 'outline'}>{s.scope === 'project' ? t('this project') : t('this machine')}</Badge>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={s.dir}>{s.dir}</span>
                {s.exists ? <Badge tone="outline">{t('{n} skill(s)', { n: s.count })}</Badge> : <Badge tone="danger">{t('the folder does not exist')}</Badge>}
                {s.tags.map(x => <Badge key={x} tone="neutral">{x}</Badge>)}
                {s.problem && <span className="text-xs text-destructive">{s.problem}</span>}
              </div>
            ))}
          </Card>
        )}
      </Section>

      <Section title={t('Project layer')}>
        <Card>
          <CardContent className="grid gap-2 text-sm">
            <div className="flex flex-wrap items-center gap-1.5"><span className="w-32 text-muted-foreground">{t('Engine')}</span>{d.engine ? <Badge tone="primary">{d.engine}</Badge> : <span className="text-xs text-muted-foreground">{t('not set: no skill is left out by its engine (skills.engine in the project file)')}</span>}</div>
            <div className="flex flex-wrap items-center gap-1.5"><span className="w-32 text-muted-foreground">{t('always (project)')}</span>{d.always.length ? d.always.map(n => <Badge key={n} tone="primary">{n}</Badge>) : <span className="text-xs text-muted-foreground">–</span>}</div>
            {kinds.map(([kind, names]) => (
              <div key={kind} className="flex flex-wrap items-center gap-1.5"><span className="w-32 text-muted-foreground">{t('kind {kind}', { kind })}</span>{names.map(n => <Badge key={n} tone="neutral">{n}</Badge>)}</div>
            ))}
            {d.include.length > 0 && <div className="flex flex-wrap items-center gap-1.5"><span className="w-32 text-muted-foreground">{t('used here')}</span>{d.include.map(n => <Badge key={n} tone="success">{n}</Badge>)}</div>}
            {d.exclude.length > 0 && <div className="flex flex-wrap items-center gap-1.5"><span className="w-32 text-muted-foreground">{t('left out here')}</span>{d.exclude.map(n => <Badge key={n} tone="warning">{n}</Badge>)}</div>}
          </CardContent>
        </Card>
      </Section>

      <Section title={t('Registry')} count={d.skills.length} actions={<Input className="h-7 w-48 text-xs" placeholder={t('Filter')} value={filter} onChange={e => setFilter(e.target.value)} />}>
        <div className="grid gap-6 lg:grid-cols-3">
          <Column project={project} title={t('Available in this project')} hint={t('Skills of this machine that this project’s engine and rules let through.')} skills={columns.available} empty={t('No skill matches.')} />
          <Column project={project} title={t('Global, not used here')} hint={t('Skills of this machine this project does not use, each with the reason. One click puts it in.')} skills={columns.unused} empty={t('Every global skill is available here.')} />
          <Column project={project} title={t('The project’s own')} hint={t('Skills from the project’s own folders (skills.sources in the project file). They are always used.')} skills={columns.own} empty={t('The project has no skills of its own.')} />
        </div>
      </Section>

      {d.mounts.length > 0 && (
        <Section title={t('Where each worker finds them')} count={d.mounts.length}>
          <Card className="divide-y">
            {d.mounts.map(m => (
              <div key={m.worker} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
                <span className="w-40 font-medium">{m.worker}</span>
                <span className="w-28 text-xs text-muted-foreground">{m.engine}</span>
                <span className="font-mono text-xs">{m.mounts.length ? m.mounts.join(', ') : <span className="text-muted-foreground">{t('no folder: the prompt lists the skills instead')}</span>}</span>
              </div>
            ))}
          </Card>
        </Section>
      )}
    </div>
  );
}
