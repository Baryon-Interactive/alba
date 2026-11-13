import { useEffect, useState } from 'react';
import { Dialog as D } from 'radix-ui';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';

export interface LightboxItem {
  src: string;
  name: string;
  kind: 'image' | 'video';
  /** A line under the picture: size, time, where it was found. */
  caption?: string;
}

const VIDEO = /\.(mp4|webm|mov)$/i;
export const kindOfPath = (path: string): 'image' | 'video' => (VIDEO.test(path) ? 'video' : 'image');

/** A picture or video at its own size, with arrows (and the arrow keys) to move through the others. */
export function Lightbox({ items, index, onIndex, onClose, naturalSize = false }: { items: LightboxItem[]; index: number | null; onIndex: (i: number) => void; onClose: () => void; naturalSize?: boolean }) {
  const [actual, setActual] = useState(naturalSize);
  useEffect(() => { if (index !== null) setActual(naturalSize); }, [index, naturalSize]);
  const item = index === null ? undefined : items[index];
  useEffect(() => {
    if (index === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
      if (e.key === 'ArrowRight' && index < items.length - 1) onIndex(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, items.length, onIndex]);

  return (
    <D.Root open={!!item} onOpenChange={o => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/80" />
        <D.Content className="fixed inset-0 z-50 flex flex-col outline-none" aria-describedby={undefined}>
          <div className="flex items-center gap-2 px-3 py-2 text-white">
            <D.Title className="min-w-0 flex-1 truncate text-sm font-medium">{item?.name}</D.Title>
            {item?.kind === 'image' && <Button size="sm" variant="ghost" className="text-white hover:bg-white/15 hover:text-white" onClick={() => setActual(v => !v)}>{actual ? t('Fit to window') : t('Open at 100%')}</Button>}
            {items.length > 1 && index !== null && <span className="text-xs tabular-nums text-white/70">{index + 1} / {items.length}</span>}
            <D.Close asChild><Button variant="ghost" size="icon" className="text-white hover:bg-white/15 hover:text-white" aria-label={t('Close')}><X /></Button></D.Close>
          </div>
          <div className="relative flex min-h-0 flex-1 overflow-auto px-3 pb-3" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
            {index !== null && index > 0 && <Arrow side="left" onClick={() => onIndex(index - 1)} />}
            {item?.kind === 'video'
              ? <video key={item.src} src={item.src} controls autoPlay className="m-auto max-h-full max-w-full rounded-md bg-black" />
              : item && <img key={item.src} src={item.src} alt={item.name} className={actual ? 'm-auto h-auto w-auto max-w-none shrink-0 self-start' : 'm-auto max-h-full max-w-full rounded-md object-contain'} />}
            {index !== null && index < items.length - 1 && <Arrow side="right" onClick={() => onIndex(index + 1)} />}
          </div>
          {item?.caption && <div className="px-4 pb-3 text-center text-xs text-white/70">{item.caption}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function Arrow({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <button onClick={onClick} aria-label={side === 'left' ? t('Previous') : t('Next')} className={cn('fixed top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70', side === 'left' ? 'left-4' : 'right-4')}>
      <Icon className="size-5" />
    </button>
  );
}
