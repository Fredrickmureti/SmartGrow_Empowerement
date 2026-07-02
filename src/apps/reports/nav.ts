/**
 * Reports workspace navigation — drives the PlatformShell sidebar for
 * standalone `/reports/*` visits. When the same Report pages are
 * embedded inside another app shell (e.g. /finance/reports/*), the
 * owning app supplies its own nav and this one is not used.
 */
import {
  BarChart3,
  PiggyBank,
  Calculator,
  BookOpen,
  FileText,
  Clock,
  Target,
  Building2,
  Wallet,
  History,
  Receipt,
  Package,
} from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";

export const REPORTS_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [{ to: "/reports", label: "All reports", icon: BarChart3, end: true }],
    },
    {
      label: "Financial",
      items: [
        { to: "/reports/financial", label: "Financial statements", icon: PiggyBank },
        { to: "/reports/trial-balance", label: "Trial balance", icon: Calculator },
        { to: "/reports/general-ledger", label: "General ledger", icon: BookOpen },
        { to: "/reports/partner-ledger", label: "Partner ledger", icon: FileText },
        { to: "/reports/journal-report", label: "Journal report", icon: BookOpen },
        { to: "/reports/aging", label: "Aging", icon: Clock },
        { to: "/reports/budget", label: "Budget vs actual", icon: Target },
        { to: "/reports/depreciation", label: "Depreciation", icon: Building2 },
        { to: "/reports/cash-flow", label: "Cash flow", icon: Wallet },
        { to: "/reports/audit-trail", label: "Audit trail", icon: History },
      ],
    },
    {
      label: "Operational",
      items: [
        { to: "/reports/sales", label: "Sales", icon: FileText },
        { to: "/reports/management", label: "Management", icon: BarChart3 },
        { to: "/reports/tax", label: "Tax", icon: Receipt },
        { to: "/reports/stock", label: "Stock", icon: Package },
        { to: "/reports/intelligence", label: "Business intelligence", icon: BarChart3 },
      ],
    },
  ],
};
