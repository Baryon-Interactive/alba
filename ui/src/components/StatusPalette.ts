import type { Stage } from '@api';
import type { Tone } from '@/components/ui/badge';

/** Shared across badges, stage charts and board cards. */
export const statusTone: Record<Stage, Tone> = {
  running: 'info', monitoring: 'info', 'awaiting-user': 'warning', 'awaiting-review': 'review',
  blocked: 'danger', failed: 'danger', dropped: 'danger', merged: 'success',
  held: 'neutral', planned: 'neutral', draft: 'neutral', queued: 'neutral', 'waiting-needs': 'neutral', idle: 'neutral', cancelled: 'neutral',
};
export const statusColor = (stage: Stage) => ({ primary: 'var(--primary)', info: 'var(--info)', review: 'var(--review)', brand: 'var(--brand)', warning: 'var(--warning)', danger: 'var(--destructive)', success: 'var(--success)', neutral: 'var(--muted-foreground)', outline: 'var(--muted-foreground)' })[statusTone[stage]];
export const commitAgeClass = (minutes?: number) => minutes !== undefined && minutes > 60 ? 'text-destructive' : minutes !== undefined && minutes > 45 ? 'text-warning' : 'text-muted-foreground';
