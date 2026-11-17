import { useState } from 'react';
import type { OrderDetail } from '@api';
import { Badge } from './ui/badge';
import { Lightbox, type LightboxItem } from '@/components/Lightbox';
import { fileUrl } from '@/lib/api';
import { t } from '@/i18n';

type Trial = NonNullable<NonNullable<OrderDetail['acceptance']>['trial']>;

function extractBanner(tail: string): { heading: string; history: string[] } | undefined {
  const firstBlock = tail.split('\n\n')[0] ?? '';
  const lines = firstBlock.split('\n').filter(l => l.trim().length > 0);
  const head = lines[0]?.trim() ?? '';
  if (!head.startsWith('Not converging after ') && !head.startsWith('To the lead: ')) return undefined;
  return {
    heading: head,
    history: lines.slice(1).map(l => l.trim()),
  };
}

function fmtMetricValue(value: number, metric: string): string {
  return metric === 'motion' ? value.toFixed(2) : value.toFixed(3);
}

export function TargetPanel({ project, tag, trial }: { project: string; tag: string; trial: Trial }) {
  const [open, setOpen] = useState<number | null>(null);
  const step = trial.steps.find(s => s.name === 'target');
  const blocks = step?.target;
  if (!step || !blocks?.length) return null;

  const banner = extractBanner(step.tail);
  const items: LightboxItem[] = [];
  const sheetIndexByShot = new Map<string, number>();

  for (const b of blocks) {
    if (!b.sheet) continue;
    const sheetName = b.sheet.split(/[\\/]/).pop() ?? `${b.shot}.png`;
    sheetIndexByShot.set(b.shot, items.length);
    items.push({
      src: fileUrl(project, b.sheet, tag),
      name: sheetName,
      kind: 'image',
      caption: `${b.shot} · ${t('round')} ${b.round}${b.revision ? ` · ${b.revision.slice(0, 12)}` : ''}`,
    });
  }

  return (
    <div className="grid gap-3 rounded-md border p-3" data-testid="target-panel">
      {banner && (
        <div role="alert" className="grid gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="danger">{t('Not converging')}</Badge>
            <strong className="text-destructive">{banner.heading}</strong>
          </div>
          {banner.history.length > 0 && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground">
              {banner.history.join('\n')}
            </pre>
          )}
        </div>
      )}
      {blocks.map((b, idx) => {
        const sheetIdx = sheetIndexByShot.get(b.shot);
        const sheetItem = sheetIdx !== undefined ? items[sheetIdx] : undefined;
        return (
          <div key={`${b.shot}-${idx}`} className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <strong>
                {t('Visual target')}: <span className="font-mono">{b.shot}</span>
              </strong>
              <Badge tone={b.unmeasured ? 'warning' : b.pass ? 'success' : 'danger'}>
                {b.unmeasured ? t('unmeasured') : b.pass ? t('passed') : t('missed')}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {t('round')} {b.round}
              </span>
              {b.trend && (
                <Badge
                  tone={
                    b.stalled || b.trend === 'stalled' || b.trend === 'farther'
                      ? 'danger'
                      : b.trend === 'closer'
                        ? 'success'
                        : 'neutral'
                  }
                >
                  {t(b.trend)}
                </Badge>
              )}
              {b.reference && <span className="font-mono text-xs text-muted-foreground">{b.reference}</span>}
              {b.revision && (
                <span className="font-mono text-xs text-muted-foreground">
                  {t('revision')} {b.revision.slice(0, 12)}
                </span>
              )}
            </div>
            {b.unmeasured && <p className="whitespace-pre-wrap break-words text-xs text-destructive">{b.unmeasured}</p>}
            {b.rows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="py-1 pr-3 font-medium">{t('Metric')}</th>
                      <th className="py-1 pr-3 font-medium">{t('Target')}</th>
                      <th className="py-1 pr-3 font-medium">{t('Measured')}</th>
                      <th className="py-1 pr-3 font-medium">{t('Reference')}</th>
                      <th className="py-1 pr-3 font-medium">{t('Bound')}</th>
                      <th className="py-1 pr-3 font-medium">{t('Trend')}</th>
                      <th className="py-1 font-medium">{t('Status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, rIdx) => (
                      <tr
                        key={`${r.metric}-${r.label}-${rIdx}`}
                        data-status={r.pass ? 'pass' : 'miss'}
                        className={r.pass ? 'border-t' : 'border-t bg-destructive/10 text-destructive'}
                      >
                        <td className="py-1 pr-3 font-mono">{r.metric}</td>
                        <td className="py-1 pr-3">{r.label}</td>
                        <td className="py-1 pr-3 font-mono">{fmtMetricValue(r.value, r.metric)}</td>
                        <td className="py-1 pr-3 font-mono">
                          {r.reference !== undefined ? fmtMetricValue(r.reference, r.metric) : '—'}
                        </td>
                        <td className="py-1 pr-3 font-mono">{r.bound}</td>
                        <td className="py-1 pr-3">{r.trend ? t(r.trend) : '—'}</td>
                        <td className="py-1">
                          <Badge tone={r.pass ? 'success' : 'danger'}>{r.pass ? 'PASS' : 'MISS'}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {sheetItem && sheetIdx !== undefined && (
              <div>
                <button
                  type="button"
                  onClick={() => setOpen(sheetIdx)}
                  className="group block max-w-full text-left"
                  aria-label={`${t('Open at 100%')} · ${sheetItem.name}`}
                  title={t('Open at 100%')}
                >
                  <div className="flex max-h-56 items-center justify-center overflow-hidden rounded-md border bg-muted">
                    <img
                      src={sheetItem.src}
                      alt={sheetItem.name}
                      loading="lazy"
                      className="max-h-56 w-auto object-contain transition-transform group-hover:scale-[1.02]"
                    />
                  </div>
                  <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                    {t('Reference · Capture · Cell diff')} ({sheetItem.name})
                  </span>
                </button>
              </div>
            )}
          </div>
        );
      })}
      <Lightbox items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} naturalSize />
    </div>
  );
}
