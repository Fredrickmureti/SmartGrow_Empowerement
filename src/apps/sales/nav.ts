/**
 * Sales workspace navigation — drives the PlatformShell sidebar.
 *
 * Grouped Operations / Insights / Setup. Operations is everything an
 * AR clerk touches daily; Insights is read-heavy/analytical; Setup is
 * reserved for future Sales-specific configuration.
 */
import {
  LayoutGrid,
  FileText,
  Repeat,
  ClipboardList,
  FileEdit,
  ShoppingBag,
  Truck,
  Wallet,
  ScrollText,
  RotateCcw,
  FileMinus,
  Users,
  HandCoins,
  TrendingUp,
} from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";

export const SALES_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/sales/dashboard", label: "Overview", icon: LayoutGrid, end: true },
        { to: "/sales/customers", label: "Customers", icon: Users },
        { to: "/sales/invoices", label: "Invoices", icon: FileText },
        { to: "/sales/recurring", label: "Recurring", icon: Repeat },
        { to: "/sales/estimates", label: "Estimates", icon: ClipboardList },
        { to: "/sales/proforma", label: "Proforma", icon: FileEdit },
        { to: "/sales/orders", label: "Sales orders", icon: ShoppingBag },
        { to: "/sales/delivery-notes", label: "Delivery notes", icon: Truck },
        { to: "/sales/payments", label: "Payments", icon: Wallet },
        { to: "/sales/statements", label: "Statements", icon: ScrollText },
        { to: "/sales/returns", label: "Returns", icon: RotateCcw },
        { to: "/sales/credit-notes", label: "Credit notes", icon: FileMinus },
        { to: "/sales/ledger", label: "Customer ledger", icon: BookOpen },
        { to: "/sales/collections", label: "Collections", icon: HandCoins },
      ],
    },
    {
      label: "Insights",
      items: [
        { to: "/sales/salesperson", label: "Salesperson performance", icon: TrendingUp },
      ],
    },
  ],
};
