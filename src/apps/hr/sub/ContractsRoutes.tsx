/**
 * Contracts Sub-App Routes (Wave A step 2 — real screens).
 *
 * First-class workspace for the employee_contracts lifecycle:
 * Drafts → Pending approval → Active → Expiring (30/60/90) →
 * Renewals → Amendments → Templates → Audit.
 *
 * Reads live through `useContracts` / `useContractAmendments`; writes reuse
 * the existing `renew_contract` / `amend_contract` RPCs. No schema movement.
 */

import { lazy } from "react";
import { Routes, Route } from "react-router-dom";
import { EMPLOYEES_APP } from "@/lib/apps/registry";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { EMPLOYEES_NAV } from "../shared/navs";
import { LazyRoute } from "../shared/guards";
import { ContractsListPage } from "@/pages/hr/contracts/ContractsListPage";
import { ContractsAmendmentsPage } from "@/pages/hr/contracts/ContractsAmendmentsPage";

const ContractsOverview = lazy(() => import("@/pages/hr/contracts/ContractsOverview"));
const ContractsTemplatesPage = lazy(() => import("@/pages/hr/contracts/ContractsTemplatesPage"));

export default function ContractsApp() {
  return (
    <PlatformShell app={EMPLOYEES_APP} nav={EMPLOYEES_NAV}>
      <Routes>
        <Route
          index
          element={
            <LazyRoute module="Contracts — Overview">
              <ContractsOverview />
            </LazyRoute>
          }
        />
        <Route
          path="all"
          element={
            <LazyRoute module="Contracts — All">
              <ContractsListPage
                eyebrow="HR · Contracts"
                title="All contracts"
                description="Every contract across drafts, active, and expired states."
                allowRenew
                emptyLabel="No contracts recorded yet."
              />
            </LazyRoute>
          }
        />
        <Route
          path="drafts"
          element={
            <LazyRoute module="Contracts — Drafts">
              <ContractsListPage
                eyebrow="HR · Contracts"
                title="Drafts"
                description="Contracts not yet sent for approval."
                status="draft"
                emptyLabel="No draft contracts."
              />
            </LazyRoute>
          }
        />
        <Route
          path="pending"
          element={
            <LazyRoute module="Contracts — Pending">
              <ContractsListPage
                eyebrow="HR · Contracts"
                title="Pending approval"
                description="Contracts submitted for reviewer sign-off."
                status="pending_approval"
                emptyLabel="No contracts awaiting approval."
              />
            </LazyRoute>
          }
        />
        <Route
          path="active"
          element={
            <LazyRoute module="Contracts — Active">
              <ContractsListPage
                eyebrow="HR · Contracts"
                title="Active"
                description="Currently in-force contracts."
                status="running"
                allowRenew
                emptyLabel="No active contracts."
              />
            </LazyRoute>
          }
        />
        <Route
          path="expiring"
          element={
            <LazyRoute module="Contracts — Expiring">
              <ContractsListPage
                eyebrow="HR · Contracts"
                title="Expiring soon"
                description="Active contracts ending in the next 90 days — bucketed 0–30 / 31–60 / 61–90."
                status="running"
                expiringWithinDays={90}
                showBuckets
                allowRenew
                emptyLabel="No contracts expiring in the next 90 days."
              />
            </LazyRoute>
          }
        />
        <Route
          path="expired"
          element={
            <LazyRoute module="Contracts — Expired">
              <ContractsListPage
                eyebrow="HR · Contracts"
                title="Expired"
                description="Contracts whose end date has passed and have not been renewed."
                onlyExpired
                allowRenew
                emptyLabel="No expired contracts."
              />
            </LazyRoute>
          }
        />
        <Route
          path="renewals"
          element={
            <LazyRoute module="Contracts — Renewals">
              <ContractsAmendmentsPage
                eyebrow="HR · Contracts"
                title="Renewals"
                description="Contracts renewed through the renew_contract workflow."
                kinds={["renewal"]}
                emptyLabel="No renewals recorded in the last 12 months."
              />
            </LazyRoute>
          }
        />
        <Route
          path="amendments"
          element={
            <LazyRoute module="Contracts — Amendments">
              <ContractsAmendmentsPage
                eyebrow="HR · Contracts"
                title="Amendments"
                description="Contract amendments across renewal, salary revision, position/location/schedule changes, and end-date changes."
                showKindFilter
                emptyLabel="No amendments recorded in the last 12 months."
              />
            </LazyRoute>
          }
        />
        <Route
          path="templates"
          element={
            <LazyRoute module="Contracts — Templates">
              <ContractsTemplatesPage />
            </LazyRoute>
          }
        />
        <Route
          path="audit"
          element={
            <LazyRoute module="Contracts — Audit">
              <ContractsAmendmentsPage
                eyebrow="HR · Contracts"
                title="Amendment audit"
                description="Full, filterable audit trail of every contract amendment across the business."
                showKindFilter
                sinceDays={1825}
                emptyLabel="No amendments recorded."
              />
            </LazyRoute>
          }
        />
      </Routes>
    </PlatformShell>
  );
}
