/**
 * Lending workspace navigation — drives the PlatformShell sidebar.
 *
 * Scaffold only (C1). Each surface is filled in by its own domain milestone:
 * clients/groups (C3), products (C4), applications (C5), loans (C6),
 * repayments/collections (C7).
 */
import {
  Users,
  Tags,
  ClipboardList,
  HandCoins,
  Wallet,
  Target,
  Settings,
  CalendarDays,
  CalendarClock,
  BarChart3,
  AlertTriangle,
  Landmark,
  FileText,
} from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";

export const LENDING_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Portfolio",
      items: [
        { to: "/lending", label: "Clients", icon: Users, end: true, permission: "viewClients" },
        { to: "/lending/groups", label: "Groups", icon: Users, permission: "viewClients" },
        { to: "/lending/loans", label: "Loans", icon: HandCoins, permission: "viewLoans" },
      ],
    },
    {
      label: "Origination",
      items: [
        { to: "/lending/products", label: "Loan products", icon: Tags, permission: "viewLoanProducts" },
        { to: "/lending/applications", label: "Applications", icon: ClipboardList, permission: "viewApplications" },
      ],
    },
    {
      label: "Servicing",
      items: [
        { to: "/lending/meetings", label: "Meetings", icon: CalendarDays, permission: "viewClients" },
        { to: "/lending/repayments", label: "Repayments", icon: Wallet, permission: "recordRepayments" },
        { to: "/lending/collections", label: "Collections", icon: Target, permission: "viewCollections" },
        { to: "/lending/day", label: "Branch day", icon: CalendarClock, permission: "recordRepayments" },
      ],
    },
    {
      label: "Insights",
      items: [
        { to: "/lending/reports/portfolio", label: "Loan portfolio", icon: BarChart3, permission: "viewLendingReports" },
        { to: "/lending/reports/arrears", label: "Arrears & PAR", icon: AlertTriangle, permission: "viewLendingReports" },
        { to: "/lending/reports/collections", label: "Collections report", icon: Wallet, permission: "viewLendingReports" },
        { to: "/lending/reports/disbursements", label: "Disbursements", icon: Landmark, permission: "viewLendingReports" },
        { to: "/lending/reports/client-statement", label: "Client statement", icon: FileText, permission: "viewLendingReports" },
        { to: "/lending/reports/officer-collections", label: "Officer & branch collections", icon: Wallet, permission: "viewLendingReports" },
        { to: "/lending/reports/par-aging", label: "PAR aging", icon: AlertTriangle, permission: "viewLendingReports" },
        { to: "/lending/reports/product-performance", label: "Product performance", icon: Tags, permission: "viewLendingReports" },
        { to: "/lending/reports/client-exposure", label: "Client exposure", icon: Users, permission: "viewLendingReports" },
      ],
    },
    {
      label: "Configuration",
      items: [
        {
          to: "/lending/configuration/accounting",
          label: "Accounting mappings",
          icon: Settings,
          permission: "manageLendingConfig",
        },
      ],
    },
  ],
};
