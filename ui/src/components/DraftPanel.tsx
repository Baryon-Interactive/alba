import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrderDefinition } from '@api';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorBox, Section } from '@/components/common';
import { OrderBodyEditor } from './OrderBodyEditor';
import { t } from '@/i18n';

export function DraftPanel({ project, order }: { project: string; order: OrderDefinition }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['order-draft', project, order.tag], queryFn: () => api.orderDraft(project, order.tag), refetchInterval: 15_000 });
  const [editing, setEditing] = useState<string>();
  const [plan, setPlan] = useState<{ title: string; kind: string; needs: string; intent: string; role: string }>();
  const refresh = () => { void client.invalidateQueries(); };
  const mutation = useMutation({ mutationFn: ({ decision, body }: { decision: 'save' | 'accept' | 'reject'; body?: string }) => api.decideDraft(project, order.tag, query.data!.action!.id, decision, body), onSuccess: () => { setEditing(undefined); refresh(); } });
  const again = useMutation({ mutationFn: () => api.draftAgain(project, order.tag), onSuccess: refresh });
  const edit = useMutation({ mutationFn: () => api.editPlan(project, order.tag, { ...plan!, needs: plan!.needs.split(/[\s,]+/).filter(Boolean) }), onSuccess: () => { setPlan(undefined); refresh(); } });
  const { action, preview } = query.data ?? {};
  const pending = action && ['proposed', 'would-do'].includes(action.status);
  const ranges: { start: number; end: number }[] = [];
  for (const match of preview?.resources.resources.flatMap(r => r.matches).sort((a, b) => a.start - b.start) ?? []) {
    const start = match.start - preview!.resources.bodyStart, end = match.end - preview!.resources.bodyStart;
    if (end <= 0) continue;
    const last = ranges.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start: Math.max(0, start), end });
  }
  let end = 0;
  const highlighted = ranges.map((r, i) => { const before = preview!.body.slice(end, r.start); end = r.end; return <Fragment key={i}>{before}<mark>{preview!.body.slice(r.start, r.end)}</mark></Fragment>; });
  return <Section title="Producer draft"><Card><CardContent className="grid gap-3">
    <p>{order.intent}</p>
    {order.planned && <Button variant="outline" onClick={() => setPlan({ title: order.title, kind: order.kind, needs: order.needs.join(', '), intent: order.intent ?? '', role: order.role ?? '' })}>Edit plan</Button>}
    {plan && <div className="grid gap-2">{(['title', 'kind', 'needs', 'role'] as const).map(key => <label key={key}>{key}<Input value={plan[key]} onChange={e => setPlan({ ...plan, [key]: e.target.value })} /></label>)}<label>Intent<Textarea value={plan.intent} onChange={e => setPlan({ ...plan, intent: e.target.value })} /></label><Button disabled={edit.isPending} onClick={() => edit.mutate()}>Save plan</Button></div>}
    {query.isError && <ErrorBox error={query.error} />}
    {!action && !query.data?.work && <p className="text-sm text-muted-foreground">Waiting for dependencies and producer drafting.</p>}
    {action && <p className="text-sm">Draft: {action.status}{action.refusal && ` · ${action.refusal}`}</p>}
    {query.data?.work && <p className="text-sm">{t('Last draft session: {status}', { status: query.data.work.status })}{query.data.work.reason && ` · ${query.data.work.reason}`}</p>}
    {order.planned && query.data && <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" disabled={!query.data.canDraftAgain || again.isPending} onClick={() => again.mutate()}>{t('Draft again')}</Button>
      {!query.data.canDraftAgain && query.data.why && <span className="text-xs text-muted-foreground">{query.data.why}</span>}
    </div>}
    {again.isError && <ErrorBox error={again.error} />}
    {preview && <>
      <div className="text-sm">Classifier: {preview.classifier.kind || 'unclassified'} · Worker: {preview.route.chosen ?? preview.route.why}</div>
      <div className="text-sm">Resource patterns: {preview.resources.resources.length ? preview.resources.resources.map(r => <div key={r.resource}>{r.resource} ({r.pattern}): {r.matches.map((m, i) => <Fragment key={i}><mark>{m.text}</mark>{' '}</Fragment>)}</div>) : 'none'}</div>
      <div className="text-sm">Missing in {preview.baseRef}: {preview.missingPaths.join(', ') || 'none'}</div>
      {editing !== undefined ? <OrderBodyEditor value={editing} onChange={setEditing} /> : <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs">{highlighted}{preview.body.slice(end)}</pre>}
    </>}
    {pending && <div className="flex flex-wrap gap-2">
      {editing === undefined ? <Button variant="outline" onClick={() => setEditing(action.order!.body)}>Edit body</Button> : <Button disabled={mutation.isPending} onClick={() => mutation.mutate({ decision: 'save', body: editing })}>Save draft and refresh preview</Button>}
      <Button disabled={mutation.isPending || editing !== undefined} onClick={() => mutation.mutate({ decision: 'accept' })}>Accept and queue</Button>
      <Button variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate({ decision: 'reject' })}>Reject</Button>
    </div>}
    {mutation.isError && <ErrorBox error={mutation.error} />}{edit.isError && <ErrorBox error={edit.error} />}
  </CardContent></Card></Section>;
}
