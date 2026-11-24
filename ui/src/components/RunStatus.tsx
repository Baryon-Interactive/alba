import { CircleDashed, LoaderCircle, Pause, X } from 'lucide-react';
import type { Liveness } from '@api';
import { t } from '@/i18n';

export function RunStatus({ liveness, quietMinutes }: { liveness?: Liveness; quietMinutes?: number }) {
  if (!liveness) return null;
  const styles = {
    active: [LoaderCircle, 'motion-safe:animate-spin text-info', t('Recent activity or no confirmed silence')],
    quiet: [Pause, 'text-muted-foreground', t('Process is alive but quiet')],
    unverifiable: [CircleDashed, 'text-warning', t('Cannot confirm the process is alive')],
    gone: [X, 'text-destructive', t('Process is no longer alive')],
  } as const;
  const [Icon, color, reason] = styles[liveness];
  const age = quietMinutes === undefined ? t('Activity time unknown') : t('{n} min since activity', { n: quietMinutes });
  const title = reason + ' · ' + age;
  return <span role="img" className="inline-flex shrink-0" title={title} aria-label={title}><Icon aria-hidden className={'size-4 ' + color} /></span>;
}
