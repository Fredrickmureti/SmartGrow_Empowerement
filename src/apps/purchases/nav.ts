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
  Tags,
  Layers,
  Building2,
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
        { to: "/purchases/orders", label: "Purchase orders", icon: ShoppingCart },
        { to: "/purchases/expenses", label: "Expenses", icon: Wallet },
        { to: "/purchases/returns", label: "Returns", icon: RotateCcw },
        { to: "/purchases/credit-notes", label: "Credit notes", icon: FileMinus },
        { to: "/purchases/vendors", label: "Vendors", icon: Truck },
        { to: "/purchases/statements", label: "Statements", icon: ScrollText },
      ],
    },
    {
      label: "Insights",
      items: [
        { to: "/purchases/aged-payables", label: "Aged payables", icon: Hourglass },
        { to: "/purchases/landed-costs", label: "Landed costs", icon: Layers },
      ],
    },
    {
      label: "Setup",
      items: [
        { to: "/purchases/price-lists", label: "Price lists", icon: Tags },
      ],
    },
  ],
};
