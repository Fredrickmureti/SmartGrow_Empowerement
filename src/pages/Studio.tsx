import { StudioLayout } from "@/apps/studio/StudioLayout";
import { Routes, Route, Navigate } from "react-router-dom";
import { Suspense, lazy } from "react";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";

const StudioFields = lazy(() => import("@/pages/studio/StudioFields"));
const StudioForms = lazy(() => import("@/pages/studio/StudioForms"));
const StudioAutomations = lazy(() => import("@/pages/studio/StudioAutomations"));
const StudioViews = lazy(() => import("@/pages/studio/StudioViews"));
const StudioScheduling = lazy(() => import("@/pages/studio/StudioScheduling"));
const StudioApprovals = lazy(() => import("@/pages/studio/StudioApprovals"));
const StudioReports = lazy(() => import("@/pages/studio/StudioReports"));

export default function Studio() {
  return (
    <StudioLayout>
      <Suspense fallback={<RouteLoadingFallback module="Studio" />}>
        <Routes>
          <Route index element={<Navigate to="/studio/fields" replace />} />
          <Route path="fields" element={<StudioFields />} />
          <Route path="fields/:entityType" element={<StudioFields />} />
          <Route path="forms" element={<StudioForms />} />
          <Route path="automations" element={<StudioAutomations />} />
          <Route path="views" element={<StudioViews />} />
          <Route path="scheduling" element={<StudioScheduling />} />
          <Route path="approvals" element={<StudioApprovals />} />
          <Route path="reports" element={<StudioReports />} />
          <Route path="*" element={<Navigate to="/studio/fields" replace />} />
        </Routes>
      </Suspense>
    </StudioLayout>
  );
}
