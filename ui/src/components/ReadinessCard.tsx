import { AlertTriangle } from 'lucide-react';
import type { MergeReadiness } from '@api';
import { TagLink } from '@/components/common';
import { Card, CardContent } from '@/components/ui/card';
import { Tip } from '@/components/ui/misc';
import { t } from '@/i18n';

/** A warning for a board card whose branch changes files another open order also changes. The tooltip names those orders. */
export function OverlapWarning({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  const label = t('Overlaps {tags}', { tags: tags.join(', ') });
  return (
    <Tip text={label}>
      <span aria-label={label} className="inline-flex shrink-0 text-warning">
        <AlertTriangle className="size-3.5" aria-hidden />
      </span>
    </Tip>
  );
}

/** Behind, ahead, whether the merge is clean, and the other orders that touch the same files. */
export function ReadinessCard({ project, readiness }: { project: string; readiness: MergeReadiness }) {
  return (
    <Card>
      <CardContent className="grid gap-1.5">
        <p className="text-sm tabular-nums">{t('{behind} behind, {ahead} ahead', { behind: readiness.behind, ahead: readiness.ahead })}</p>
        {readiness.conflicts ? (
          <p className="text-sm break-words text-destructive">
            {t('would conflict')}
            {readiness.conflictFiles.length > 0 && <span className="font-mono text-xs"> {readiness.conflictFiles.join(', ')}</span>}
          </p>
        ) : (
          <p className="text-sm text-success">{t('merges cleanly')}</p>
        )}
        {readiness.overlaps.length > 0 && (
          <div className="mt-1">
            <div className="text-xs text-muted-foreground">{t('Overlaps')}</div>
            <ul className="mt-1 grid gap-1">
              {readiness.overlaps.map(o => (
                <li key={o.tag} className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
                  <TagLink project={project} tag={o.tag} />
                  <span className="min-w-0 font-mono text-xs break-all text-muted-foreground">{o.files.join(', ')}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
