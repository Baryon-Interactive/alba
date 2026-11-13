import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, Columns2, Film, GripVertical, SplitSquareHorizontal, X } from 'lucide-react';
import type { EvidenceFile } from '@api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/misc';
import { Empty, ErrorBox } from '@/components/common';
import { Lightbox, type LightboxItem } from '@/components/Lightbox';
import { api, fileUrl } from '@/lib/api';
import { keys } from '@/lib/keys';
import { ago, bytes as sizeText } from '@/lib/format';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';

const fromText = (f: EvidenceFile['from']) => (f === 'report' ? t('named in a report') : f === 'folder' ? t('evidence folder') : t('picture of a question'));

/** Pictures are shown a page at a time: a folder can hold hundreds, each of them megabytes. */
const PAGE = 24;

type CompareMode = 'side' | 'slider';

/** Two pictures next to each other, or one over the other with a divider to drag. */
export function CompareView({ left, right, project, tag, onClose, onSwap }: { left: EvidenceFile; right: EvidenceFile; project: string; tag: string; onClose: () => void; onSwap: () => void }) {
  const [mode, setMode] = useState<CompareMode>('side');
  const [pos, setPos] = useState(50);
  const box = useRef<HTMLDivElement>(null);
  const drag = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (r) setPos(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
  };
  const l = fileUrl(project, left.path, tag);
  const r = fileUrl(project, right.path, tag);
  const label = (f: EvidenceFile) => `${f.name}${f.width && f.height ? ` · ${f.width}×${f.height}` : ''}`;

  return (
    <Card className="p-3" data-testid="compare">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-sm font-semibold">{t('Compare')}</h3>
        <Button size="sm" variant={mode === 'side' ? 'default' : 'outline'} onClick={() => setMode('side')}><Columns2 />{t('Side by side')}</Button>
        <Button size="sm" variant={mode === 'slider' ? 'default' : 'outline'} onClick={() => setMode('slider')}><SplitSquareHorizontal />{t('Divider')}</Button>
        <Button size="sm" variant="ghost" onClick={onSwap} title={t('Swap left and right')}><ArrowLeftRight /></Button>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label={t('Close')}><X /></Button>
      </div>
      {mode === 'side' ? (
        <div className="grid gap-3 md:grid-cols-2">
          {[{ f: left, src: l }, { f: right, src: r }].map(({ f, src }) => (
            <figure key={f.path} className="min-w-0">
              <div className="grid place-items-center overflow-hidden rounded-md border bg-muted/50"><img src={src} alt={f.name} className="max-h-[70vh] w-full object-contain" /></div>
              <figcaption className="mt-1 truncate text-center text-xs text-muted-foreground" title={f.path}>{label(f)}</figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <div>
          <div
            ref={box}
            className="relative mx-auto touch-none select-none overflow-hidden rounded-md border bg-muted/50"
            style={{ maxWidth: '100%', aspectRatio: right.width && right.height ? `${right.width} / ${right.height}` : undefined }}
            onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); drag(e.clientX); }}
            onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) drag(e.clientX); }}
          >
            <img src={r} alt={right.name} draggable={false} className="block max-h-[70vh] w-full object-contain" />
            <img src={l} alt={left.name} draggable={false} className="absolute inset-0 h-full w-full object-contain" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} />
            <div className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]" style={{ left: `${pos}%` }}>
              <span className="absolute top-1/2 left-1/2 grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white text-black shadow"><GripVertical className="size-4" /></span>
            </div>
          </div>
          <input type="range" min={0} max={100} value={pos} onChange={e => setPos(Number(e.target.value))} aria-label={t('Divider')} className="mt-2 w-full" />
          <div className="mt-1 flex justify-between gap-2 text-xs text-muted-foreground"><span className="truncate" title={left.path}>◀ {label(left)}</span><span className="truncate text-right" title={right.path}>{label(right)} ▶</span></div>
        </div>
      )}
    </Card>
  );
}

/** The pictures and videos of an order: named in its reports, found in its evidence folders, or shown as options of its questions. */
export function EvidencePanel({ project, tag }: { project: string; tag: string }) {
  const q = useQuery({ queryKey: keys.evidence(project, tag), queryFn: () => api.evidence(project, tag), staleTime: 15_000 });
  const [view, setView] = useState<number | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [swapped, setSwapped] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  const files = q.data?.files ?? [];
  const items: LightboxItem[] = useMemo(() => files.map(f => ({
    src: fileUrl(project, f.path, tag), name: f.name, kind: f.kind === 'video' ? 'video' : 'image',
    caption: [f.width && f.height ? `${f.width}×${f.height}` : '', sizeText(f.size), ago(f.modified), fromText(f.from)].filter(Boolean).join(' · '),
  })), [files, project, tag]);
  const shown = files.map((f, i) => ({ f, i })).filter(x => x.f.kind !== 'other');

  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"><Skeleton className="h-40" /><Skeleton className="h-40" /><Skeleton className="h-40" /></div>;
  if (shown.length === 0) {
    return <Empty>{t('No pictures or videos yet.')}{q.data.note ? <div className="mt-1 text-xs">{q.data.note}</div> : null}{q.data.folders.length > 0 && <div className="mt-1 font-mono text-xs">{q.data.folders.join(', ')}</div>}</Empty>;
  }

  const toggle = (path: string) => setPicked(p => (p.includes(path) ? p.filter(x => x !== path) : [...p.slice(-1), path]));
  const byPath = new Map(files.map(f => [f.path, f]));
  const two = picked.length === 2 ? picked.map(p => byPath.get(p)!).filter(f => f && f.kind === 'image') : [];
  const pair = two.length === 2 ? (swapped ? [two[1]!, two[0]!] : [two[0]!, two[1]!]) : undefined;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>{t('{n} files', { n: shown.length })}</span>
        <span className="text-xs">{t('Tick two pictures to compare them.')}</span>
        {picked.length > 0 && <Button size="sm" variant="ghost" onClick={() => { setPicked([]); setComparing(false); }}>{t('Clear')}</Button>}
        <Button size="sm" className="ml-auto" disabled={!pair} onClick={() => setComparing(true)}><Columns2 />{t('Compare')}</Button>
      </div>
      {comparing && pair && <CompareView left={pair[0]} right={pair[1]} project={project} tag={tag} onClose={() => setComparing(false)} onSwap={() => setSwapped(s => !s)} />}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {shown.slice(0, limit).map(({ f, i }) => {
          const on = picked.includes(f.path);
          return (
            <Card key={f.path} className={cn('overflow-hidden', on && 'ring-2 ring-primary')}>
              <button type="button" onClick={() => setView(i)} className="relative block aspect-[4/3] w-full bg-muted outline-none focus-visible:ring-[3px] focus-visible:ring-ring" title={t('Open at full size')}>
                {f.kind === 'video'
                  ? <><video src={`${fileUrl(project, f.path, tag)}#t=0.1`} preload="metadata" muted className="size-full object-cover" /><span className="absolute inset-0 grid place-items-center"><span className="rounded-full bg-black/55 p-2 text-white"><Film className="size-5" /></span></span></>
                  : <img src={fileUrl(project, f.path, tag)} alt={f.name} loading="lazy" decoding="async" className="size-full object-cover" />}
              </button>
              <div className="flex items-start gap-2 p-2">
                {f.kind === 'image' && <input type="checkbox" checked={on} onChange={() => toggle(f.path)} aria-label={t('Compare')} className="mt-0.5 size-4 accent-[var(--primary)]" />}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium" title={f.path}>{f.name}</div>
                  <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
                    {f.width && f.height && <span className="tabular-nums">{f.width}×{f.height}</span>}<span>{sizeText(f.size)}</span><span>{ago(f.modified)}</span>
                  </div>
                  <Badge tone="outline" className="mt-1">{fromText(f.from)}</Badge>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
      {shown.length > limit && <div className="text-center"><Button variant="outline" onClick={() => setLimit(n => n + PAGE)}>{t('Show {n} more', { n: Math.min(PAGE, shown.length - limit) })}</Button></div>}
      <Lightbox items={shown.map(x => items[x.i]!)} index={view === null ? null : shown.findIndex(x => x.i === view)} onIndex={k => setView(shown[k]?.i ?? null)} onClose={() => setView(null)} />
    </div>
  );
}
