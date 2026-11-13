import { RolesSection } from '@/components/Roles';
import { PageHeader } from '@/components/common';
import { useProjectId } from '@/lib/queries';
import { t } from '@/i18n';

export function RolesPage() {
  const project = useProjectId();
  return <div><PageHeader title={t('Routing')}>{t('Worker groups, and the routes that send each kind of work to one of them.')}</PageHeader><RolesSection project={project} /></div>;
}
