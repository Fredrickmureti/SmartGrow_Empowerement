/**
 * Reports App Layout — module-aware.
 *
 * A single layout used by every report page across the platform. It used
 * to always render the global Finance/Accounting `ReportsSubNav` (Trial
 * Balance, GL, Partner Ledger, Aging, …) whenever it was mounted inside
 * another app shell. That caused real cross-module contamination: opening
 * `/hr/payroll/reports`, `/hr/attendance/reports`, `/timesheets/reports`,
 * etc. injected the Finance reports strip on top, and clicking any of
 * those tabs threw the user out of the current module (or into a 404).
 *
 * Behaviour now:
 *  - `/reports/*`         → standalone: full Reports app shell + sub-nav.
 *  - `/finance/reports/*` → embedded in Finance shell: render sub-nav so
 *                           the Finance reports family is reachable.
 *  - Anything else        → render the page inside `ReportContextProvider`
 *                           only. The owning module (Payroll, HR,
 *                           Attendance, Timesheets, Projects, …) already
 *                           provides its own sidebar / topnav; the global
 *                           Finance reports strip MUST NOT appear there.
 *
 * The standalone branch still wraps in `AppWorkspaceLayout` so direct
 * visits to `/reports/*` continue to get the full chrome they expect.
 */

import { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { ReportsSubNav } from "@/components/navigation/ReportsSubNav";
import { useAppLayout } from "@/contexts/AppLayoutContext";
import { REPORTS_APP } from "@/lib/apps/registry";
import { ReportContextProvider } from "@/contexts/ReportContext";
import { REPORTS_NAV } from "./nav";

interface ReportsLayoutProps {
  children: ReactNode;
}

/**
 * Allow-list of parent app paths that legitimately embed the global
 * Finance reports family. Only these paths render the Finance
 * `ReportsSubNav`; every other nested context renders the page bare.
 */
const PARENT_REPORT_PATHS: Record<string, string> = {
  "/finance/reports": "/finance/reports",
};

export function ReportsLayout({ children }: ReportsLayoutProps) {
  const { isInsideAppLayout } = useAppLayout();
  const location = useLocation();

  // Nested inside another app shell (HR, Payroll, Attendance, Finance, …)
  if (isInsideAppLayout) {
    const parentBasePath = Object.keys(PARENT_REPORT_PATHS).find((prefix) =>
      location.pathname.startsWith(prefix),
    );

    if (!parentBasePath) {
      // Module-owned report page. The module supplies its own nav; do
      // NOT inject the global Finance sub-nav here.
      return (
        <ReportContextProvider>
          <div>{children}</div>
        </ReportContextProvider>
      );
    }

    return (
      <ReportContextProvider>
        <div className="-mx-4 sm:-mx-6 lg:-mx-8 -mt-4">
          <ReportsSubNav
            app={REPORTS_APP}
            parentBasePath={PARENT_REPORT_PATHS[parentBasePath]}
          />
          <div className="px-4 sm:px-6 lg:px-8 py-4">{children}</div>
        </div>
      </ReportContextProvider>
    );
  }

  // Standalone visit to `/reports/*` — full PlatformShell with the
  // Reports workspace nav (rail + grouped sidebar, no horizontal tabs).
  return (
    <ReportContextProvider>
      <PlatformShell app={REPORTS_APP} nav={REPORTS_NAV}>
        {children}
      </PlatformShell>
    </ReportContextProvider>
  );
}

export default ReportsLayout;
