/**
 * Contracts Sub-App Routes (Wave 1 — new).
 *
 * First-class workspace for the employee_contracts lifecycle:
 * Drafts → Pending approval → Active → Expiring → Renewals → Amendments.
 *
 * Schema-side this is already supported (migration 3 added the
 * `contract_amendments` table and the `renew_contract` / `amend_contract`
 * RPCs). Per-surface UIs land in subsequent turns.
 */

import { lazy } from "react";
import { Routes, Route } from "react-router-dom";
import { CONTRACTS_APP } from "@/lib/apps/registry";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { CONTRACTS_NAV } from "../shared/navs";
import { LazyRoute } from "../shared/guards";

const WorkspaceComingSoon = lazy(() => import("@/pages/hr/WorkspaceComingSoon"));
const ContractsOverview = lazy(() => import("@/pages/hr/contracts/ContractsOverview"));

function ContractsStub({ surface, description }: { surface: string; description: string }) {
  return (
    <LazyRoute module={`Contracts — ${surface}`}>
      <WorkspaceComingSoon title={`Contracts · ${surface}`} description={description} />
    </LazyRoute>
  );
}

export default function ContractsApp() {
  return (
    <PlatformShell app={CONTRACTS_APP} nav={CONTRACTS_NAV}>
      <Routes>
        <Route
          index
          element={
            <LazyRoute module="Contracts — Overview">
              <ContractsOverview />
            </LazyRoute>
          }
        />
        <Route path="all" element={<ContractsStub surface="All" description="Browse every contract across drafts, active, and expired states." />} />

        <Route path="drafts" element={<ContractsStub surface="Drafts" description="Contracts not yet sent for approval." />} />
        <Route path="pending" element={<ContractsStub surface="Pending approval" description="Contracts awaiting reviewer sign-off." />} />
        <Route path="active" element={<ContractsStub surface="Active" description="Currently in-force contracts." />} />
        <Route path="expiring" element={<ContractsStub surface="Expiring" description="Contracts expiring in the next 30, 60, and 90 days." />} />
        <Route path="renewals" element={<ContractsStub surface="Renewals" description="Issue contract renewals and track their lifecycle." />} />
        <Route path="amendments" element={<ContractsStub surface="Amendments" description="Record contract amendments with a permanent history trail." />} />
        <Route path="templates" element={<ContractsStub surface="Templates" description="Reusable contract templates for faster drafting." />} />
        <Route path="audit" element={<ContractsStub surface="Audit" description="Filterable amendment timeline by contract, employee, or actor." />} />
      </Routes>
    </PlatformShell>
  );
}