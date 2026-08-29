/**
 * HR-Domain Dispatcher (URL space `/hr/*`)
 *
 * Scope for the microfinance platform: the HR domain is deliberately
 * reduced to the **Employees** foundation only — the staff directory,
 * departments, job positions, work locations, the org chart and HR
 * configuration. These records back authentication, role assignment,
 * branch posting and loan-officer attribution.
 *
 * Payroll, Time Off, Attendance, Timesheets, Talent, Recruitment,
 * Contracts, Lifecycle, HR Reports and Document Compliance are NOT part
 * of the scoped product and have been removed. Employee attributes that
 * such modules would need are retained on the employee record so the
 * institution can scale into them later without a data migration.
 */

import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";
import { HRCatchAllRedirect } from "./shared/guards";
import { AppInstalledGate } from "@/components/apps/AppInstalledGate";

const EmployeesApp = lazy(() => import("./sub/EmployeesRoutes"));

function SubAppFallback({ module }: { module: string }) {
  return <RouteLoadingFallback module={module} />;
}

export function HRApp() {
  return (
    <Suspense fallback={<SubAppFallback module="HR" />}>
      <Routes>
        {/* Employees foundation — catch-all */}
        <Route
          path="*"
          element={
            <AppInstalledGate appId="employees">
              <EmployeesApp />
            </AppInstalledGate>
          }
        />

        <Route path="hr-fallback" element={<HRCatchAllRedirect />} />
      </Routes>
    </Suspense>
  );
}

export default HRApp;
