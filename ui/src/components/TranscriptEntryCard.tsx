import { memo, useEffect, useState, type ReactNode } from 'react';
import Anser from 'anser';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangle,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Copy,
  FilePenLine,
  ListTodo,
  Loader2,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  XCircle,
} from 'lucide-react';
import type { RunUsage, TranscriptEntry } from '@api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { UsageText } from '@/components/common';
import { dateTime, tokens } from '@/lib/format';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  compactInputPairs,
  formatStepDuration,
  isSmallEditDiff,
  renderEditDiff,
} from './TranscriptLogic';

const keepUrl = (url: string) => url;

function SafeLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (href && /^https?:\/\//i.test(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  }
  return <span>{children}</span>;
}

const markdownComponents: Components = {
  a: ({ href, children }) => <SafeLink href={href}>{children}</SafeLink>,
  img: ({ alt }) => <span className="font-mono text-xs text-muted-foreground">{alt ? `[${alt}]` : ''}</span>,
};

function SafeMarkdown({ text }: { text: string }) {
  return (
    <div className="doc-body text-[13.5px] leading-relaxed">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={keepUrl}
        disallowedElements={['script', 'style', 'iframe', 'object', 'embed']}
        components={markdownComponents}
      >
        {text}
      </Markdown>
    </div>
  );
}

const AnsiLine = memo(function AnsiLine({ text }: { text: string }) {
  const parts = Anser.ansiToJson(text, { json: true, remove_empty: true, use_classes: false });
  if (parts.length === 0) return <>{'\u00a0'}</>;
  return (
    <>
      {parts.map((p, i) => {
        const dec = p.decoration ?? '';
        return (
          <span
            key={i}
            style={{
              color: p.fg ? `rgb(${p.fg})` : undefined,
              backgroundColor: p.bg ? `rgb(${p.bg})` : undefined,
              fontWeight: dec.includes('bold') ? 600 : undefined,
              opacity: dec.includes('dim') ? 0.65 : undefined,
              textDecoration: dec.includes('underline') ? 'underline' : undefined,
            }}
          >
            {p.content}
          </span>
        );
      })}
    </>
  );
});

function AnsiBlock({ text, className }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return (
    <pre
      className={cn(
        'max-h-96 overflow-auto rounded-md bg-[oklch(0.18_0.01_258)] px-3 py-2 font-mono text-xs leading-[18px] whitespace-pre-wrap break-words text-[oklch(0.9_0.005_250)]',
        className,
      )}
    >
      {lines.map((line, i) => (
        <div key={i}>
          <AnsiLine text={line} />
        </div>
      ))}
    </pre>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (ev: React.MouseEvent) => {
    ev.stopPropagation();
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
      onClick={copy}
      aria-label={label}
      title={label}
    >
      {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
      <span>{copied ? t('Copied') : t('Copy')}</span>
    </Button>
  );
}

function StepStateIcon({ state, live }: { state: TranscriptEntry['state']; live: boolean }) {
  if (state === 'running') {
    return live ? (
      <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-label={t('running')} />
    ) : (
      <Circle className="size-3.5 shrink-0 text-warning" aria-label={t('interrupted')} />
    );
  }
  if (state === 'failed') return <XCircle className="size-3.5 shrink-0 text-destructive" aria-label={t('failed')} />;
  return <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-label={t('done')} />;
}

function TruncatedBadge({ truncated }: { truncated?: boolean }) {
  if (!truncated) return null;
  return <Badge tone="warning">{t('truncated')}</Badge>;
}

function CommandCard({ entry, live, highlighted }: { entry: TranscriptEntry; live: boolean; highlighted: boolean }) {
  const failed = entry.state === 'failed';
  const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined);
  // Output collapsed by default and expanded automatically when it failed.
  useEffect(() => {
    if (failed && userOpen === undefined) setUserOpen(true);
  }, [failed, userOpen]);
  const open = userOpen ?? failed;
  const hasOutput = Boolean(entry.output);
  const dur = formatStepDuration(entry.duration_seconds);

  return (
    <div
      className={cn(
        'rounded-lg border bg-card transition-colors',
        failed && 'border-destructive/45 bg-destructive/4',
        highlighted && 'ring-2 ring-primary',
      )}
    >
      <div
        className={cn('flex flex-wrap items-center gap-2 px-3 py-2 text-xs', hasOutput && 'cursor-pointer select-none hover:bg-accent/35')}
        onClick={() => hasOutput && setUserOpen(!open)}
      >
        {hasOutput ? (
          open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <StepStateIcon state={entry.state} live={live} />
        <code className="min-w-0 flex-1 font-mono text-xs break-all text-foreground">{entry.title}</code>
        <div className="flex shrink-0 items-center gap-1.5">
          {entry.exit_code !== undefined && (
            <Badge tone={entry.exit_code === 0 ? 'outline' : 'danger'}>{t('exit {n}', { n: entry.exit_code })}</Badge>
          )}
          {dur && <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{dur}</span>}
          <TruncatedBadge truncated={entry.truncated} />
          <CopyButton value={entry.output ? `${entry.title}\n\n${entry.output}` : entry.title} label={t('Copy command')} />
        </div>
      </div>
      {hasOutput && open && (
        <div className="border-t px-3 py-2">
          <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{t('Command output')}</span>
            <CopyButton value={entry.output!} label={t('Copy output')} />
          </div>
          <AnsiBlock text={entry.output!} />
        </div>
      )}
    </div>
  );
}

function EditCard({ entry, live, highlighted }: { entry: TranscriptEntry; live: boolean; highlighted: boolean }) {
  const edits = entry.edit ?? [];
  const defaultOpen = isSmallEditDiff(edits);
  const [open, setOpen] = useState(defaultOpen);
  const rendered = edits.map(edit => ({ edit, parsed: renderEditDiff(edit) }));
  const totalAdd = rendered.reduce((n, r) => n + r.parsed.additions, 0);
  const totalDel = rendered.reduce((n, r) => n + r.parsed.deletions, 0);
  const totalBody = rendered.reduce((n, r) => n + r.parsed.bodyLines, 0);
  const hasDiff = totalBody > 0;

  return (
    <div className={cn('rounded-lg border bg-card', entry.state === 'failed' && 'border-destructive/45', highlighted && 'ring-2 ring-primary')}>
      <div
        className={cn('flex flex-wrap items-center gap-2 px-3 py-2 text-xs', hasDiff && 'cursor-pointer select-none hover:bg-accent/35')}
        onClick={() => hasDiff && setOpen(o => !o)}
      >
        {hasDiff ? (
          open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <FilePenLine className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <StepStateIcon state={entry.state} live={live} />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {edits.length > 0 ? (
            edits.map((e, i) => (
              <span key={`${e.path}-${i}`} className="inline-flex items-center gap-1 font-mono text-xs text-foreground">
                {e.kind && <Badge tone="outline">{e.kind}</Badge>}
                <span className="break-all">{e.path}</span>
              </span>
            ))
          ) : (
            <span className="font-mono text-xs break-all">{entry.title}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums">
          {(totalAdd > 0 || totalDel > 0) && (
            <>
              <span className="text-success">+{totalAdd}</span>
              <span className="text-destructive">-{totalDel}</span>
            </>
          )}
          {hasDiff && !open && <span className="text-muted-foreground">({t('{n} lines', { n: totalBody })})</span>}
          <TruncatedBadge truncated={entry.truncated} />
        </div>
      </div>
      {hasDiff && open && (
        <div className="divide-y border-t">
          {rendered.map(({ edit, parsed }, idx) =>
            parsed.lines.length > 0 ? (
              <div key={`${edit.path}-${idx}`} className="overflow-x-auto">
                {edits.length > 1 && (
                  <div className="border-b bg-muted/40 px-3 py-1 font-mono text-[11px] text-muted-foreground">{edit.path}</div>
                )}
                <div className="max-h-96 overflow-y-auto py-1 font-mono text-xs leading-[18px]">
                  {parsed.lines.map((line, li) => {
                    if (line.kind === 'meta') return null;
                    if (line.kind === 'hunk') {
                      return (
                        <div key={li} className="bg-info/10 px-3 py-0.5 text-[11px] text-muted-foreground">
                          {line.text}
                        </div>
                      );
                    }
                    return (
                      <div
                        key={li}
                        className={cn(
                          'grid grid-cols-[2.75rem_2.75rem_1.25rem_minmax(0,1fr)] px-2 whitespace-pre-wrap break-all',
                          line.kind === 'add' && 'bg-success/12 text-foreground',
                          line.kind === 'del' && 'bg-destructive/12 text-foreground',
                        )}
                      >
                        <span className="pr-1.5 text-right text-[10.5px] text-muted-foreground select-none tabular-nums">{line.oldLine ?? ''}</span>
                        <span className="pr-1.5 text-right text-[10.5px] text-muted-foreground select-none tabular-nums">{line.newLine ?? ''}</span>
                        <span
                          className={cn(
                            'select-none font-semibold',
                            line.kind === 'add' && 'text-success',
                            line.kind === 'del' && 'text-destructive',
                            line.kind === 'context' && 'text-muted-foreground',
                          )}
                        >
                          {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                        </span>
                        <span>{line.text || '\u00a0'}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

function ToolCard({ entry, live, highlighted }: { entry: TranscriptEntry; live: boolean; highlighted: boolean }) {
  const [open, setOpen] = useState(false);
  const pairs = compactInputPairs(entry.input);
  const hasDetails = Boolean(entry.output || (entry.input && Object.keys(entry.input).length > 0));
  const dur = formatStepDuration(entry.duration_seconds);

  return (
    <div className={cn('rounded-lg border bg-card', entry.state === 'failed' && 'border-destructive/45', highlighted && 'ring-2 ring-primary')}>
      <div
        className={cn('flex flex-wrap items-center gap-2 px-3 py-2 text-xs', hasDetails && 'cursor-pointer select-none hover:bg-accent/35')}
        onClick={() => hasDetails && setOpen(o => !o)}
      >
        {hasDetails ? (
          open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <StepStateIcon state={entry.state} live={live} />
        <span className="font-mono text-xs font-medium break-all text-foreground">{entry.title}</span>
        {pairs.length > 0 && (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {pairs.map(p => (
              <span key={p.key} className="max-w-60 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                {p.key}={p.value}
              </span>
            ))}
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {dur && <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{dur}</span>}
          <TruncatedBadge truncated={entry.truncated} />
        </div>
      </div>
      {hasDetails && open && (
        <div className="grid gap-2 border-t px-3 py-2 text-xs">
          {entry.input && Object.keys(entry.input).length > 0 && (
            <div>
              <div className="mb-1 text-[11px] text-muted-foreground">{t('Parameters')}</div>
              <pre className="max-h-56 overflow-auto rounded-md bg-muted/60 px-2.5 py-2 font-mono text-[11.5px] whitespace-pre-wrap break-words">
                {JSON.stringify(entry.input, null, 2)}
              </pre>
            </div>
          )}
          {entry.output && (
            <div>
              <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>{t('Output')}</span>
                <CopyButton value={entry.output} label={t('Copy output')} />
              </div>
              <AnsiBlock text={entry.output} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReasoningCard({ entry }: { entry: TranscriptEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-dashed bg-muted/25 opacity-80 transition-opacity hover:opacity-100">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground"
        onClick={() => setOpen(o => !o)}
      >
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <Brain className="size-3.5 shrink-0" />
        <span className="shrink-0 font-medium">{t('Reasoning')}</span>
        <span className="min-w-0 flex-1 truncate">{entry.title}</span>
        <TruncatedBadge truncated={entry.truncated} />
      </button>
      {open && entry.text && (
        <div className="border-t border-dashed px-3 py-2 text-xs whitespace-pre-wrap text-muted-foreground">{entry.text}</div>
      )}
    </div>
  );
}

function SearchCard({ entry, live }: { entry: TranscriptEntry; live: boolean }) {
  const [open, setOpen] = useState(false);
  const hasOutput = Boolean(entry.output);
  return (
    <div className="rounded-lg border bg-card">
      <div
        className={cn('flex items-center gap-2 px-3 py-2 text-xs', hasOutput && 'cursor-pointer select-none hover:bg-accent/35')}
        onClick={() => hasOutput && setOpen(o => !o)}
      >
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <StepStateIcon state={entry.state} live={live} />
        <span className="shrink-0 text-muted-foreground">{t('Search')}</span>
        <span className="min-w-0 flex-1 font-mono text-xs break-all text-foreground">{entry.title}</span>
        {hasOutput && (open ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />)}
      </div>
      {hasOutput && open && (
        <div className="border-t px-3 py-2">
          <AnsiBlock text={entry.output!} />
        </div>
      )}
    </div>
  );
}

function PlanCard({ entry }: { entry: TranscriptEntry }) {
  const steps = entry.plan ?? [];
  const done = steps.filter(s => s.status === 'done' || s.status === 'completed').length;
  return (
    <div className="rounded-lg border bg-card px-3.5 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
          <ListTodo className="size-3.5 text-primary" />
          {t('Plan')}
        </span>
        <Badge tone="outline">
          {done} / {steps.length}
        </Badge>
      </div>
      <ol className="grid gap-1 text-xs">
        {steps.map((p, i) => {
          const isDone = p.status === 'done' || p.status === 'completed';
          const isDoing = p.status === 'doing' || p.status === 'in_progress';
          return (
            <li
              key={`${p.step}-${i}`}
              className={cn(
                'flex items-start gap-2 rounded px-2 py-1',
                isDoing && 'bg-primary/10 font-medium text-primary',
                isDone && 'text-muted-foreground line-through decoration-muted-foreground/50',
              )}
            >
              <span className="w-4 shrink-0 font-mono text-[11px]">{isDone ? '✓' : isDoing ? '→' : '○'}</span>
              <span className="min-w-0 flex-1 break-words">{p.step}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ErrorCard({ entry }: { entry: TranscriptEntry }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/45 border-l-[3px] border-l-destructive bg-destructive/8 px-3.5 py-2.5 text-xs"
    >
      <div className="flex items-center gap-2 font-medium text-destructive">
        <AlertTriangle className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 break-words">{entry.title}</span>
        <TruncatedBadge truncated={entry.truncated} />
      </div>
      {entry.text && entry.text !== entry.title && (
        <pre className="mt-1.5 max-h-64 overflow-auto font-mono text-xs whitespace-pre-wrap break-words text-foreground/90">{entry.text}</pre>
      )}
    </div>
  );
}

function ResultCard({ entry, fallbackUsage }: { entry: TranscriptEntry; fallbackUsage?: RunUsage }) {
  const failed = entry.state === 'failed';
  const u = entry.usage ?? (fallbackUsage && fallbackUsage.source !== 'unknown' ? fallbackUsage : undefined);
  const dur = formatStepDuration(entry.duration_seconds);

  return (
    <div
      className={cn(
        'rounded-xl border border-l-[3px] px-4 py-3',
        failed ? 'border-destructive/45 border-l-destructive bg-destructive/8' : 'border-success/40 border-l-success bg-success/6',
      )}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-1.5 font-semibold">
          <Sparkles className={cn('size-3.5', failed ? 'text-destructive' : 'text-success')} />
          <span>{failed ? t('Run failed') : t('Final result')}</span>
          <Badge tone={failed ? 'danger' : 'success'}>{failed ? t('failed') : t('completed')}</Badge>
          <TruncatedBadge truncated={entry.truncated} />
        </div>
        <span className="text-muted-foreground">{dateTime(entry.at)}</span>
      </div>
      {entry.text ? <SafeMarkdown text={entry.text} /> : <p className="text-sm font-medium">{entry.title}</p>}
      {(u || dur) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/70 pt-2 text-xs text-muted-foreground">
          {u && (
            <span>
              {t('Usage')}: <UsageText usage={u} />
            </span>
          )}
          {u && (u.input_tokens !== undefined || u.output_tokens !== undefined) && (
            <span className="tabular-nums">
              {t('In / out / cached')}: {tokens(u.input_tokens)} / {tokens(u.output_tokens)} / {tokens(u.cached_tokens)}
            </span>
          )}
          {u?.turns !== undefined && <span>{t('{n} turns', { n: u.turns })}</span>}
          {dur && <span className="tabular-nums">{dur}</span>}
        </div>
      )}
    </div>
  );
}

function MessageCard({ entry, live }: { entry: TranscriptEntry; live: boolean }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3 shadow-2xs">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          {entry.state === 'running' && live ? (
            <span className="size-2 rounded-full bg-primary live-dot" />
          ) : (
            <span className="size-1.5 rounded-full bg-primary/70" />
          )}
          <span className="font-medium text-foreground">{t('Agent')}</span>
          <TruncatedBadge truncated={entry.truncated} />
        </div>
        <span>{dateTime(entry.at)}</span>
      </div>
      <SafeMarkdown text={entry.text ?? entry.title} />
    </div>
  );
}

function LogBlockCard({ entry }: { entry: TranscriptEntry }) {
  return (
    <div className="rounded-lg border bg-[oklch(0.18_0.01_258)] p-0.5">
      {entry.truncated && (
        <div className="flex justify-end px-2.5 pt-1">
          <TruncatedBadge truncated />
        </div>
      )}
      <AnsiBlock text={entry.text ?? entry.title} />
    </div>
  );
}

export const TranscriptEntryCard = memo(function TranscriptEntryCard({
  entry,
  live,
  highlighted = false,
  fallbackUsage,
}: {
  entry: TranscriptEntry;
  live: boolean;
  highlighted?: boolean;
  fallbackUsage?: RunUsage;
}) {
  switch (entry.kind) {
    case 'message':
      return <MessageCard entry={entry} live={live} />;
    case 'reasoning':
      return <ReasoningCard entry={entry} />;
    case 'command':
      return <CommandCard entry={entry} live={live} highlighted={highlighted} />;
    case 'tool':
      return <ToolCard entry={entry} live={live} highlighted={highlighted} />;
    case 'edit':
      return <EditCard entry={entry} live={live} highlighted={highlighted} />;
    case 'search':
      return <SearchCard entry={entry} live={live} />;
    case 'plan':
      return <PlanCard entry={entry} />;
    case 'error':
      return <ErrorCard entry={entry} />;
    case 'result':
      return <ResultCard entry={entry} fallbackUsage={fallbackUsage} />;
    case 'log':
      return <LogBlockCard entry={entry} />;
  }
});
