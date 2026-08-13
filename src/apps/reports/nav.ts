/**
 * Reports workspace navigation — drives the PlatformShell sidebar for
 * standalone `/reports/*` visits. When the same Report pages are
 * embedded inside another app shell (e.g. /finance/reports/*), the
 * owning app supplies its own nav and this one is not used.
 */
import { BarChart3 } from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";
import { buildReportsNavChildren } from "@/services/reports/reportsNav";

/**
 * Standalone `/reports/*` sidebar. Same registry-driven families as the
 * Finance shell — there is exactly one list of reports in the codebase
 * (`REPORT_REGISTRY`), so the two navs can no longer drift.
 */
export const REPORTS_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [{ to: "/reports", label: "All reports", icon: BarChart3, end: true }],
    },
    {
      label: "Report families",
      items: buildReportsNavChildren(),
    },
  ],
};
