import { useState } from 'react';
import { Check, Send, Star } from 'lucide-react';
import type { QuestionOption } from '@api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Label, Textarea } from '@/components/ui/input';
import { ErrorBox } from '@/components/common';
import { Lightbox, kindOfPath, type LightboxItem } from '@/components/Lightbox';
import { fileUrl } from '@/lib/api';
import { errorText } from '@/lib/queries';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';

/**
 * The choices of a question as cards (the recommended one first, with its mark), pictures as thumbnails that open at full size.
 * Choosing asks for confirmation, with an optional note; `submit` does the writing.
 */
export function OptionsPicker({ project, tag, options, submit, onDone }: {
  project: string;
  tag: string;
  options: QuestionOption[];
  submit: (choice: number, note: string) => Promise<unknown>;
  onDone?: () => void;
}) {
  const [picked, setPicked] = useState<number>();
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [view, setView] = useState<number | null>(null);

  const gallery: (LightboxItem & { option: number })[] = options.flatMap((o, i) => o.images.map(path => ({
    src: fileUrl(project, path, tag), name: path.split('/').pop() ?? path, kind: kindOfPath(path), caption: `${i + 1}. ${o.label}`, option: i,
  })));
  const chosen = picked === undefined ? undefined : options[picked];

  const send = async () => {
    if (picked === undefined) return;
    setBusy(true); setError(undefined);
    try { await submit(picked + 1, note.trim()); setConfirm(false); setNote(''); setPicked(undefined); onDone?.(); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };

  let g = -1;
  return (
    <div className="mt-3">
      <div role="radiogroup" className="grid gap-2 sm:grid-cols-2">
        {options.map((o, i) => (
          <div
            key={o.key}
            role="radio"
            aria-checked={picked === i}
            tabIndex={0}
            onClick={() => setPicked(i)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPicked(i); } }}
            className={cn('cursor-pointer rounded-lg border bg-card p-3 text-left outline-none transition-colors hover:border-primary/60 focus-visible:ring-[3px] focus-visible:ring-ring', picked === i && 'border-primary bg-primary/6 ring-1 ring-primary')}
          >
            <div className="flex items-start gap-2">
              <span className={cn('mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border text-[11px] font-semibold', picked === i ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground')}>
                {picked === i ? <Check className="size-3" /> : o.key}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                  {o.label}
                  {o.recommended && <Badge tone="success"><Star />{t('recommended')}</Badge>}
                </div>
                {o.note && <p className="mt-0.5 text-xs text-muted-foreground">{o.note}</p>}
              </div>
            </div>
            {o.images.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {o.images.map(path => {
                  const idx = ++g;
                  return (
                    <button key={path} type="button" title={t('Open at full size')} onClick={e => { e.stopPropagation(); setView(idx); }} className="overflow-hidden rounded-md border bg-muted outline-none focus-visible:ring-[3px] focus-visible:ring-ring">
                      {kindOfPath(path) === 'video'
                        ? <span className="grid h-20 w-28 place-items-center text-xs text-muted-foreground">{path.split('/').pop()}</span>
                        : <img src={fileUrl(project, path, tag)} alt={path.split('/').pop() ?? path} loading="lazy" className="h-20 w-28 object-cover" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <Textarea value={note} onChange={e => setNote(e.target.value)} placeholder={t('A note with your choice (optional)')} className="min-h-12" />
        <Button disabled={picked === undefined} onClick={() => setConfirm(true)}><Send />{picked === undefined ? t('Choose one') : t('Choose {n}', { n: picked + 1 })}</Button>
      </div>

      <Dialog open={confirm} onOpenChange={o => { if (!busy) setConfirm(o); }}>
        <DialogContent>
          <DialogTitle>{t('Choose option {n}?', { n: (picked ?? 0) + 1 })}</DialogTitle>
          <DialogDescription>{t('Your choice is recorded with the time and where it came from, and the order goes on from it.')}</DialogDescription>
          {chosen && <div className="rounded-md border-l-2 border-primary bg-muted px-3 py-2 text-sm"><span className="font-medium">{chosen.key}. {chosen.label}</span>{chosen.note && <div className="text-xs text-muted-foreground">{chosen.note}</div>}</div>}
          {note.trim() && <div className="grid gap-1"><Label>{t('Note')}</Label><div className="rounded-md bg-muted px-3 py-2 text-sm whitespace-pre-wrap">{note.trim()}</div></div>}
          {error && <ErrorBox error={error} />}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)} disabled={busy}>{t('Back')}</Button>
            <Button disabled={busy} onClick={() => void send()}>{busy ? t('Working…') : t('Confirm: {verb}', { verb: t('choose') })}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Lightbox items={gallery} index={view} onIndex={setView} onClose={() => setView(null)} />
    </div>
  );
}
