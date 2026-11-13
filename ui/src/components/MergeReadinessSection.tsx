import { ErrorBox, Section } from '@/components/common';
import { ReadinessCard } from '@/components/ReadinessCard';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/misc';
import { t } from '@/i18n';
import { useReadiness } from '@/lib/queries';

/** The card on an order that is awaiting review. `enabled` is false when the order has no branch. */
export function MergeReadinessSection({ project, tag, enabled }: { project: string; tag: string; enabled: boolean }) {
  const q = useReadiness(project, tag, enabled);
  return (
    <Section title={t('Merge readiness')}>
      {!enabled && <Card className="p-3.5 text-sm text-muted-foreground">{t('This order has no branch to review yet.')}</Card>}
      {enabled && q.isLoading && <Skeleton className="h-24" />}
      {enabled && q.isError && <ErrorBox error={q.error} />}
      {q.data && <ReadinessCard project={project} readiness={q.data} />}
    </Section>
  );
}
