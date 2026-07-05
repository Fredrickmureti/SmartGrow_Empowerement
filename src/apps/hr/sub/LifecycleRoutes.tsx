/**
 * Lifecycle Sub-App Routes (Wave A step 1 — real screens).
 *
 * The unified employee-journey spine: candidate → hired → onboarded →
 * probation → transfers → renewals → offboarded → archived.
 * Backed by `employee_lifecycle_events` (migration 1).
 *
 * Every stub has been replaced with a real screen backed by
 * `useLifecycleEvents`. Pipeline pages filter by event_type family and
 * group by employee so operators see the current position of each
 * person, not just a raw log.
 */

import { lazy } from "react";
import { Routes, Route } from "react-router-dom";
import { EMPLOYEES_APP } from "@/lib/apps/registry";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { LIFECYCLE_NAV } from "../shared/navs";
import { LazyRoute } from "../shared/guards";
import { LifecyclePipelinePage } from "@/pages/hr/lifecycle/LifecyclePipelinePage";

const LifecycleOverviewPage = lazy(() => import("@/pages/hr/lifecycle/LifecycleOverviewPage"));
const LifecycleTimelinePage = lazy(() => import("@/pages/hr/lifecycle/LifecycleTimelinePage"));

export default function LifecycleApp() {
  return (
    <PlatformShell app={EMPLOYEES_APP} nav={LIFECYCLE_NAV}>
      <Routes>
        <Route
          index
          element={
            <LazyRoute module="Lifecycle — Overview">
              <LifecycleOverviewPage />
            </LazyRoute>
          }
        />
        <Route
          path="onboarding"
          element={
            <LazyRoute module="Lifecycle — Onboarding">
              <LifecyclePipelinePage
                eyebrow="HR · Lifecycle"
                title="Onboarding queue"
                description="Employees between hire and onboarding completion."
                eventTypes={["hired", "onboarding_started", "onboarding_completed"]}
                emptyLabel="No onboarding activity in the last 90 days."
              />
            </LazyRoute>
          }
        />
        <Route
          path="probation"
          element={
            <LazyRoute module="Lifecycle — Probation">
              <LifecyclePipelinePage
                eyebrow="HR · Lifecycle"
                title="Probation"
                description="Probation started, extended, or ended."
                eventTypes={["probation_started", "probation_ended", "probation_extended"]}
                emptyLabel="No probation events in the last 90 days."
              />
            </LazyRoute>
          }
        />
        <Route
          path="transfers"
          element={
            <LazyRoute module="Lifecycle — Transfers">
              <LifecyclePipelinePage
                eyebrow="HR · Lifecycle"
                title="Transfers in flight"
                description="Department, location, or manager changes — and promotions and demotions."
                eventTypes={["department_transferred", "location_transferred", "manager_changed", "position_changed", "promoted", "demoted"]}
                emptyLabel="No transfer activity in the last 90 days."
              />
            </LazyRoute>
          }
        />
        <Route
          path="renewals"
          element={
            <LazyRoute module="Lifecycle — Renewals">
              <LifecyclePipelinePage
                eyebrow="HR · Lifecycle"
                title="Renewals due"
                description="Contracts renewed, amended, activated, or expired."
                eventTypes={["contract_activated", "contract_renewed", "contract_amended", "contract_expired"]}
                emptyLabel="No contract lifecycle events in the last 90 days."
              />
            </LazyRoute>
          }
        />
        <Route
          path="offboarding"
          element={
            <LazyRoute module="Lifecycle — Offboarding">
              <LifecyclePipelinePage
                eyebrow="HR · Lifecycle"
                title="Offboarding in flight"
                description="Termination through final settlement and archive."
                eventTypes={["termination_initiated", "terminated", "offboarding_started", "offboarding_completed", "final_settlement_paid", "archived"]}
                emptyLabel="No offboarding activity in the last 90 days."
              />
            </LazyRoute>
          }
        />
        <Route
          path="timeline"
          element={
            <LazyRoute module="Lifecycle — Timeline">
              <LifecycleTimelinePage />
            </LazyRoute>
          }
        />
        <Route
          path="archive"
          element={
            <LazyRoute module="Lifecycle — Archive">
              <LifecyclePipelinePage
                eyebrow="HR · Lifecycle"
                title="Archive"
                description="Archived employees, retained with their full lifecycle history."
                eventTypes={["archived", "unarchived"]}
                sinceDays={365}
                emptyLabel="No archived employees in the last 12 months."
              />
            </LazyRoute>
          }
        />
      </Routes>
    </PlatformShell>
  );
}
