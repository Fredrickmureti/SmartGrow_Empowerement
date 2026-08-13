/**
 * Finance workspace navigation — drives the PlatformShell sidebar.
 *
 * Operations = day-to-day clerk workflow (AR/AP, JEs, banking).
 * Insights   = the report center and statutory/management reports.
 * Setup      = chart of accounts, periods, budgets, assets, settings.
 */
import {
  LayoutGrid,
  Receipt,
  FileText,
  Coins,
  ScrollText,
  BookOpen,
  Landmark,
  GitCompare,
  Rss,
  BarChart3,
  ShieldCheck,
  Calculator,
  Hourglass,
  TrendingUp,
  PieChart,
  FileBox,
  History,
  RefreshCw,
  Wallet,
  Building,
  CalendarCheck,
  Target,
  Tags,
  Briefcase,
  Settings,
  Inbox,
} from "lucide-react";

import type { WorkspaceNav } from "@/components/layout/shell/types";
import { buildReportsNavChildren } from "@/services/reports/reportsNav";

export const FINANCE_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/finance/dashboard", label: "Overview", icon: LayoutGrid, end: true },
        { to: "/finance/receivables", label: "Receivables", icon: Receipt },
        { to: "/finance/payables", label: "Payables", icon: FileText },
        { to: "/finance/customer-credits", label: "Customer credits", icon: Coins },
        { to: "/finance/vendor-credits", label: "Vendor credits", icon: Coins },
        { to: "/finance/statements", label: "Statements", icon: ScrollText },
        { to: "/finance/journal-entries", label: "Journal entries", icon: BookOpen },
        { to: "/finance/banking", label: "Banking", icon: Landmark },
        { to: "/finance/reconciliation", label: "Reconciliation", icon: GitCompare },
        { to: "/finance/bank-feeds", label: "Bank feeds", icon: Rss },
        { to: "/finance/operations/accounting-events", label: "Accounting events", icon: Inbox },
      ],
    },

    {
      label: "Insights",
      items: [
        {
          to: "/finance/reports",
          label: "Reports",
          icon: BarChart3,
          end: true,
          // Registry-driven, grouped by accounting family. Never hand-list
          // report links here — add a row to REPORT_REGISTRY instead.
          children: [
            { to: "/finance/reports", label: "All reports", icon: LayoutGrid, end: true },
            ...buildReportsNavChildren(),
          ],
        },
        { to: "/finance/reversal-register", label: "Reversal register", icon: History },
        { to: "/finance/integrity", label: "Integrity", icon: ShieldCheck },
      ],
    },
    {
      label: "Setup",
      items: [
        { to: "/finance/accounts", label: "Chart of accounts", icon: BookOpen },
        { to: "/finance/fiscal-periods", label: "Fiscal periods", icon: CalendarCheck },
        { to: "/finance/budgets", label: "Budgets", icon: Target },
        { to: "/finance/analytic-accounts", label: "Analytic accounts", icon: Tags },
        { to: "/finance/fixed-assets", label: "Fixed assets", icon: Briefcase },
        { to: "/finance/settings", label: "Settings", icon: Settings },
      ],
    },
  ],
};
