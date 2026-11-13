import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BookOpen, CircleDollarSign, HelpCircle, Scale } from 'lucide-react';
import type { DecisionEntry, Lesson, OrderDetail, Question } from '@api';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Section, UsageText } from '@/components/common';
import { OptionsPicker } from '@/components/OptionsPicker';
import { QuoteCard } from '@/components/QuoteCard';
import { api, fileUrl } from '@/lib/api';
import { keys } from '@/lib/keys';
import { ago, dateTime } from '@/lib/format';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';

/** A question with options that was asked on the order: answered ones show who chose what, open ones can be answered here. */
function QuestionBlock({ project, tag, q }: { project: string; tag: string; q: Question }) {
  const client = useQueryClient();
  const refresh = () => { for (const k of [keys.order(project, tag), keys.overview(project), keys.evidence(project, tag)]) void client.invalidateQueries({ queryKey: k }); };
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge tone={q.answered ? 'success' : 'primary'}>{q.answered ? t('answered') : t('waiting for your choice')}</Badge>
        <span title={dateTime(q.at)}>{t('asked {ago} by {by}', { ago: ago(q.at), by: q.askedBy })}</span>
      </div>
      <p className="mt-1.5 text-sm whitespace-pre-wrap">{q.text}</p>
      {q.answered ? (
        <div className="mt-2 grid gap-2">
          <div className="grid gap-2 sm:grid-cols-2">
            {q.options.map(o => {
              const chosen = q.answered!.choice.includes(o.key);
              return (
                <div key={o.key} className={cn('rounded-lg border p-2.5 text-sm', chosen ? 'border-success bg-success/8' : 'opacity-60')}>
                  <div className="font-medium">{o.key}. {o.label}{chosen && <Badge tone="success" className="ml-2">{t('chosen')}</Badge>}</div>
                  {o.note && <div className="text-xs text-muted-foreground">{o.note}</div>}
                  {o.images.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1.5">{o.images.map(p => <img key={p} src={fileUrl(project, p, tag)} alt="" loading="lazy" className="h-14 w-20 rounded border object-cover" />)}</div>}
                </div>
              );
            })}
          </div>
          <div className="text-xs text-muted-foreground">
            {t('chosen by {who} {ago}', { who: q.answered.who ?? q.answered.by, ago: ago(q.answered.at) })}{q.answered.who ? ` (${q.answered.by})` : ''}
            {q.answered.note ? ` · ${q.answered.note}` : ''}
          </div>
        </div>
      ) : (
        <OptionsPicker
          project={project} tag={tag} options={q.options} onDone={refresh}
          submit={async (choice, note) => { await api.answerQuestion(tag, q.id, { project, choice, note: note || undefined }); toast.success(t('Choice recorded')); }}
        />
      )}
    </Card>
  );
}

export function QuestionsSection({ project, d }: { project: string; d: OrderDetail }) {
  if (!d.questions?.length) return null;
  return (
    <Section title={<><HelpCircle className="size-4" />{t('Questions with options')}</>} count={d.questions.length}>
      <div className="grid gap-3">{d.questions.map(q => <QuestionBlock key={q.id} project={project} tag={d.order.tag} q={q} />)}</div>
    </Section>
  );
}

/** One decision of the ledger, with the words it stands on. */
export function DecisionRow({ d }: { d: DecisionEntry }) {
  return (
    <div className="grid gap-0.5 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-[13px] font-semibold">{d.displayId ?? d.id}</span><span className="text-xs text-muted-foreground">{d.date}</span><SourceBadge d={d} /></div>
      <div className="whitespace-pre-wrap">{d.text}</div>
      <div className="text-xs text-muted-foreground">{d.sourceKind === 'default' ? t('Default, not overruled') : <span className="italic">“{d.source}”</span>}</div>
    </div>
  );
}

export function SourceBadge({ d }: { d: Pick<DecisionEntry, 'sourceKind'> }) {
  return d.sourceKind === 'quote' ? <Badge tone="primary">{t('quote')}</Badge> : d.sourceKind === 'default' ? <Badge tone="warning">{t('default')}</Badge> : <Badge tone="outline">{t('imported')}</Badge>;
}

export function ReferencedDecisions({ d }: { d: OrderDetail }) {
  if (!d.referencedDecisions?.length) return null;
  return (
    <Section title={<><Scale className="size-4" />{t('Decisions it stands on')}</>} count={d.referencedDecisions.length}>
      <Card><CardContent className="divide-y">{d.referencedDecisions.map(x => <DecisionRow key={x.id} d={x} />)}</CardContent></Card>
    </Section>
  );
}

export function LessonLine({ l }: { l: Lesson }) {
  return (
    <div className="py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-[13px] font-semibold">{l.id}</span><span className="font-medium">{l.title}</span>{l.tags.map(x => <Badge key={x} tone="outline">{x}</Badge>)}</div>
      <p className="mt-0.5 text-muted-foreground">{l.rule}</p>
    </div>
  );
}

/** The lessons whose tags match the order: what `alba run` puts in its prompt. */
export function LessonsSection({ d }: { d: OrderDetail }) {
  const tags = d.order.tags ?? [];
  if (!d.lessons?.length && !tags.length) return null;
  return (
    <Section title={<><BookOpen className="size-4" />{t('Lessons in its prompt')}</>} count={d.lessons?.length ?? 0}>
      <Card>
        <CardContent>
          {tags.length > 0 && <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">{t('Order tags')}: {tags.map(x => <Badge key={x} tone="primary">{x}</Badge>)}</div>}
          {d.lessons?.length ? <div className="divide-y">{d.lessons.map(l => <LessonLine key={l.id} l={l} />)}</div> : <p className="py-1 text-sm text-muted-foreground">{t('No lesson matches these tags.')}</p>}
        </CardContent>
      </Card>
    </Section>
  );
}

/** Usage and cap () and the quotes for paid resources with their ledger, in one place. */
export function SpendSection({ project, d }: { project: string; d: OrderDetail }) {
  const spend = d.spend;
  const quotes = d.quotes ?? [];
  if (!spend && quotes.length === 0) return null;
  const credits = Object.entries(spend?.credits ?? {});
  return (
    <Section title={<><CircleDollarSign className="size-4" />{t('Spend')}</>} count={quotes.length || undefined}>
      <div className="grid gap-2">
        {spend && (
          <Card className="p-3.5 text-sm">
            <UsageText usage={spend} />
            {spend.cap_usd !== undefined && <div className={cn('mt-1 text-xs', spend.over_cap ? 'font-medium text-destructive' : 'text-muted-foreground')}>{t('cap ${cap}', { cap: spend.cap_usd })}{spend.over_cap ? ` · ${t('reached: no more runs are started')}` : ''}</div>}
            {spend.runs_unknown > 0 && <div className="mt-1 text-xs text-muted-foreground">{t('{n} runs without numbers in their logs', { n: spend.runs_unknown })}</div>}
            {credits.length > 0 && (
              <table className="mt-2 w-full text-xs tabular-nums">
                <thead><tr className="text-left text-muted-foreground"><th className="font-medium">{t('Unit')}</th><th className="text-right font-medium">{t('Approved')}</th><th className="text-right font-medium">{t('Spent')}</th><th className="text-right font-medium">{t('Waiting')}</th></tr></thead>
                <tbody>{credits.map(([unit, c]) => <tr key={unit}><td>{unit}</td><td className="text-right">{c.approved}</td><td className="text-right">{c.spent}</td><td className="text-right">{c.pending}</td></tr>)}</tbody>
              </table>
            )}
          </Card>
        )}
        {quotes.map(q => <QuoteCard key={q.id} project={project} quote={q} showOrder={false} />)}
      </div>
    </Section>
  );
}
