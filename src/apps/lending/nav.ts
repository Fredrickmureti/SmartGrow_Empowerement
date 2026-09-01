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
} from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";

export const LENDING_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Portfolio",
      items: [
        { to: "/lending", label: "Clients", icon: Users, end: true },
        { to: "/lending/groups", label: "Groups", icon: Users },
        { to: "/lending/loans", label: "Loans", icon: HandCoins },
      ],
    },
    {
      label: "Origination",
      items: [
        { to: "/lending/products", label: "Loan products", icon: Tags },
        { to: "/lending/applications", label: "Applications", icon: ClipboardList },
      ],
    },
    {
      label: "Servicing",
      items: [
        { to: "/lending/repayments", label: "Repayments", icon: Wallet },
        { to: "/lending/collections", label: "Collections", icon: Target },
      ],
    },
    {
      label: "Configuration",
      items: [
        {
          to: "/lending/configuration/accounting",
          label: "Accounting mappings",
          icon: Settings,
        },
      ],
    },
  ],
};
