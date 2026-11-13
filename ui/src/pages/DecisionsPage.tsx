import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Plus, Scale, Search } from 'lucide-react';
import type { DecisionEntry } from '@api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/misc';
import { Empty, EmptyState, ErrorBox, PageHeader, TagLink } from '@/components/common';
import { SourceBadge } from '@/components/OrderExtras';
import { buildDecisionRequest, searchDecisions, type DecisionForm } from '@/lib/decisions';
import { errorText, useAddDecision, useDecisions, useProjectId } from '@/lib/queries';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';

const EMPTY: DecisionForm = { text: '', mode: 'quote', source: '', id: '', date: '' };

function AddDecision({ project, next, open, onOpenChange, initialText = '' }: { project: string; next: string; open: boolean; onOpenChange: (o: boolean) => void; initialText?: string }) {
  const add = useAddDecision(project);
  const [f, setF] = useState<DecisionForm>({ ...EMPTY, text: initialText });
  const [more, setMore] = useState(false);
  const built = buildDecisionRequest(f);
  const set = <K extends keyof DecisionForm>(k: K, v: DecisionForm[K]) => setF(x => ({ ...x, [k]: v }));
  const close = (o: boolean) => { if (!o) { setF(EMPTY); add.reset(); } onOpenChange(o); };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="w-[min(94vw,38rem)]">
        <DialogTitle>{t('New decision')}</DialogTitle>
        <DialogDescription>{t('A decision stands on the user’s own words, or is a default that was not overruled. Without a source it is not recorded.')}</DialogDescription>
        <div className="grid gap-1.5">
          <Label>{t('The decision')}</Label>
          <Textarea autoFocus value={f.text} onChange={e => set('text', e.target.value)} className="min-h-20" placeholder={t('What was decided, in a sentence or two')} />
        </div>
        <div className="grid gap-1.5">
          <Label>{t('Source')}</Label>
          <div className="flex flex-wrap gap-2">
            {(['quote', 'default'] as const).map(m => (
              <button key={m} type="button" onClick={() => set('mode', m)} className={cn('rounded-md border px-2.5 py-1 text-sm', f.mode === m ? 'border-primary bg-primary/8 font-medium' : 'text-muted-foreground hover:bg-accent')}>
                {m === 'quote' ? t('The user’s words') : t('Default, not overruled')}
              </button>
            ))}
          </div>
          {f.mode === 'quote'
            ? <Textarea value={f.source} onChange={e => set('source', e.target.value)} className="min-h-16" placeholder={t('Paste what the user said (required)')} aria-invalid={!f.source.trim()} />
            : <p className="text-xs text-muted-foreground">{t('No quote: the decision is recorded as a default the user has not overruled.')}</p>}
        </div>
        <div>
          <button type="button" className="text-xs text-primary hover:underline" onClick={() => setMore(m => !m)}>{more ? t('Fewer fields') : t('Id and date')}</button>
          {more && (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <div className="grid gap-1"><Label>{t('Id')}</Label><Input value={f.id} onChange={e => set('id', e.target.value)} placeholder={next} className="font-mono" /><span className="text-[11px] text-muted-foreground">{t('Left empty it is {id}. An id in a reserved range is refused.', { id: next })}</span></div>
              <div className="grid gap-1"><Label>{t('Date')}</Label><Input value={f.date} onChange={e => set('date', e.target.value)} placeholder="YYYY-MM-DD" className="tabular-nums" /></div>
            </div>
          )}
        </div>
        {add.isError && <ErrorBox error={errorText(add.error)} />}
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>{t('Back')}</Button>
          <Button disabled={!built.ok || add.isPending} onClick={() => built.ok && add.mutate(built.body, { onSuccess: () => close(false) })}>
            {add.isPending ? t('Working…') : t('Record the decision')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The project's decision ledger: searchable, newest first. */
export function DecisionsPage() {
  const project = useProjectId();
  const q = useDecisions(project);
  const [initialParams] = useSearchParams();
  const [query, setQuery] = useState(initialParams.get('query') ?? '');
  const [kind, setKind] = useState<DecisionEntry['sourceKind'] | ''>('');
  const [topic, setTopic] = useState('');
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(params.get('new') === '1');
  const draft = params.get('text') ?? '';
  const shown = useMemo(() => searchDecisions(q.data?.items ?? [], query, kind, topic), [q.data, query, kind, topic]);

  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <div className="grid gap-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></div>;
  const d = q.data;
  return (
    <div>
      <PageHeader title={t('Decision ledger')} count={d.items.length} actions={<Button onClick={() => setAdding(true)}><Plus />{t('New decision')}</Button>}>
        {t('Next id: {id}', { id: d.next })}
        {d.reviewerRange && <> · {t('reviewer’s numbers {a}–{b}', { a: d.reviewerRange[0], b: d.reviewerRange[1] })}</>}
      </PageHeader>
      {d.reserved.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {t('Reserved on open orders')}: {d.reserved.map(r => <Badge key={r.tag} tone="outline"><TagLink project={project} tag={r.tag} className="text-[11px]" /> {r.range[0]}–{r.range[1]}</Badge>)}
        </div>
      )}
      {d.duplicates.length > 0 && (
        <details className="mb-3 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
          <summary className="cursor-pointer">{t('{n} number(s) appear in more than one place; the later one is shown.', { n: d.duplicates.length })}</summary>
          <ul className="mt-1.5 grid gap-0.5 text-xs">{d.duplicates.map(x => <li key={x.id}><span className="font-mono font-semibold">{x.id}</span>: {x.topics.map(y => y || '–').join(' · ')}</li>)}</ul>
        </details>
      )}
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-sm"><Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" /><Input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('Search id, text or source')} className="pl-8" /></div>
        {d.topics.length > 1 && (
          <Select value={topic} onChange={e => setTopic(e.target.value)} className="w-64" aria-label={t('Section')}>
            <option value="">{t('Every section ({n})', { n: d.topics.length })}</option>
            {d.topics.map(x => <option key={x} value={x}>{x}</option>)}
          </Select>
        )}
        <Select value={kind} onChange={e => setKind(e.target.value as typeof kind)} className="w-44">
          <option value="">{t('Any source')}</option><option value="quote">{t('The user’s words')}</option><option value="default">{t('Default, not overruled')}</option><option value="imported">{t('imported')}</option>
        </Select>
      </div>
      {shown.length === 0 ? (d.items.length === 0 ? <EmptyState icon={<Scale />} title={t('The ledger is empty.')}>{t('Decisions you record here are cited by orders and reviews.')}</EmptyState> : <Empty>{t('No decision matches.')}</Empty>) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="px-4 py-1.5 font-medium">{t('Id')}</th><th className="px-2 py-1.5 font-medium">{t('Date')}</th><th className="px-2 py-1.5 font-medium">{t('The decision')}</th><th className="px-4 py-1.5 font-medium">{t('Source')}</th></tr></thead>
            <tbody className="divide-y">
              {shown.map(x => (
                <tr key={x.id} className="align-top hover:bg-accent/40">
                  <td className="px-4 py-2 font-mono text-[13px] font-semibold whitespace-nowrap">{x.displayId ?? x.id}</td>
                  <td className="px-2 py-2 whitespace-nowrap text-muted-foreground tabular-nums">{x.date}</td>
                  <td className="px-2 py-2 whitespace-pre-wrap">{x.text}{x.topic && <div className="mt-0.5 text-[11px] text-muted-foreground">{x.topic}</div>}</td>
                  <td className="max-w-80 px-4 py-2 text-xs text-muted-foreground"><div className="mb-0.5"><SourceBadge d={x} /></div>{x.sourceKind === 'default' ? t('Default, not overruled') : <span className="italic">“{x.source}”</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <AddDecision project={project} next={d.next} open={adding} initialText={draft} onOpenChange={o => { setAdding(o); if (!o && params.has('new')) setParams({}, { replace: true }); }} />
    </div>
  );
}
