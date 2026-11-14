import { useState } from 'react';
import { Check, Pencil } from 'lucide-react';
import { RolesSection } from '@/components/Roles';
import { RoutingEditor } from '@/components/RoutingEdit';
import { PageHeader } from '@/components/common';
import { Button } from '@/components/ui/button';
import { useProjectId } from '@/lib/queries';
import { t } from '@/i18n';

export function RolesPage({ editing: start = false }: { editing?: boolean }) {
  const project = useProjectId();
  const [editing, setEditing] = useState(start);
  const toggle = <Button variant={editing ? 'default' : 'outline'} onClick={() => setEditing(e => !e)}>{editing ? <><Check />{t('Done')}</> : <><Pencil />{t('Edit')}</>}</Button>;
  return <div>
    <PageHeader title={t('Routing')} actions={toggle}>{editing ? t('Change the worker groups and routes of the project file and the workers file. Each file is saved on its own, and checked whole before it is written.') : t('Worker groups, and the routes that send each kind of work to one of them.')}</PageHeader>
    {editing ? <RoutingEditor project={project} /> : <RolesSection project={project} />}
  </div>;
}
