import { lazy, Suspense, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';

// The dialog (and its query) loads only when it is opened.
const Dialog = lazy(() => import('./ProducerSettings').then(m => ({ default: m.ProducerSettingsDialog })));

export function ProducerSettingsButton({ project }: { project: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}><SlidersHorizontal className="size-4" />{t('Settings')}</Button>
    {open && <Suspense fallback={null}><Dialog project={project} open={open} onOpenChange={setOpen} /></Suspense>}
  </>;
}
