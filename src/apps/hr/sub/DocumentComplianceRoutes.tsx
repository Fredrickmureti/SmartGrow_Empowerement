/**
 * Document Compliance Sub-App Routes.
 *
 * HR-ops surface over `employee_documents` — the drill-through for the
 * "Documents expiring (90d)" inbox row and the daily compliance queue for
 * ID cards, work permits, medicals, contracts of employment, etc.
 *
 * Tabs: Expiring / Expired / Unverified / All. Reads live through
 * `useEmployeeDocuments`; verification writes happen on the employee profile.
 */

import { Routes, Route, Navigate } from "react-router-dom";
import { EMPLOYEES_APP } from "@/lib/apps/registry";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { DOCUMENT_COMPLIANCE_NAV } from "../shared/navs";
import { LazyRoute } from "../shared/guards";
import { DocumentsListPage } from "@/pages/hr/documents/DocumentsListPage";

export default function DocumentComplianceApp() {
  return (
    <PlatformShell app={EMPLOYEES_APP} nav={DOCUMENT_COMPLIANCE_NAV}>
      <Routes>
        <Route index element={<Navigate to="expiring" replace />} />
        <Route
          path="expiring"
          element={
            <LazyRoute module="Documents — Expiring">
              <DocumentsListPage
                eyebrow="HR · Document compliance"
                title="Expiring soon"
                description="Employee documents whose expiry date falls in the next 90 days — bucketed 0–30 / 31–60 / 61–90."
                expiringWithinDays={90}
                emptyLabel="No documents expiring in the next 90 days."
              />
            </LazyRoute>
          }
        />
        <Route
          path="expired"
          element={
            <LazyRoute module="Documents — Expired">
              <DocumentsListPage
                eyebrow="HR · Document compliance"
                title="Expired"
                description="Employee documents whose expiry date has already passed — statutory risk if not renewed."
                onlyExpired
                emptyLabel="No expired documents."
              />
            </LazyRoute>
          }
        />
        <Route
          path="unverified"
          element={
            <LazyRoute module="Documents — Unverified">
              <DocumentsListPage
                eyebrow="HR · Document compliance"
                title="Unverified"
                description="Documents uploaded but not yet verified by HR. Verification happens on the employee profile."
                onlyUnverified
                emptyLabel="All documents verified."
              />
            </LazyRoute>
          }
        />
        <Route
          path="all"
          element={
            <LazyRoute module="Documents — All">
              <DocumentsListPage
                eyebrow="HR · Document compliance"
                title="All documents"
                description="Every employee document across expiring, expired, current, and open-ended states."
                emptyLabel="No documents recorded yet."
              />
            </LazyRoute>
          }
        />
      </Routes>
    </PlatformShell>
  );
}
