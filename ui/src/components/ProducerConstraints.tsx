import type { ProducerFacts } from '@api';
import { Card } from '@/components/ui/card';
import { Section } from '@/components/common';
import { dateTime } from '@/lib/format';
import { t } from '@/i18n';

type Snapshot = NonNullable<ProducerFacts['snapshot']>;
type Analysis = NonNullable<Snapshot['analysis']>;
export function candidateTitle(c: Analysis['constraint']['candidates'][number]) {
  const subject = c.id.slice(c.id.indexOf(':') + 1);
  switch (c.type) {
    case 'role': return c.title;
    case 'queue': return t('{subject} queue is limiting flow', { subject: t(subject) });
    case 'cause': return t('{subject} failures limit throughput', { subject: t(subject) });
    case 'monitoring': return t('Monitored builds hold the {subject} cap', { subject });
    case 'acceptor': return t('{subject} deliveries wait for the acceptor', { subject });
    case 'yield': return t('{subject} first-pass yield is low', { subject });
  }
}
function riskTitle(r: Analysis['risks'][number]) {
  const subject = decodeURIComponent(r.id.slice(r.id.indexOf(':') + 1));
  if (r.type === 'loop') return t('{worker} repeats failed work', { worker: subject });
  if (r.type === 'aging') return t('{order} is older than its kind p85', { order: subject });
  if (r.type === 'budget') {
    const [measure, order] = subject.split(':');
    return order ? t('{budget} budget exceeded by {order}', { budget: t(measure), order }) : t('{budget} budget exceeded', { budget: t(measure) });
  }
  return r.title;
}
function Evidence({ snapshot, ids }: { snapshot: Snapshot; ids: string[] }) {
  return <details className="mt-2 text-xs"><summary className="cursor-pointer text-muted-foreground">{t('Evidence ({count})', { count: ids.length })}</summary><ul className="mt-2 space-y-1 break-all">{ids.map(id => {
    const f = snapshot.facts.find(f => f.id === id);
    return <li key={id}><code>{id}</code>: {f ? `${f.value ?? t('unknown')} ${t(f.unit)}` : t('unavailable')}</li>;
  })}</ul></details>;
}
export function ProducerConstraints({ snapshot }: { snapshot: Snapshot | null }) {
  const analysis = snapshot?.analysis;
  return <Section title={t('Constraint now')}><Card className="p-4 text-sm">
    {!analysis || !snapshot ? <p className="text-muted-foreground">{t('Constraint analysis will appear after the next fact snapshot.')}</p> : <>
      <p className="font-semibold">{analysis.constraint.type === 'none' ? t('no clear constraint') : candidateTitle(analysis.constraint.candidates[0])}</p>
      {analysis.constraint.type === 'none' && <ul className="mt-2 space-y-1 text-muted-foreground">{analysis.constraint.candidates.map(c => <li key={c.id}>{t('Candidate: {title} ({value}; threshold {threshold})', { title: candidateTitle(c), value: c.value.toFixed(3), threshold: c.threshold })}</li>)}</ul>}
      <Evidence snapshot={snapshot} ids={analysis.constraint.factIds} />
      <details className="mt-2"><summary className="cursor-pointer text-xs text-muted-foreground">{t('Standard responses')}</summary><dl className="mt-2 space-y-1">{Object.entries(analysis.constraint.responses).map(([name, text]) => <div key={name}><dt className="inline font-medium capitalize">{t(name)}: </dt><dd className="inline">{t(text)}</dd></div>)}</dl></details>
      <div className="mt-4 border-t border-border pt-3"><h3 className="font-semibold">{t('Risk register ({count})', { count: analysis.risks.length })}</h3>
        {analysis.risks.length ? <ul className="mt-2 divide-y divide-border">{analysis.risks.map(r => <li key={r.id} className="py-2"><div className="flex flex-wrap justify-between gap-x-3"><span>{riskTitle(r)}</span><span className="text-xs text-muted-foreground">{t(r.type)} · {t('count {count}', { count: r.count })}</span></div><p className="mt-1 text-xs text-muted-foreground">{t('First seen {first} · Last seen {last}', { first: dateTime(r.firstSeen), last: dateTime(r.lastSeen) })}</p><Evidence snapshot={snapshot} ids={r.factIds} /></li>)}</ul> : <p className="mt-2 text-muted-foreground">{t('No current risks.')}</p>}
      </div>
    </>}
  </Card></Section>;
}
