import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog as D } from 'radix-ui';
import { Check, ChevronLeft, ChevronRight, Maximize2, Minimize2, X } from 'lucide-react';
import type { PickSet } from '@api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { fileUrl } from '@/lib/api';
import { choiceText, pickImages } from '@/lib/library';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';

export interface PickLightboxProps {
  project: string;
  set: PickSet;
  /** Which picture to open first (index in the set's pictures, option by option). */
  start: number | null;
  selected: string[];
  onToggle: (key: string) => void;
  note: string;
  onNote: (note: string) => void;
  onConfirm: () => void;
  confirming: boolean;
  onClose: () => void;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;

/**
 * A pick set's pictures at their own size. Arrow keys (or the buttons) go through them; the mouse wheel zooms and a drag moves the picture;
 * "fit" and "actual size" switch (key F); Space (or the button) selects the option the picture belongs to; the note and the confirmation
 * are here too, so a person can look and decide without leaving.
 */
export function PickLightbox({ project, set, start, selected, onToggle, note, onNote, onConfirm, confirming, onClose }: PickLightboxProps) {
  const images = pickImages(set);
  const [index, setIndex] = useState(start ?? 0);
  const [fit, setFit] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const open = start !== null;
  useEffect(() => { if (start !== null) setIndex(start); }, [start]);
  const reset = useCallback(() => { setZoom(1); setPos({ x: 0, y: 0 }); }, []);
  useEffect(reset, [index, fit, reset]);

  const image = images[index];
  const go = useCallback((to: number) => { if (to >= 0 && to < images.length) setIndex(to); }, [images.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) return;      // typing a note
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(index - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(index + 1); }
      else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); setFit(v => !v); }
      else if (e.key === '0') { e.preventDefault(); reset(); }
      else if ((e.key === ' ' || e.key === 's' || e.key === 'S') && image) { e.preventDefault(); onToggle(image.optionKey); }
    };
    // a focused button would also click on the key coming up
    const onUp = (e: KeyboardEvent) => { const el = e.target as HTMLElement | null; if (e.key === ' ' && !(el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'))) e.preventDefault(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onUp); };
  }, [open, index, go, image, onToggle, reset]);

  const isSelected = !!image && selected.includes(image.optionKey);
  return (
    <D.Root open={open} onOpenChange={o => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/85" />
        <D.Content className="fixed inset-0 z-50 flex flex-col outline-none" aria-describedby={undefined}>
          <div className="flex items-center gap-2 px-3 py-2 text-white">
            <D.Title className="min-w-0 flex-1 truncate text-sm font-medium">{set.title}{image ? ` · ${image.optionKey}: ${image.label}` : ''}</D.Title>
            {images.length > 0 && <span className="text-xs tabular-nums text-white/70">{index + 1} / {images.length}</span>}
            <Button variant="ghost" size="sm" className="text-white hover:bg-white/15 hover:text-white" onClick={() => setFit(v => !v)} aria-pressed={!fit} title="F">
              {fit ? <Maximize2 /> : <Minimize2 />}{fit ? t('Actual size') : t('Fit')}
            </Button>
            <D.Close asChild><Button variant="ghost" size="icon" className="text-white hover:bg-white/15 hover:text-white" aria-label={t('Close')}><X /></Button></D.Close>
          </div>

          <div
            className={cn('relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden px-3', !fit || zoom !== 1 ? 'cursor-grab active:cursor-grabbing' : '')}
            onWheel={e => setZoom(z => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))))}
            onPointerDown={e => { drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }}
            onPointerMove={e => { const d = drag.current; if (d) setPos({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y }); }}
            onPointerUp={() => { drag.current = null; }}
            onDoubleClick={reset}
          >
            {index > 0 && <Arrow side="left" onClick={() => go(index - 1)} />}
            {image && image.exists
              ? <img
                  key={image.path} src={fileUrl(project, image.path, set.waitingOrder ?? set.order)} alt={`${image.optionKey}: ${image.label}`} draggable={false}
                  className={cn('select-none rounded-md', fit ? 'max-h-full max-w-full object-contain' : 'max-w-none')}
                  style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${zoom})` }}
                />
              : <div className="rounded-md border border-white/30 px-4 py-6 text-sm text-white/80">{image ? t('The picture {path} is missing', { path: image.path }) : t('This set has no pictures.')}</div>}
            {index < images.length - 1 && <Arrow side="right" onClick={() => go(index + 1)} />}
          </div>

          <div className="grid gap-2 border-t border-white/15 bg-black/60 px-3 py-2.5 text-white sm:grid-cols-[auto_1fr_auto] sm:items-end">
            <div className="grid gap-1">
              <Button
                variant={isSelected ? 'default' : 'outline'} size="sm" disabled={!image}
                className={cn(!isSelected && 'border-white/40 bg-transparent text-white hover:bg-white/15 hover:text-white')}
                onClick={() => image && onToggle(image.optionKey)} aria-pressed={isSelected}
              >
                <Check />{image ? (isSelected ? t('{key} is selected', { key: image.optionKey }) : t('Select {key}', { key: image.optionKey })) : t('Select')}
              </Button>
              <span className="text-[11px] text-white/60">{set.multi ? t('Several may be selected') : t('One option may be selected')} · ← → F Space</span>
            </div>
            <Textarea value={note} onChange={e => onNote(e.target.value)} placeholder={t('A note with the choice (optional)')} className="min-h-12 border-white/25 bg-white/8 text-white placeholder:text-white/50" />
            <div className="grid gap-1 justify-items-end">
              <span className="text-xs text-white/70">{selected.length ? t('Chosen: {text}', { text: choiceText(set, selected) }) : t('Nothing selected yet')}</span>
              <Button size="sm" disabled={!selected.length || confirming} onClick={onConfirm}>{confirming ? t('Working…') : t('Confirm choice')}</Button>
            </div>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function Arrow({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <button onPointerDown={e => e.stopPropagation()} onClick={onClick} aria-label={side === 'left' ? t('Previous') : t('Next')} className={cn('absolute top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70', side === 'left' ? 'left-4' : 'right-4')}>
      <Icon className="size-5" />
    </button>
  );
}
