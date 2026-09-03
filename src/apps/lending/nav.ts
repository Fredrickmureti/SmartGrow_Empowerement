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
        { to: "/lending/repayments", label: "Repayments", icon: Wallet, permission: "recordRepayments" },
        { to: "/lending/collections", label: "Collections", icon: Target, permission: "viewCollections" },
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
