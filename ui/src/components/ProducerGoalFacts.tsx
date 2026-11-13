import { t } from '@/i18n';

type TargetFacts = { id: string; metric: string; min: number | null; max: number | null; last_value: number | null; unit: string; evidence: { ref: string }[] };
/** Library text is displayed as text, never interpreted as producer instructions. */
export function ProducerGoalFacts({ facts }: { facts: Record<string, unknown> }) {
  const target = facts.target as TargetFacts | undefined;
  const gap = facts.gap as { id: string; text: string } | undefined;
  const rules = facts.rules as { id: string; text: string }[] | undefined;
  const gaps = facts.gaps as { id: string; text: string }[] | undefined;
  const goals = facts.goals as { trigger: string; goal: string; target?: TargetFacts; gap?: { text: string } }[] | undefined;
  if (!target && !gap && !goals) return null;
  return <div className="mt-3 rounded-md border bg-muted/30 p-3 text-sm">
    {!!facts.milestone && <p className="mb-2 text-xs text-muted-foreground">{t('Milestone')}: {String(facts.milestone)}</p>}
    {target && <><strong className="font-mono text-xs">{target.id}</strong><p>{target.metric}</p><div className="mt-2 flex flex-wrap gap-x-6 gap-y-1"><span>{t('Range')}: {target.min ?? '−∞'} … {target.max ?? '∞'} {target.unit}</span><span>{t('Last value')}: <strong>{target.last_value ?? '—'} {target.unit}</strong></span></div><p className="mt-1 text-xs text-muted-foreground">{t('Evidence')}: {target.evidence?.map(e => e.ref).join(', ') || '—'}</p></>}
    {gap && <><strong className="font-mono text-xs">{gap.id}</strong><p>{gap.text}</p></>}
    {!!rules?.length && <div className="mt-3"><p className="text-xs font-semibold">{t('Related rules')}</p>{rules.map(r => <p key={r.id} className="mt-1 text-xs"><code>{r.id}</code> · {r.text}</p>)}</div>}
    {!!gaps?.length && <div className="mt-3"><p className="text-xs font-semibold">{t('Related gaps')}</p>{gaps.map(g => <p key={g.id} className="mt-1 text-xs"><code>{g.id}</code> · {g.text}</p>)}</div>}
    {goals && <ul className="grid gap-1">{goals.map((g, i) => <li key={i}>{t(g.trigger)} · {g.goal} · {g.target?.metric ?? g.gap?.text}</li>)}</ul>}
    <p className="mt-3 text-xs text-muted-foreground">{t('Goal drafts follow policy and count toward the daily draft allowance.')}</p>
  </div>;
}
