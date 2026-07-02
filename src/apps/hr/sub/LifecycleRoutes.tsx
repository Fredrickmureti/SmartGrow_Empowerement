/**
 * Lifecycle Sub-App Routes (Wave 1 — new).
 *
 * The unified employee-journey spine: candidate → hired → onboarded →
 * probation → transfers → renewals → offboarded → archived.
 * Backed by `employee_lifecycle_events` (migration 1).
 */

import { lazy } from "react";
import { Routes, Route } from "react-router-dom";
import { EMPLOYEES_APP } from "@/lib/apps/registry";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { LIFECYCLE_NAV } from "../shared/navs";
import { LazyRoute } from "../shared/guards";

const WorkspaceComingSoon = lazy(() => import("@/pages/hr/WorkspaceComingSoon"));

function LifecycleStub({ surface, description }: { surface: string; description: string }) {
  return (
    <LazyRoute module={`Lifecycle — ${surface}`}>
      <WorkspaceComingSoon title={`Lifecycle · ${surface}`} description={description} />
    </LazyRoute>
  );
}

export default function LifecycleApp() {
  return (
    <PlatformShell app={EMPLOYEES_APP} nav={LIFECYCLE_NAV}>
      <Routes>
        <Route index element={<LifecycleStub surface="Overview" description="Cross-pipeline summary: counts per stage, SLA breaches, owner queues." />} />
        <Route path="onboarding" element={<LifecycleStub surface="Onboarding queue" description="Filters employee_lifecycle_events by onboarding_started / onboarding_completed." />} />
        <Route path="probation" element={<LifecycleStub surface="Probation ending" description="Employees with probation_started events and computed end-of-probation dates." />} />
        <Route path="transfers" element={<LifecycleStub surface="Transfers in flight" description="department_transferred / location_transferred / manager_changed pipelines." />} />
        <Route path="renewals" element={<LifecycleStub surface="Renewals due" description="Cross-pipeline view onto the contract expiry pipeline + renewals workflow." />} />
        <Route path="offboarding" element={<LifecycleStub surface="Offboarding in flight" description="termination_initiated → exit clearance → final_settlement_paid → archived." />} />
        <Route path="timeline" element={<LifecycleStub surface="All events" description="Cross-employee event log with filter by event_type and actor." />} />
        <Route path="archive" element={<LifecycleStub surface="Archive" description="Archived employees with full lifecycle history retained." />} />
      </Routes>
    </PlatformShell>
  );
}