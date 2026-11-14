import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { Shell } from '@/components/Shell';
import { useLang } from '@/i18n';
import { Skeleton } from '@/components/ui/misc';

const RolesPage = lazy(() => import('@/pages/RolesPage').then(m => ({ default: m.RolesPage })));
const ToolsPage = lazy(() => import('@/pages/ToolsPage').then(m => ({ default: m.ToolsPage })));
const MachinesPage = lazy(() => import('@/pages/MachinesPage').then(m => ({ default: m.MachinesPage })));
const UsagePage = lazy(() => import('@/pages/UsagePage').then(m => ({ default: m.UsagePage })));
const NeedsPage = lazy(() => import('@/pages/NeedsPage').then(m => ({ default: m.NeedsPage })));
const BoardPage = lazy(() => import('@/pages/BoardPage').then(m => ({ default: m.BoardPage })));
const OrderPage = lazy(() => import('@/pages/OrderPage').then(m => ({ default: m.OrderPage })));
const RunPage = lazy(() => import('@/pages/RunPage').then(m => ({ default: m.RunPage })));
const RunsPage = lazy(() => import('@/pages/RunsPage').then(m => ({ default: m.RunsPage })));
const TickPage = lazy(() => import('@/pages/TickPage').then(m => ({ default: m.TickPage })));
const NewOrderPage = lazy(() => import('@/pages/NewOrderPage').then(m => ({ default: m.NewOrderPage })));
const OverviewPage = lazy(() => import('@/pages/OverviewPage').then(m => ({ default: m.OverviewPage })));
const OverviewListPage = lazy(() => import('@/pages/OverviewPage').then(m => ({ default: m.OverviewListPage })));
const ProjectOverviewPage = lazy(() => import('@/pages/ProjectOverviewPage').then(m => ({ default: m.ProjectOverviewPage })));
const ProducerPage = lazy(() => import('@/pages/ProducerPage').then(m => ({ default: m.ProducerPage })));

const DecisionsPage = lazy(() => import('@/pages/DecisionsPage').then(m => ({ default: m.DecisionsPage })));
const DesignPage = lazy(() => import('@/pages/DesignPage').then(m => ({ default: m.DesignPage })));
const SkillsPage = lazy(() => import('@/pages/SkillsPage').then(m => ({ default: m.SkillsPage })));
const LessonsPage = lazy(() => import('@/pages/LessonsPage').then(m => ({ default: m.LessonsPage })));
const CleanPage = lazy(() => import('@/pages/CleanPage').then(m => ({ default: m.CleanPage })));
const PicksPage = lazy(() => import('@/pages/PicksPage').then(m => ({ default: m.PicksPage })));
const ArtPage = lazy(() => import('@/pages/ArtPage').then(m => ({ default: m.ArtPage })));
const SpendPage = lazy(() => import('@/pages/SpendPage').then(m => ({ default: m.SpendPage })));
const DocumentsPage = lazy(() => import('@/pages/DocumentsPage').then(m => ({ default: m.DocumentsPage })));
const DocumentReaderPage = lazy(() => import('@/pages/DocumentReaderPage').then(m => ({ default: m.DocumentReaderPage })));
const IntakeReviewPage = lazy(() => import('@/pages/IntakeReviewPage').then(m => ({ default: m.IntakeReviewPage })));

// The charts library is large; the workers page loads it only when it is opened.
const WorkersPage = lazy(() => import('@/pages/WorkersPage').then(m => ({ default: m.WorkersPage })));

export function App() {
  const lang = useLang();
  return (
    <Suspense fallback={<Skeleton className="h-64" />}><Routes key={lang}>
      <Route path="/" element={<Shell />}>
        <Route index element={<OverviewPage />} />
        <Route path="overview/:list" element={<OverviewListPage />} />
      </Route>
      <Route path="/p/:project" element={<Shell />}>
        <Route index element={<ProjectOverviewPage />} />
        <Route path="needs" element={<NeedsPage />} />
        <Route path="producer" element={<ProducerPage />} />
        <Route path="board" element={<BoardPage />} />
        <Route path="orders/:tag" element={<OrderPage />} />
        <Route path="orders/:tag/runs/:runId" element={<RunPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="roles" element={<RolesPage />} />
        <Route path="tools" element={<ToolsPage />} />
        <Route path="machines" element={<MachinesPage />} />
        <Route path="workers" element={<Suspense fallback={<Skeleton className="h-64" />}><WorkersPage /></Suspense>} />
        <Route path="decisions" element={<Suspense fallback={<Skeleton className="h-64" />}><DecisionsPage /></Suspense>} />
        <Route path="design" element={<DesignPage />} />
        <Route path="design/milestones" element={<DesignPage view="milestones" />} />
        <Route path="design/terms" element={<DesignPage view="terms" />} />
        <Route path="design/:system" element={<DesignPage view="system" />} />
        <Route path="skills" element={<Suspense fallback={<Skeleton className="h-64" />}><SkillsPage /></Suspense>} />
        <Route path="lessons" element={<Suspense fallback={<Skeleton className="h-64" />}><LessonsPage /></Suspense>} />
        <Route path="clean" element={<Suspense fallback={<Skeleton className="h-64" />}><CleanPage /></Suspense>} />
        <Route path="tick" element={<TickPage />} />
        <Route path="new" element={<NewOrderPage />} />
        <Route path="picks" element={<Suspense fallback={<Skeleton className="h-64" />}><PicksPage /></Suspense>} />
        <Route path="art" element={<Suspense fallback={<Skeleton className="h-64" />}><ArtPage /></Suspense>} />
        <Route path="spend" element={<Suspense fallback={<Skeleton className="h-64" />}><SpendPage /></Suspense>} />
        <Route path="docs" element={<Suspense fallback={<Skeleton className="h-64" />}><DocumentsPage /></Suspense>} />
        <Route path="docs/read" element={<Suspense fallback={<Skeleton className="h-64" />}><DocumentReaderPage /></Suspense>} />
        <Route path="intake/:tag" element={<Suspense fallback={<Skeleton className="h-64" />}><IntakeReviewPage /></Suspense>} />
      </Route>
      <Route path="/producer" element={<Shell />}><Route index element={<ProducerPage />} /></Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes></Suspense>
  );
}
