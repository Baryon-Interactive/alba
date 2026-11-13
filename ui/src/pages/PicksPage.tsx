import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { AlertTriangle, Check, Images, Scale } from 'lucide-react';
import type { PickSet } from '@api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/misc';
import { PickLightbox } from '@/components/library/PickLightbox';
import { Empty, ErrorBox, PageHeader, Section, TagLink } from '@/components/common';
import { fileUrl } from '@/lib/api';
import { choiceText, pickGroups, toggleChoice } from '@/lib/library';
import { ago, dateTime } from '@/lib/format';
import { errorText, useChoosePick, usePicks, useProjectId } from '@/lib/queries';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';

/** One pick set: its question, its options with their pictures, the note and the confirmation. A chosen set offers the decision text to record. */
function SetCard({ project, set }: { project: string; set: PickSet }) {
  const choose = useChoosePick(project);
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string[]>(set.choice?.choice ?? []);
  const [note, setNote] = useState(set.choice?.note ?? '');
  const [open, setOpen] = useState<number | null>(null);
  const decided = set.state === 'decided';
  const tag = set.waitingOrder ?? set.order;
  const startOf = (key: string, n = 0) => {
    let i = 0;
    for (const o of set.options) { if (o.key === key) return i + n; i += o.images.length; }
    return 0;
  };
  const confirm = () => choose.mutate({ id: set.id, choice: selected, note: note.trim() || undefined, fingerprint: set.fingerprint }, { onSuccess: () => setOpen(null) });
  const changed = selected.join('\u0000') !== (set.choice?.choice ?? []).join('\u0000') || note.trim() !== (set.choice?.note ?? '').trim();

  return (
    <Card className="scroll-mt-4 p-4" id={set.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px] font-semibold">{set.id}</span>
        <span className="font-medium">{set.title}</span>
        <Badge tone={set.state === 'pending' ? 'warning' : set.state === 'chosen' ? 'primary' : 'success'}>{set.state === 'pending' ? t('waiting for a choice') : set.state === 'chosen' ? t('chosen, no decision yet') : t('decided')}</Badge>
        {set.multi && <Badge tone="outline">{t('several may be chosen')}</Badge>}
        {set.source === 'report' && <Badge tone="outline">{t('from a report')}</Badge>}
        {set.order && <TagLink project={project} tag={set.order} className="text-xs" />}
        {set.decision && <span className="ml-auto font-mono text-xs text-muted-foreground">{set.decision}</span>}
      </div>
      <blockquote className="mt-2 rounded-md border-l-[3px] border-primary bg-primary/6 px-3 py-2 text-[14px] whitespace-pre-wrap">{set.question}</blockquote>

      {set.staleChoice && (
        <p className="mt-2 flex items-start gap-1.5 rounded-md border border-warning/50 bg-warning/10 px-2.5 py-1.5 text-xs">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {t('The file of this set changed after it was chosen ({text}, {when}); that choice does not count. Choose again.', { text: choiceText(set, set.staleChoice.choice), when: ago(set.staleChoice.at) })}
        </p>
      )}
      {set.problems.length > 0 && (
        <details className="mt-2 rounded-md border border-warning/40 bg-warning/8 px-2.5 py-1.5 text-xs">
          <summary className="cursor-pointer">{t('{n} thing(s) wrong in the file', { n: set.problems.length })}</summary>
          <ul className="mt-1 grid gap-0.5">{set.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </details>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {set.options.map(o => {
          const on = selected.includes(o.key);
          const shown = o.images.filter(i => i.exists);
          return (
            <div key={o.key} className={cn('overflow-hidden rounded-lg border bg-card transition-colors', on && 'border-primary ring-2 ring-primary/40', decided && 'opacity-90')}>
              {shown.length > 0 ? (
                <div className="grid aspect-[4/3] grid-cols-2 grid-rows-2 gap-0.5 bg-muted">
                  {shown.slice(0, 4).map((img, i) => (
                    <button key={img.path} type="button" onClick={() => setOpen(startOf(o.key, o.images.indexOf(img)))} className={cn('relative block min-h-0 overflow-hidden bg-black/5', shown.length === 1 && 'col-span-2 row-span-2', shown.length === 2 && 'row-span-2', shown.length === 3 && i === 0 && 'row-span-2')} title={t('Look at it large')}>
                      <img src={fileUrl(project, img.path, tag)} alt={`${o.key}: ${o.label}`} loading="lazy" className="absolute inset-0 size-full object-cover" />
                      {i === 3 && shown.length > 4 && <span className="absolute inset-0 grid place-items-center bg-black/50 text-sm font-medium text-white">+{shown.length - 3}</span>}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="grid aspect-[4/3] place-items-center bg-muted text-xs text-muted-foreground">{o.images.length ? t('the pictures are missing') : t('no picture')}</div>
              )}
              <button type="button" disabled={decided} onClick={() => setSelected(s => toggleChoice(s, o.key, set.multi))} className="flex w-full items-start gap-2 px-3 py-2 text-left disabled:cursor-default" aria-pressed={on}>
                <span className={cn('mt-0.5 grid size-4 shrink-0 place-items-center border text-primary-foreground', set.multi ? 'rounded' : 'rounded-full', on ? 'border-primary bg-primary' : 'border-input')}>{on && <Check className="size-3" />}</span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium"><span className="mr-1.5 font-mono text-xs text-muted-foreground">{o.key}</span>{o.label}</span>
                  {o.note && <span className="block text-xs text-muted-foreground">{o.note}</span>}
                  {o.images.length > shown.length && shown.length > 0 && <span className="block text-[11px] text-warning">{t('{n} picture(s) missing', { n: o.images.length - shown.length })}</span>}
                </span>
              </button>
            </div>
          );
        })}
      </div>

      {!decided && (
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
          <Textarea value={note} onChange={e => setNote(e.target.value)} placeholder={t('A note with the choice (optional)')} className="min-h-12" />
          <div className="grid gap-1 justify-items-end">
            <span className="text-xs text-muted-foreground">{selected.length ? t('Chosen: {text}', { text: choiceText(set, selected) }) : t('Nothing selected yet')}</span>
            <div className="flex items-center gap-2">
              {set.options.some(o => o.images.some(i => i.exists)) && <Button size="sm" variant="outline" onClick={() => setOpen(0)}><Images />{t('Look at them large')}</Button>}
              <Button size="sm" disabled={!selected.length || choose.isPending || (set.state === 'chosen' && !changed)} onClick={confirm}>{choose.isPending ? t('Working…') : set.state === 'chosen' ? t('Change the choice') : t('Confirm choice')}</Button>
            </div>
          </div>
        </div>
      )}
      {choose.isError && <div className="mt-2"><ErrorBox error={errorText(choose.error)} /></div>}

      {set.choice && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2 text-xs text-muted-foreground">
          <span>{t('Chosen {when} by {who}', { when: ago(set.choice.at), who: set.choice.who ?? set.choice.by })}{set.choice.source === 'external' ? ` · ${t('from the studio’s record')}` : ''}</span>
          <span title={dateTime(set.choice.at)}>{choiceText(set, set.choice.choice)}</span>
          {set.choice.note && <span className="italic">“{set.choice.note}”</span>}
          {set.state === 'chosen' && set.decisionDraft && (
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => navigate(`/p/${encodeURIComponent(project)}/decisions?new=1&text=${encodeURIComponent(set.decisionDraft!)}`)}><Scale />{t('Record the decision')}</Button>
          )}
        </div>
      )}

      <PickLightbox
        project={project} set={set} start={open} selected={selected} note={note}
        onToggle={key => setSelected(s => toggleChoice(s, key, set.multi))} onNote={setNote} onConfirm={confirm} confirming={choose.isPending} onClose={() => setOpen(null)}
      />
    </Card>
  );
}

/** The project-level pick sets: questions with pictures to choose from, grouped by what is left to do. */
export function PicksPage() {
  const project = useProjectId();
  const q = usePicks(project);
  const { hash } = useLocation();
  const loaded = !!q.data;
  useEffect(() => { if (loaded && hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: 'start' }); }, [loaded, hash]);
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <div className="grid gap-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></div>;
  const d = q.data;
  const g = pickGroups(d.sets);
  return (
    <div>
      <PageHeader title={<><Images className="size-5" />{t('Picks')}</>} count={d.sets.length}>
        {t('{p} waiting, {c} chosen without a decision, {d} decided', { p: d.counts.pending, c: d.counts.chosen, d: d.counts.decided })}
      </PageHeader>
      {!d.enabled && <Empty>{t('This project has no pick sets. Add "picks: dir" to the project file, or let a worker ask a question with "scope": "project".')}</Empty>}
      {d.unreadable.length > 0 && (
        <details className="mb-4 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
          <summary className="cursor-pointer">{t('{n} file(s) could not be read as a pick set', { n: d.unreadable.length })}</summary>
          <ul className="mt-1.5 grid gap-0.5 text-xs">{d.unreadable.map(u => <li key={u.file}><span className="font-mono">{u.file}</span>: {u.reason}</li>)}</ul>
        </details>
      )}
      {d.recordProblems.length > 0 && (
        <details className="mb-4 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
          <summary className="cursor-pointer">{t('{n} line(s) of a records file could not be read', { n: d.recordProblems.length })}</summary>
          <ul className="mt-1.5 grid gap-0.5 text-xs">{d.recordProblems.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </details>
      )}
      {g.pending.length > 0 && <Section title={t('Waiting for a choice')} count={g.pending.length}><div className="grid gap-3">{g.pending.map(s => <SetCard key={s.id} project={project} set={s} />)}</div></Section>}
      {g.chosen.length > 0 && <Section title={t('Chosen, decision not recorded')} count={g.chosen.length}><div className="grid gap-3">{g.chosen.map(s => <SetCard key={s.id} project={project} set={s} />)}</div></Section>}
      {g.decided.length > 0 && (
        <Section title={t('Decided')} count={g.decided.length}>
          <details className="group">
            <summary className="mb-2 cursor-pointer text-xs text-primary hover:underline">{t('Show the decided sets')}</summary>
            <div className="grid gap-3">{g.decided.map(s => <SetCard key={s.id} project={project} set={s} />)}</div>
          </details>
        </Section>
      )}
      {d.enabled && d.sets.length === 0 && d.unreadable.length === 0 && <Empty>{t('No pick sets yet.')}</Empty>}
      <p className="text-xs text-muted-foreground">{t('A choice is kept in the state folder of this project; the project’s own files are not changed. A decision is recorded in the')} <Link className="text-primary hover:underline" to={`/p/${encodeURIComponent(project)}/decisions`}>{t('Decision ledger')}</Link>.</p>
    </div>
  );
}
