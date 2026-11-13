import { RolesSection } from '@/components/Roles';
import { PageHeader } from '@/components/common';
import { useProjectId } from '@/lib/queries';
import { t } from '@/i18n';

export function RolesPage() {
  const project = useProjectId();
  return <div><PageHeader title={t('Roles')}>{t('Jobs, requirements and worker fallbacks')}</PageHeader><RolesSection project={project} /></div>;
}
