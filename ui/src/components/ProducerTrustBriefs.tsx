import { Link } from 'react-router';
import type { ProducerInsights } from '@api';
import { Card } from './ui/card';
import { Section, TagLink } from './common';
import { t } from '@/i18n';
import { dateTime } from '@/lib/format';

export function ProducerTrust({ trust, project }: { trust: ProducerInsights['trust']; project: string }) {
  return <Section title={t('Rule agreement')}><div className="grid gap-3">{!trust.length && <Card className="p-4 text-sm text-muted-foreground">{t('No rules configured.')}</Card>}{trust.map(rule => <Card className="p-4" key={rule.ruleId}>
    <div className="flex flex-wrap justify-between gap-2 text-sm"><strong>{rule.ruleId} · {rule.mode}</strong><span>{rule.rate === null ? '—' : `${Math.round(rule.rate * 100)}%`}{!rule.enough && ` · ${t('not enough cases')}`} · {rule.decided} {t('decided cases')}</span></div>
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">{Object.entries(rule.counts).map(([outcome, count]) => <span key={outcome}>{t(`agreement.${outcome}`)}: {count}</span>)}</div>
    {rule.suggestion && <div className="mt-3 rounded border border-primary/30 p-3 text-sm"><p>{t('{direction} rule {rule} from {from} to {to}', { direction: t(rule.suggestion.direction), rule: rule.ruleId, from: rule.suggestion.from, to: rule.suggestion.to })}</p><pre className="mt-2 overflow-x-auto text-xs">{rule.suggestion.yaml}</pre><p className="mt-1 text-xs text-muted-foreground">{t('Edit the project YAML to apply this suggestion.')}</p></div>}
    {!!rule.disagreements.length && <details className="mt-3 text-xs"><summary className="cursor-pointer">{t('Last disagreements')}</summary><ul className="mt-2 grid gap-2">{rule.disagreements.map(row => <li key={row.actionId}>{row.order && <TagLink project={project} tag={row.order} />} <Link className="text-primary hover:underline" to={`/p/${encodeURIComponent(project)}/producer#${encodeURIComponent(row.caseId)}`}>{row.caseId}</Link> · {t(`agreement.${row.outcome}`)}{row.humanAction && ` · ${row.humanAction}`} · {dateTime(row.decidedAt ?? row.at)}</li>)}</ul></details>}
  </Card>)}</div></Section>;
}

export function ProducerBriefHistory({ briefs }: { briefs: ProducerInsights['briefs'] }) {
  return <Section title={t('Brief history')}><div className="grid gap-3">{!briefs.length && <Card className="p-4 text-sm text-muted-foreground">{t('Scheduled briefs will appear here when configured.')}</Card>}{briefs.map(brief => <Card className="p-4" key={brief.id}>
    <div className="mb-3 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><time dateTime={brief.at}>{dateTime(brief.at)}</time><span>{brief.language}</span></div>
    <p className="whitespace-pre-wrap text-sm">{brief.text}</p>
    {brief.hook && <p className="mt-2 text-xs text-muted-foreground">{t('Notification')}: {t(brief.hook.status)}{brief.hook.error ? ` · ${brief.hook.error}` : ''}</p>}
    <details className="mt-3 text-xs"><summary className="cursor-pointer">{t('Brief evidence')}</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap">{JSON.stringify({ since: brief.since, at: brief.at, snapshotAt: brief.snapshot?.at, direction: brief.direction, facts: brief.facts, rewriteError: brief.rewriteError }, null, 2)}</pre></details>
  </Card>)}</div></Section>;
}
