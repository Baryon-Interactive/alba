import { useMemo, useState } from 'react';
import { BookOpen, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Checkbox, Skeleton } from '@/components/ui/misc';
import { Input } from '@/components/ui/input';
import { Empty, EmptyState, ErrorBox, PageHeader, TagLink } from '@/components/common';
import { filterLessons, tagCounts } from '@/lib/lessons';
import { useLessons, useProjectId } from '@/lib/queries';
import { ConfigPanel, JsonSettings, configKey, useEditToggle } from '@/components/ConfigSections';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';

/** The lesson library, browsed by tag. A lesson that applies to the project and shares a tag with an order (or with its kind) goes into that order's prompt. */
export function LessonsPage() {
  const project = useProjectId();
  const [editing, editButton] = useEditToggle();
  const q = useLessons(project);
  const [tags, setTags] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [mine, setMine] = useState(true);
  const all = q.data?.items ?? [];
  const here = useMemo(() => all.filter(l => l.appliesToProject), [all]);
  const counts = useMemo(() => tagCounts(mine ? here : all), [all, here, mine]);
  const shown = useMemo(() => filterLessons(all, tags, query, mine), [all, tags, query, mine]);

  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <div className="grid gap-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-48" /></div>;
  return (
    <div>
      <PageHeader title={t('Lessons')} count={shown.length} actions={editButton}>{t('Rules the studio learned. An order gets the lessons that apply to this project and share a tag with it or with its kind in its prompt.')}</PageHeader>
      {editing && <ConfigPanel project={project}>{view => <JsonSettings key={configKey(view, ['lessons', 'kind_tags'])} project={project} view={view} path={['lessons', 'kind_tags']} title={t('Tags by kind')} description={t('The lesson tags an order of each kind gets on top of its own tags, for example { "art": ["art", "image"] }.')} />}</ConfigPanel>}
      {all.length === 0 ? <EmptyState icon={<BookOpen />} title={t('No lessons yet')}>{t('The project has no lesson library (set one in the project file).')}</EmptyState> : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={mine} onCheckedChange={v => setMine(v === true)} />{t('Only lessons that apply to this project')}</label>
            <span className="text-xs text-muted-foreground">{t('{n} of {total} apply here', { n: here.length, total: all.length })}</span>
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            {counts.map(c => {
              const on = tags.includes(c.tag);
              return (
                <button key={c.tag} onClick={() => setTags(x => (on ? x.filter(y => y !== c.tag) : [...x, c.tag]))} className={cn('rounded-full border px-2.5 py-0.5 text-xs transition-colors', on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent')} aria-pressed={on}>
                  {c.tag} <span className={cn('tabular-nums', on ? 'opacity-80' : 'text-muted-foreground')}>{c.count}</span>
                </button>
              );
            })}
            {tags.length > 0 && <button className="text-xs text-primary hover:underline" onClick={() => setTags([])}>{t('Clear')}</button>}
          </div>
          <div className="relative mb-3 max-w-sm"><Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" /><Input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('Search id, title or rule')} className="pl-8" /></div>
          {shown.length === 0 ? <Empty>{t('No lesson matches.')}</Empty> : (
            <div className="grid gap-3">
              {shown.map(l => (
                <Card key={l.id} className={cn('p-4', !l.appliesToProject && 'border-dashed opacity-80')}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[13px] font-semibold">{l.id}</span><span className="font-medium">{l.title}</span>
                    {l.level && <Badge tone="neutral">{l.level}</Badge>}
                    {!l.appliesToProject && <Badge tone="warning">{t('other projects')}</Badge>}
                    {l.tags.map(x => <button key={x} onClick={() => setTags(y => (y.includes(x) ? y : [...y, x]))}><Badge tone="outline" className="hover:bg-accent">{x}</Badge></button>)}
                  </div>
                  <p className="mt-1.5 text-sm whitespace-pre-wrap">{l.rule}</p>
                  {l.why && <p className="mt-1 text-sm whitespace-pre-wrap text-muted-foreground"><span className="font-medium">{t('Why')}: </span>{l.why}</p>}
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="font-mono">{l.file}</span>
                    {l.projects && l.projects.length > 0 && <span>{t('Projects')}: {l.projects.join(', ')}</span>}
                    {l.orders.length > 0 && <span className="flex flex-wrap items-center gap-1.5">{t('In the prompt of')}: {l.orders.map(o => <TagLink key={o} project={project} tag={o} className="text-xs" />)}</span>}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
