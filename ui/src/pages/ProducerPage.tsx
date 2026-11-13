import { lazy, Suspense } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { Factory } from 'lucide-react';
import { ErrorBox, PageHeader } from '@/components/common';
import { Skeleton } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { DirectorConversation } from '@/components/DirectorConversation';
import { ProducerActivity } from '@/components/ProducerActivity';
import { ProducerSettingsButton } from '@/components/ProducerSettingsButton';
import { needsProducerDecision } from '@/lib/producer-activity';
import { useProducerWorkspace, useProjectId } from '@/lib/queries';
import { t } from '@/i18n';

const Analysis = lazy(() => import('./ProducerAnalysis').then(m => ({ default: m.ProducerAnalysis })));

export function ProducerPage() {
  const routeProject = useProjectId();
  const { hash } = useLocation();
  const [params, setParams] = useSearchParams();
  const project = routeProject || params.get('project') || '';
  const q = useProducerWorkspace(project);
  const requestedTab = params.get('tab');
  const tab = requestedTab === 'activity' || requestedTab === 'analysis' || requestedTab === 'conversation' ? requestedTab : hash ? 'analysis' : needsProducerDecision(q.data) ? 'conversation' : 'activity';
  const setTab = (next: string) => setParams(previous => { const updated = new URLSearchParams(previous); updated.set('tab', next); return updated; });
  if (!project) return <ErrorBox error={new Error(t('Choose a project to open the Producer page.'))} />;
  return <div className="flex h-full min-h-0 w-full min-w-0 flex-col" data-workspace="producer">
    <div className="shrink-0"><PageHeader title={<><Factory className="size-5" />{t('Producer')}</>} actions={<ProducerSettingsButton project={project} />} /></div>
    <div className="mb-3 flex shrink-0 gap-2" role="tablist" aria-label={t('Producer')}>
      <Button role="tab" aria-selected={tab === 'conversation'} variant={tab === 'conversation' ? 'default' : 'ghost'} onClick={() => setTab('conversation')}>{t('Conversation')}</Button>
      <Button role="tab" aria-selected={tab === 'analysis'} variant={tab === 'analysis' ? 'default' : 'ghost'} onClick={() => setTab('analysis')}>{t('Analysis')}</Button>
      <Button role="tab" aria-selected={tab === 'activity'} variant={tab === 'activity' ? 'default' : 'ghost'} onClick={() => setTab('activity')}>{t('Activity')}</Button>
    </div>
    <div className={tab === 'conversation' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'} role="tabpanel" aria-label={t('Conversation')}>
      {q.isError ? <ErrorBox error={q.error} /> : q.data ? <DirectorConversation key={project} project={project} workspace={q.data} refresh={() => { void q.refetch(); }} analysis={() => setTab('analysis')} /> : <Skeleton className="h-full" />}
    </div>
    {tab === 'analysis' && <Suspense fallback={<Skeleton className="h-full" />}><Analysis project={project} /></Suspense>}
    {tab === 'activity' && <div className="min-h-0 flex-1 overflow-y-auto pr-2" role="tabpanel" aria-label={t('Activity')}><ProducerActivity project={project} /></div>}
  </div>;
}
