import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CircleHelp, FileText, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorBox, PageHeader } from '@/components/common';
import { api } from '@/lib/api';
import { useProjectId } from '@/lib/queries';
import { t } from '@/i18n';

export type IntakeAction = 'accept' | 'reject' | 'drop';
export type IntakeActionBody = { accept?: string[]; reject?: string[]; drop?: string[]; note?: string };

export function intakeActionBody(action: IntakeAction, system: string, note = ''): IntakeActionBody {
  if (action === 'accept') return { accept: [system] };
  return { [action]: [system], note: note.trim() } as IntakeActionBody;
}

type SystemSummary = { id: string; status: string; entities: number; target_count: number };
type BlockEntity = { id: string; kind: string; title?: string; text?: string };
type BlockSummary = { ref: string; classification: string; entities?: BlockEntity[]; superseded?: { ref: string; text: string }; reason?: string; gap?: string; question?: string };
type DesignBlock = { id: string; text: string; heading_path: string[]; level: number };
type DesignDoc = { id: string; title: string; order: number; version: number; blocks: DesignBlock[] };

const tone = (kind: string) => kind === 'mapped' ? 'success' : kind === 'superseded' ? 'primary' : kind === 'out-of-scope' ? 'neutral' : kind === 'unclear' ? 'danger' : 'warning';

export function IntakeSystemBar({ systems, onAction }: { systems: SystemSummary[]; onAction: (body: IntakeActionBody) => void }) {
  return <div className="mb-4 flex flex-wrap items-center gap-2">
    <Badge tone="success"><Check className="size-3" />{t('Accepted')}</Badge><Badge tone="warning"><RotateCcw className="size-3" />{t('Pending')}</Badge><Badge tone="danger"><CircleHelp className="size-3" />{t('Questions')}</Badge>
    {systems.map(system => <span key={system.id} className="ml-1 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs"><span className="font-mono font-semibold">{system.id}</span><Badge tone={system.status === 'accepted' ? 'success' : system.status === 'dropped' ? 'neutral' : system.status === 'rejected' ? 'danger' : 'warning'}>{t(system.status)}</Badge><span className="text-muted-foreground">{system.entities}/{system.target_count} {t('entities/targets')}</span><Button size="sm" variant="ghost" data-system={system.id} aria-label={`${t('Accept')} ${system.id}`} onClick={() => onAction(intakeActionBody('accept', system.id))}>{t('Accept')}</Button><Button size="sm" variant="ghost" data-system={system.id} aria-label={`${t('Reject')} ${system.id}`} onClick={() => onAction(intakeActionBody('reject', system.id))}>{t('Reject')}</Button><Button size="sm" variant="ghost" data-system={system.id} aria-label={`${t('Drop')} ${system.id}`} onClick={() => onAction(intakeActionBody('drop', system.id))}>{t('Drop')}</Button></span>)}
  </div>;
}

export function IntakeNoteForm({ action, system, note, onChange, onSubmit, onCancel }: { action: 'reject' | 'drop'; system: string; note: string; onChange: (value: string) => void; onSubmit: (body: IntakeActionBody) => void; onCancel: () => void }) {
  return <Card className="mb-4 flex items-center gap-2 p-3" data-testid="intake-note-form"><label htmlFor="intake-note">{action === 'reject' ? t('Reject note') : t('Drop note')}</label><Input id="intake-note" value={note} onChange={event => onChange(event.target.value)} placeholder={t('Required note')} className="min-w-56" /><Button size="sm" disabled={!note.trim()} onClick={() => onSubmit(intakeActionBody(action, system, note))}>{t('Submit')}</Button><Button size="sm" variant="ghost" onClick={onCancel}>{t('Cancel')}</Button></Card>;
}

export function IntakeCheckSummary({ latestCheck }: { latestCheck?: { status?: string; tail?: string; classified?: number; blocks?: number; issues?: (string | { message?: string })[] } }) {
  if (!latestCheck) return null;
  const issues = (latestCheck.issues ?? []).map(issue => typeof issue === 'string' ? issue : issue.message ?? '');
  return <Card className="mb-4 p-4" data-testid="intake-check-summary"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{t('Latest intake check')}</span><Badge tone={latestCheck.status === 'passed' ? 'success' : latestCheck.status === 'failed' ? 'danger' : 'warning'}>{latestCheck.status === 'passed' ? t('Passed') : latestCheck.status === 'failed' ? t('Failed') : t('Pending')}</Badge><span className="text-sm text-muted-foreground">{latestCheck.classified !== undefined && latestCheck.blocks !== undefined ? `${latestCheck.classified}/${latestCheck.blocks} ${t('blocks classified')}` : latestCheck.tail ?? ''}</span></div>{issues.length ? <ul className="mt-2 list-disc pl-5 text-sm">{issues.slice(0, 10).map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}</ul> : null}{issues.length > 10 ? <details className="mt-2 text-sm"><summary>{t('Show more issues')}</summary><ul className="list-disc pl-5">{issues.slice(10).map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}</ul></details> : null}</Card>;
}

export function IntakeBlockDetail({ selectedInfo, selectedBlock }: { selectedInfo?: BlockSummary; selectedBlock?: DesignBlock }) {
  if (!selectedInfo || !selectedBlock) return <EmptyState icon={<FileText />} title={t('Select a block')}>{t('The selected document block and its review action appear here.')}</EmptyState>;
  return <><div className="mb-3"><h2 className="font-semibold">{selectedInfo.ref}</h2><Badge tone={tone(selectedInfo.classification)}>{t(selectedInfo.classification)}</Badge></div><pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-4 font-mono text-xs leading-relaxed">{selectedBlock.text}</pre>{selectedInfo.classification === 'mapped' && <div className="mt-4"><h3 className="font-semibold">{t('Mapped entities')}</h3><ul className="mt-2 list-disc pl-5 text-sm">{selectedInfo.entities?.map(entity => <li key={entity.id}><span className="font-mono">{entity.id}</span> <span>{entity.kind}</span> {entity.title ?? entity.text ?? ''}</li>)}</ul></div>}{selectedInfo.classification === 'superseded' && <p className="mt-4 text-sm">{t('Superseded by')}: <span className="font-mono">{selectedInfo.superseded?.ref}</span><br />{selectedInfo.superseded?.text}</p>}{selectedInfo.classification === 'out-of-scope' && <p className="mt-4 text-sm">{selectedInfo.reason}</p>}{selectedInfo.classification === 'unclear' && <p className="mt-4 text-sm">{selectedInfo.gap}: {selectedInfo.question ?? t('No question recorded')}</p>}</>;
}

export function IntakeReviewPage() {
  const project = useProjectId(), { tag = '' } = useParams(), client = useQueryClient();
  const reviewView = useQuery({ queryKey: ['intake-review', project, tag], queryFn: () => api.intakeReviewView(project, tag), enabled: !!project && !!tag, staleTime: 10_000 });
  const [selected, setSelected] = useState<string>(); const [noteFor, setNoteFor] = useState<{ action: 'reject' | 'drop'; system: string }>(); const [note, setNote] = useState('');
  const review = useMutation({ mutationFn: (body: IntakeActionBody) => api.intakeReview(project, tag, body), onSuccess: () => { setNoteFor(undefined); setNote(''); void client.invalidateQueries({ queryKey: ['intake-review', project, tag] }); void client.invalidateQueries({ queryKey: ['order', project, tag] }); } });
  if (reviewView.isError) return <ErrorBox error={reviewView.error} />; if (!reviewView.data) return <div className="h-48 animate-pulse rounded-xl bg-muted" />;
  const list = [...reviewView.data.docs].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)) as DesignDoc[]; const blocks = reviewView.data.blocks ?? list.flatMap(doc => doc.blocks.map(block => ({ ref: `${doc.id}@${doc.version}#${block.id}`, classification: 'pending' }))); const selectedInfo = blocks.find(block => block.ref === selected) ?? blocks[0]; const selectedDoc = selectedInfo ? list.find(doc => selectedInfo.ref.startsWith(`${doc.id}@`)) : undefined; const selectedBlock = selectedDoc?.blocks.find(block => selectedInfo!.ref.endsWith(`#${block.id}`)); const latestCheck = (reviewView.data.latestCheck ?? reviewView.data.intake_check) as { status?: string; tail?: string; classified?: number; blocks?: number; issues?: (string | { message?: string })[] } | undefined;
  const classification = (doc: DesignDoc, block: DesignBlock) => { const entry = reviewView.data!.coverage[`${doc.id}@${doc.version}#${block.id}`] as Record<string, unknown> | undefined; return entry ? (['mapped', 'superseded', 'out-of-scope', 'unclear'].find(key => key in entry) ?? 'pending') : 'pending'; };
  const onSystemAction = (body: IntakeActionBody) => { if (body.accept) review.mutate(body); else { const action = body.reject ? 'reject' : 'drop'; setNoteFor({ action, system: (body.reject ?? body.drop)![0] }); setNote(''); } }; const submitNote = (body: IntakeActionBody) => { if (noteFor && note.trim()) review.mutate(body); };
  return <div data-testid="intake-review-page"><div className="mb-2 text-xs text-muted-foreground"><Link className="hover:underline" to={`/p/${encodeURIComponent(project)}/orders/${encodeURIComponent(tag)}`}>{tag}</Link> / {t('Intake review')}</div><PageHeader title={t('Intake review')} count={list.length}>{t('Review design document blocks and accept or return systems.')}</PageHeader><IntakeCheckSummary latestCheck={latestCheck} /><div className="flex items-center gap-2"><IntakeSystemBar systems={reviewView.data.systems} onAction={onSystemAction} /><Button size="sm" variant="outline" onClick={() => reviewView.refetch()}>{t('Refresh review')}</Button></div>{noteFor ? <IntakeNoteForm action={noteFor.action} system={noteFor.system} note={note} onChange={setNote} onSubmit={submitNote} onCancel={() => setNoteFor(undefined)} /> : null}{list.length === 0 ? <EmptyState icon={<FileText />} title={t('No design documents')}>{t('Add design_docs entries to alba.yaml or import a Markdown document.')}</EmptyState> : <div className="grid gap-4 lg:grid-cols-[minmax(15rem,24rem)_minmax(0,1fr)]"><Card className="divide-y overflow-hidden">{list.flatMap(doc => doc.blocks.map(block => { const ref = `${doc.id}@${doc.version}#${block.id}`, kind = classification(doc, block); return <button key={ref} data-testid={`intake-block-${ref}`} onClick={() => setSelected(ref)} className={`w-full border-l-2 px-4 py-3 text-left hover:bg-accent ${selectedInfo?.ref === ref ? 'bg-primary/8' : ''}`} style={{ borderLeftColor: kind === 'mapped' ? 'var(--color-success)' : kind === 'superseded' ? 'var(--color-primary)' : kind === 'out-of-scope' ? 'var(--color-muted-foreground)' : kind === 'unclear' ? 'var(--color-destructive)' : 'var(--color-warning)' }}><div className="flex items-center gap-2"><FileText className="size-4 text-primary" /><span className="font-mono text-xs">{ref}</span><Badge className="ml-auto" tone={tone(kind)}>{t(kind)}</Badge></div><p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{block.text}</p></button>; }))}</Card><Card className="min-h-80 p-5" data-testid="intake-block-detail"><IntakeBlockDetail selectedInfo={selectedInfo} selectedBlock={selectedBlock} /></Card></div>}</div>;
}
