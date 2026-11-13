import type { CleanPlan, ProducerView } from '@api';
import { Section, TagLink } from '@/components/common';
import { Card } from '@/components/ui/card';

export function CleanPlanItems({ plan }: { plan: CleanPlan }) {
  return <div className="mt-2 grid gap-2 text-xs">{plan.items.map((item, index) => <div key={`${item.path}-${index}`} className="break-words"><strong>{item.action} · {item.pathClass ?? item.kind}</strong> · {item.bytes === undefined ? 'size unknown' : `${(item.bytes / 2 ** 20).toFixed(1)} MB`}<div className="font-mono">{item.path}{item.targets.length ? ` [${item.targets.join(', ')}]` : ''}</div><p>{item.reason}</p>{item.result && <p>{item.result}</p>}</div>)}</div>;
}

export function ProducerRoundFacts({ project, data }: { project: string; data: Pick<ProducerView, 'notes' | 'drives' | 'lastClean'> }) {
  return <>
    <Section title="Disk space"><Card className="p-4 text-sm">{data.drives?.length ? data.drives.map(d => <p key={d.path} className={d.low ? 'text-destructive' : ''}>{d.path}: {d.free_gb === undefined ? 'unavailable' : `${d.free_gb.toFixed(1)} GB free`} / minimum {d.min_free_gb} GB{d.error && ` · ${d.error}`}</p>) : <p>No drive thresholds configured.</p>}{data.lastClean && <details className="mt-3"><summary>Last clean · {data.lastClean.at}</summary><CleanPlanItems plan={data.lastClean} /></details>}</Card></Section>
    <Section title="Producer notes"><Card className="p-4 text-sm"><h3 className="font-semibold">Project</h3><p className="whitespace-pre-wrap">{data.notes?.project || 'No project notes.'}</p>{data.notes?.orders.map(n => <div key={n.tag} className="mt-3"><TagLink project={project} tag={n.tag} /><p className="whitespace-pre-wrap">{n.text}</p></div>)}</Card></Section>
  </>;
}
