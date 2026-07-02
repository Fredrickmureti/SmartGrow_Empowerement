/**
 * Projects App Routes
 */

import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";
import { SubscriptionProtectedRoute } from "@/components/subscription/SubscriptionProtectedRoute";
import { OnlineOnlyRoute } from "@/components/electron/OnlineOnlyRoute";
import { ProjectsLayout } from "./ProjectsLayout";

const Projects = lazy(() => import("@/pages/projects/Projects"));
const ProjectsPortfolio = lazy(() => import("@/pages/projects/portfolio/Portfolio"));
const MyTasks = lazy(() => import("@/pages/projects/portfolio/MyTasks"));
const AllTasks = lazy(() => import("@/pages/projects/portfolio/AllTasks"));
const AllMilestones = lazy(() => import("@/pages/projects/portfolio/AllMilestones"));
const AllProjectDocuments = lazy(() => import("@/pages/projects/portfolio/AllDocuments"));
const ProjectReports = lazy(() => import("@/pages/projects/portfolio/Reports"));
const Workload = lazy(() => import("@/pages/projects/portfolio/Workload"));
const ProjectsConfiguration = lazy(() => import("@/pages/projects/portfolio/Configuration"));
const ProjectDetailLayout = lazy(() => import("@/pages/projects/detail/ProjectDetailLayout"));
const OverviewTab = lazy(() => import("@/pages/projects/detail/Overview"));
const TasksTab = lazy(() => import("@/pages/projects/detail/Tasks"));
const MilestonesTab = lazy(() => import("@/pages/projects/detail/Milestones"));
const TimesheetsTab = lazy(() => import("@/pages/projects/detail/Timesheets"));
const SalesTab = lazy(() => import("@/pages/projects/detail/Sales"));
const PurchasesTab = lazy(() => import("@/pages/projects/detail/Purchases"));
const FinancialsTab = lazy(() => import("@/pages/projects/detail/Financials"));
const DocumentsTab = lazy(() => import("@/pages/projects/detail/Documents"));
const UpdatesTab = lazy(() => import("@/pages/projects/detail/Updates"));
const ActivityTab = lazy(() => import("@/pages/projects/detail/Activity"));
const SettingsTab = lazy(() => import("@/pages/projects/detail/Settings"));

const LazyRoute = ({ children, module }: { children: React.ReactNode; module?: string }) => (
  <Suspense fallback={<RouteLoadingFallback module={module} />}>{children}</Suspense>
);

export function ProjectsApp() {
  return (
    <ProjectsLayout>
      <Routes>
        <Route index element={<Navigate to="overview" replace />} />

        <Route path="overview"      element={<LazyRoute module="Projects Overview"><ProjectsPortfolio /></LazyRoute>} />
        <Route path="my-tasks"      element={<LazyRoute module="My Tasks"><MyTasks /></LazyRoute>} />
        <Route path="tasks"         element={<LazyRoute module="All Tasks"><AllTasks /></LazyRoute>} />
        <Route path="milestones"    element={<LazyRoute module="Milestones"><AllMilestones /></LazyRoute>} />
        <Route path="documents"     element={<LazyRoute module="Documents"><AllProjectDocuments /></LazyRoute>} />
        <Route path="workload"      element={<LazyRoute module="Workload"><Workload /></LazyRoute>} />
        <Route path="reports"       element={<LazyRoute module="Reports"><ProjectReports /></LazyRoute>} />
        <Route path="configuration" element={<LazyRoute module="Configuration"><ProjectsConfiguration /></LazyRoute>} />

        <Route path="list" element={
          <OnlineOnlyRoute moduleName="Projects">
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Projects"><Projects /></LazyRoute>
            </SubscriptionProtectedRoute>
          </OnlineOnlyRoute>
        } />

        {/* Project workspace with nested tab routes */}
        <Route path=":projectId" element={
          <OnlineOnlyRoute moduleName="Projects">
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Project Workspace"><ProjectDetailLayout /></LazyRoute>
            </SubscriptionProtectedRoute>
          </OnlineOnlyRoute>
        }>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview"    element={<LazyRoute><OverviewTab /></LazyRoute>} />
          <Route path="tasks"       element={<LazyRoute><TasksTab /></LazyRoute>} />
          <Route path="milestones"  element={<LazyRoute><MilestonesTab /></LazyRoute>} />
          <Route path="timesheets"  element={<LazyRoute><TimesheetsTab /></LazyRoute>} />
          <Route path="sales"       element={<LazyRoute><SalesTab /></LazyRoute>} />
          <Route path="purchases"   element={<LazyRoute><PurchasesTab /></LazyRoute>} />
          <Route path="financials"  element={<LazyRoute><FinancialsTab /></LazyRoute>} />
          <Route path="documents"   element={<LazyRoute><DocumentsTab /></LazyRoute>} />
          <Route path="updates"     element={<LazyRoute><UpdatesTab /></LazyRoute>} />
          <Route path="activity"    element={<LazyRoute><ActivityTab /></LazyRoute>} />
          <Route path="settings"    element={<LazyRoute><SettingsTab /></LazyRoute>} />
        </Route>

        <Route path="timesheets" element={<Navigate to="/timesheets" replace />} />
        <Route path="*" element={<Navigate to="list" replace />} />
      </Routes>
    </ProjectsLayout>
  );
}

export default ProjectsApp;
