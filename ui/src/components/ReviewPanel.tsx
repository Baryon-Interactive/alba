import { useEffect, useMemo, useState } from 'react';
import { DiffModeEnum, DiffView, SplitSide } from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view.css';
import { FileDiff, FilePlus2, FileMinus2, FileText, MessageSquarePlus, Trash2, GitCommitHorizontal, ShieldCheck } from 'lucide-react';
import type { DiffFile, OrderDetail } from '@api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/misc';
import { ActionButtons, ActionDialog } from '@/components/ActionDialog';
import { Empty, ErrorBox } from '@/components/common';
import { buildReworkNote, type DiffComment } from '@/lib/rework';
import { draftKey, emptyDraft, isEmptyDraft, loadDraft, saveDraft, type ReviewDraft, type StoredComment } from '@/lib/drafts';
import { visibleActions } from '@/lib/stages';
import { useDiff, useVerify } from '@/lib/queries';
import { useTheme } from '@/lib/theme';
import { ago } from '@/lib/format';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';

/** Git puts "diff --git" and "index" lines before the hunks; the viewer wants the text from "--- " on. */
export function hunkText(patch: string): string | undefined {
  const i = patch.search(/^--- /m);
  return i < 0 ? undefined : patch.slice(i);
}

const extOf = (path: string) => path.split('.').pop()?.toLowerCase() ?? '';

const statusIcon = (s: DiffFile['status']) => (s === 'added' ? <FilePlus2 className="size-3.5 text-success" /> : s === 'deleted' ? <FileMinus2 className="size-3.5 text-destructive" /> : <FileDiff className="size-3.5 text-primary" />);

function useStored(project: string, tag: string) {
  const key = draftKey(project, tag);
  const [state, setState] = useState<ReviewDraft>(() => loadDraft(key));
  useEffect(() => { saveDraft(key, state); }, [key, state]);
  return [state, setState] as const;
}

function CommentBox({ onSave, onClose }: { onSave: (text: string) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  return (
    <div className="border-y bg-muted/60 p-2.5 font-sans">
      <Textarea autoFocus value={text} onChange={e => setText(e.target.value)} placeholder={t('What should change on this line?')} className="min-h-16 bg-background" />
      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
        <Button size="sm" disabled={!text.trim()} onClick={() => { onSave(text.trim()); onClose(); }}>{t('Add comment')}</Button>
      </div>
    </div>
  );
}

function FileDiffView({ file, comments, onAdd, onRemove }: {
  file: DiffFile; comments: StoredComment[]; onAdd: (c: DiffComment) => void; onRemove: (id: string) => void;
}) {
  const theme = useTheme();
  const [mode, setMode] = useState<DiffModeEnum>(DiffModeEnum.Unified);
  const hunk = file.patch ? hunkText(file.patch) : undefined;
  const lang = extOf(file.path);
  const extendData = useMemo(() => {
    const out = { oldFile: {} as Record<string, { data: StoredComment[] }>, newFile: {} as Record<string, { data: StoredComment[] }> };
    for (const c of comments.filter(x => x.file === file.path)) {
      const side = c.side === 'old' ? out.oldFile : out.newFile;
      (side[String(c.line)] ??= { data: [] }).data.push(c);
    }
    return out;
  }, [comments, file.path]);

  if (file.binary) return <Empty icon={<FileText className="size-6 opacity-60" />}>{t('Binary file: no patch to show.')}</Empty>;
  if (!hunk) return <Empty icon={<FileText className="size-6 opacity-60" />}>{file.note ?? t('No patch for this file.')}</Empty>;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0 truncate font-mono text-[13px] font-semibold">{file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ` : ''}{file.path}</div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant={mode === DiffModeEnum.Unified ? 'secondary' : 'ghost'} onClick={() => setMode(DiffModeEnum.Unified)}>{t('Unified')}</Button>
          <Button size="sm" variant={mode === DiffModeEnum.Split ? 'secondary' : 'ghost'} onClick={() => setMode(DiffModeEnum.Split)}>{t('Split')}</Button>
        </div>
      </div>
      {file.truncated && <div className="mb-2 text-xs text-warning">{file.note ?? t('The patch was cut.')}</div>}
      <div className="overflow-hidden rounded-lg border">
        <DiffView<StoredComment[]>
          key={`${file.path}-${theme}`}
          data={{ oldFile: { fileName: file.oldPath ?? file.path, fileLang: lang }, newFile: { fileName: file.path, fileLang: lang }, hunks: [hunk] }}
          diffViewMode={mode}
          diffViewTheme={theme}
          diffViewHighlight
          diffViewWrap
          diffViewFontSize={12}
          diffViewAddWidget
          extendData={extendData}
          renderWidgetLine={({ side, lineNumber, onClose }) => (
            <CommentBox onClose={onClose} onSave={text => onAdd({ file: file.path, line: lineNumber, side: side === SplitSide.old ? 'old' : 'new', text })} />
          )}
          renderExtendLine={({ data }) => (
            <div className="grid gap-px border-y bg-muted/60 font-sans">
              {data.map(c => (
                <div key={c.id} className="flex items-start gap-2 px-3 py-2 text-[13px]">
                  <MessageSquarePlus className="mt-0.5 size-3.5 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1 whitespace-pre-wrap">{c.text}</div>
                  <button onClick={() => onRemove(c.id)} className="text-muted-foreground hover:text-destructive" aria-label={t('Remove comment')}><Trash2 className="size-3.5" /></button>
                </div>
              ))}
            </div>
          )}
        />
      </div>
    </div>
  );
}

/** The review tab: commits, files, patches. A comment on a line is kept; together with a remark they become the rework note. */
export default function ReviewPanel({ project, detail }: { project: string; detail: OrderDetail }) {
  const tag = detail.order.tag;
  const q = useDiff(project, tag, true);
  const verify = useVerify(project, tag);
  const [stored, setStored] = useStored(project, tag);
  const [selected, setSelected] = useState<string>();
  const [rework, setRework] = useState(false);
  const evidence = [...detail.reports].reverse().find(r => r.evidence.length)?.evidence ?? [];

  if (q.isError) return <div className="grid gap-3"><ErrorBox error={q.error} /><EvidenceList evidence={evidence} /></div>;
  if (!q.data) return <div className="grid gap-3"><Skeleton className="h-6 w-64" /><Skeleton className="h-64" /></div>;
  const d = q.data;
  const file = d.files.find(f => f.path === selected) ?? d.files.find(f => f.patch) ?? d.files[0];
  const counts = new Map<string, number>();
  for (const c of stored.comments) counts.set(c.file, (counts.get(c.file) ?? 0) + 1);
  const note = buildReworkNote(stored.general, stored.comments);
  const canRework = visibleActions(detail.stage, detail.actions).includes('rework');
  const verification = detail.verify;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span className="font-mono text-foreground">{d.head}</span><span>→ {t('against')} <span className="font-mono">{d.base}</span></span>
        <span>{t('{n} files', { n: d.stat.files })}</span>
        <span className="text-success">+{d.stat.insertions}</span><span className="text-destructive">−{d.stat.deletions}</span>
        {d.truncated && <Badge tone="warning">{d.note ?? t('Some patches were left out.')}</Badge>}
      </div>

      <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <div className="grid content-start gap-4">
          <Card className="overflow-hidden">
            <div className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground">{t('Files')}</div>
            <div className="max-h-96 overflow-auto p-1">
              {d.files.map(f => (
                <button key={f.path} onClick={() => setSelected(f.path)} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent', f.path === file?.path && 'bg-accent')}>
                  {statusIcon(f.status)}
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.path}>{f.path}</span>
                  {counts.get(f.path) ? <Badge tone="primary">{counts.get(f.path)}</Badge> : null}
                  {!f.binary && <span className="text-[11px] tabular-nums text-muted-foreground"><span className="text-success">+{f.insertions}</span> <span className="text-destructive">−{f.deletions}</span></span>}
                </button>
              ))}
            </div>
          </Card>
          <Card className="overflow-hidden">
            <div className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground">{t('Commits')} · {d.commits.length}</div>
            <div className="max-h-56 divide-y overflow-auto">
              {d.commits.map(c => (
                <div key={c.hash} className="flex items-start gap-2 px-3 py-2 text-[13px]">
                  <GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0"><div className="truncate">{c.subject}</div><div className="text-xs text-muted-foreground"><span className="font-mono">{c.hash.slice(0, 7)}</span> · {ago(c.at)}</div></div>
                </div>
              ))}
            </div>
          </Card>
          <EvidenceList evidence={evidence} />
        </div>

        <div className="min-w-0">
          {file ? (
            <FileDiffView
              file={file}
              comments={stored.comments}
              onAdd={c => setStored(s => ({ ...s, comments: [...s.comments, { ...c, id: crypto.randomUUID() }] }))}
              onRemove={id => setStored(s => ({ ...s, comments: s.comments.filter(c => c.id !== id) }))}
            />
          ) : <Empty>{t('The branch has no changes against its base.')}</Empty>}
        </div>
      </div>

      <Card className="p-4">
        <div className="mb-3 rounded-md border bg-muted/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="size-4" />{t('Acceptance gates')}</div>
            <Button size="sm" variant="outline" onClick={() => verify.mutate()} disabled={verify.isPending}>
              {verify.isPending ? t('Verifying…') : t('Run verification')}
            </Button>
          </div>
          {verification && <div className="mt-2 grid gap-1 text-xs">
            {verification.results.map((r, i) => <div key={`${r.name}-${i}`} className={r.status === 'fail' ? 'text-destructive' : r.status === 'warn' ? 'text-warning' : 'text-success'}>{r.status.toUpperCase()} · {r.name}: {r.reason}</div>)}
          </div>}
        </div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t('Rework note')} <span className="ml-1 text-xs font-normal text-muted-foreground">{t('{n} line comments', { n: stored.comments.length })}</span>{!isEmptyDraft(stored) && <Badge tone="warning" className="ml-2" title={t('Kept in this browser until it is sent with the rework.')}>{t('Draft (unsent)')}</Badge>}</h3>
        </div>
        <Textarea value={stored.general} onChange={e => setStored(s => ({ ...s, general: e.target.value }))} placeholder={t('General remarks for the next run (optional)')} className="min-h-16" />
        {note && <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted px-3 py-2 text-xs whitespace-pre-wrap">{note}</pre>}
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <ActionButtons project={project} tag={tag} actions={detail.actions} only={visibleActions(detail.stage, detail.actions).filter(a => a === 'approve')} size="default" noBranch={!detail.order.branch} />
          <Button disabled={!canRework || !note} onClick={() => setRework(true)} title={canRework ? undefined : detail.unavailable.rework}>{t('Send back for rework')}</Button>
        </div>
        {rework && (
          <ActionDialog
            project={project} tag={tag} action="rework" open onOpenChange={o => !o && setRework(false)} initialText={note}
            onDone={() => setStored(emptyDraft())}
          />
        )}
      </Card>
    </div>
  );
}

function EvidenceList({ evidence }: { evidence: string[] }) {
  if (!evidence.length) return null;
  return (
    <Card className="overflow-hidden">
      <div className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground">{t('Evidence files')} · {evidence.length}</div>
      <div className="divide-y">
        {evidence.map(e => <div key={e} className="flex items-center gap-2 px-3 py-1.5 font-mono text-xs"><FileText className="size-3.5 text-muted-foreground" />{e}</div>)}
      </div>
    </Card>
  );
}
