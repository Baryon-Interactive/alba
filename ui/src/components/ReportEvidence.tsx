import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Lightbox } from '@/components/Lightbox';
import { fileUrl } from '@/lib/api';
import { t } from '@/i18n';

export const imageEvidence = (path: string) => /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(path);

/** Report paths resolve through the same order-aware file route as the evidence panel. */
export function ReportEvidence({ project, tag, evidence, commits }: { project: string; tag: string; evidence: string[]; commits: string[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const images = evidence.filter(imageEvidence);
  const other = evidence.filter(path => !imageEvidence(path));
  const items = images.map(path => ({ src: fileUrl(project, path, tag), name: path.split(/[\\/]/).pop() ?? path, kind: 'image' as const }));
  return <>
    {images.length > 0 && <div className="mt-3 flex gap-3 overflow-x-auto pb-1" aria-label={t('Image evidence')}>
      {items.map((item, i) => <button key={item.src} onClick={() => setOpen(i)} className="group w-48 shrink-0 text-left" aria-label={`${t('Open at 100%')} · ${item.name}`} title={t('Open at 100%')}><div className="flex h-28 items-center justify-center overflow-hidden rounded-md border bg-muted"><img src={item.src} alt={item.name} loading="lazy" className="size-full object-contain transition-transform group-hover:scale-105" /></div><span className="mt-1 block truncate text-[11px] text-muted-foreground">{item.name}</span></button>)}
    </div>}
    {(commits.length > 0 || other.length > 0) && <details className="mt-3 border-t pt-2 text-xs"><summary className="text-muted-foreground">{t('Details')}</summary><div className="mt-2 grid gap-2 break-all">
      {commits.length > 0 && <p className="font-mono"><span className="font-sans text-muted-foreground">{t('commits')}: </span>{commits.join(' · ')}</p>}
      {other.map(path => <a className="flex items-start gap-1 text-primary hover:underline" href={fileUrl(project, path, tag)} target="_blank" rel="noreferrer" key={path}><ExternalLink className="mt-0.5 size-3 shrink-0" />{path}</a>)}
    </div></details>}
    <Lightbox items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} naturalSize />
  </>;
}
