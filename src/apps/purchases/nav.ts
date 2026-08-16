/**
 * Purchases workspace navigation — drives the PlatformShell sidebar.
 */
import {
  LayoutGrid,
  Receipt,
  FileQuestion,
  ShoppingCart,
  Wallet,
  RotateCcw,
  FileMinus,
  Truck,
  ScrollText,
  Hourglass,
  Scale,
  Tags,
  Layers,
  Building2,
  FileSignature,
  ClipboardList,
} from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";

export const PURCHASES_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/purchases", label: "Overview", icon: LayoutGrid, end: true },
        { to: "/purchases/bills", label: "Bills", icon: Receipt },
        { to: "/purchases/rfqs", label: "RFQs", icon: FileQuestion },
        { to: "/purchases/requisitions", label: "Requisitions", icon: ClipboardList },
        { to: "/purchases/orders", label: "Purchase orders", icon: ShoppingCart },
        { to: "/purchases/expenses", label: "Expenses", icon: Wallet },
        { to: "/purchases/returns", label: "Returns", icon: RotateCcw },
        { to: "/purchases/credit-notes", label: "Credit notes", icon: FileMinus },
        { to: "/purchases/suppliers", label: "Suppliers", icon: Building2 },
        { to: "/purchases/contracts", label: "Contracts", icon: FileSignature },
        // Legacy "Suppliers (contact view)" retired in Batch K-Retire (2026-07).
        //   Route /purchases/vendors now redirects to /purchases/suppliers.

        { to: "/purchases/statements", label: "Statements", icon: ScrollText },
      ],
    },
    {
      label: "Insights",
      items: [
        { to: "/purchases/aged-payables", label: "Aged payables", icon: Hourglass },
        { to: "/purchases/ap-reconciliation", label: "AP reconciliation", icon: Scale },
        { to: "/purchases/landed-costs", label: "Landed costs", icon: Layers },
      ],
    },
    {
      label: "Setup",
      items: [
        { to: "/purchases/price-lists", label: "Supplier conditions", icon: Tags },
      ],
    },
  ],
};
