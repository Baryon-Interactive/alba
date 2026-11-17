import { useState } from 'react';
import type { OrderDetail } from '@api';
import { Badge } from './ui/badge';
import { Lightbox, type LightboxItem } from '@/components/Lightbox';
import { fileUrl } from '@/lib/api';
import { t } from '@/i18n';

type CaptureSummary = NonNullable<NonNullable<OrderDetail['acceptance']>['capture']>;

export function CaptureSheet({ project, tag, capture }: { project: string; tag: string; capture: CaptureSummary }) {
  const [open, setOpen] = useState<number | null>(null);
  const sheetName = capture.sheet ? (capture.sheet.split(/[\\/]/).pop() ?? 'sheet.png') : '';
  const items: LightboxItem[] = [
    ...(capture.sheet
      ? [{ src: fileUrl(project, capture.sheet, tag), name: sheetName, kind: 'image' as const, caption: `${capture.recipe}${capture.revision ? ` · ${capture.revision.slice(0, 12)}` : ''}` }]
      : []),
    ...capture.shots
      .filter(s => s.status === 'ok')
      .map(s => ({
        src: fileUrl(project, s.file, tag),
        name: `${s.name}.png`,
        kind: 'image' as const,
        caption: s.width && s.height ? `${s.name} · ${s.width}x${s.height}` : s.name,
      })),
  ];
  const shotIndexByName = new Map<string, number>();
  let idx = capture.sheet ? 1 : 0;
  for (const s of capture.shots) {
    if (s.status === 'ok') shotIndexByName.set(s.name, idx++);
  }

  return <div className="grid gap-2 rounded-md border p-3">
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <strong>{t("Alba's captures")}</strong>
      <Badge tone={capture.status === 'passed' ? 'success' : 'danger'}>{capture.status}</Badge>
      <span className="text-xs text-muted-foreground">{capture.recipe}</span>
      {capture.revision && <span className="font-mono text-xs text-muted-foreground">{t('revision')} {capture.revision.slice(0, 12)}</span>}
    </div>
    {capture.reason && <p className="whitespace-pre-wrap break-words text-xs">{capture.reason}</p>}
    {capture.sheet && items[0] && (
      <div>
        <button
          type="button"
          onClick={() => setOpen(0)}
          className="group block max-w-full text-left"
          aria-label={`${t('Open at 100%')} · ${items[0].name}`}
          title={t('Open at 100%')}
        >
          <div className="flex max-h-64 items-center justify-center overflow-hidden rounded-md border bg-muted">
            <img src={items[0].src} alt={items[0].name} loading="lazy" className="max-h-64 w-auto object-contain transition-transform group-hover:scale-[1.02]" />
          </div>
          <span className="mt-1 block truncate text-[11px] text-muted-foreground">{items[0].name}</span>
        </button>
      </div>
    )}
    {capture.shots.length > 0 && (
      <ul className="grid gap-1 text-xs">
        {capture.shots.map(s => {
          const shotIdx = shotIndexByName.get(s.name);
          return <li key={s.name} className="flex flex-wrap items-center gap-2">
            <Badge tone={s.status === 'ok' ? 'success' : 'danger'}>{s.status}</Badge>
            {shotIdx !== undefined
              ? <button type="button" onClick={() => setOpen(shotIdx)} className="font-mono text-primary hover:underline">{s.name}</button>
              : <span className="font-mono">{s.name}</span>}
            {s.width !== undefined && s.height !== undefined && <span className="text-muted-foreground">{s.width}x{s.height}</span>}
            {s.reason && <span className="text-muted-foreground">{s.reason}</span>}
          </li>;
        })}
      </ul>
    )}
    {capture.gates.length > 0 && (
      <div className="grid gap-1 text-xs">
        {capture.gates.map(g => (
          <div key={g.name} className="flex flex-wrap items-center gap-2">
            <Badge title={g.detail} tone={g.status === 'pass' ? 'success' : g.status === 'warn' ? 'warning' : 'danger'}>
              {g.name}: {g.status.toUpperCase()}
            </Badge>
            <span className="text-muted-foreground">{g.detail}</span>
          </div>
        ))}
      </div>
    )}
    <Lightbox items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} naturalSize />
  </div>;
}
