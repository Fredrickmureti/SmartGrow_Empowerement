/**
 * Inventory workspace navigation — drives the PlatformShell sidebar.
 *
 * IMPORTANT: the Inventory app is mounted at `/inventory-app/*` in
 * src/App.tsx (not `/inventory`). Every `to:` below MUST be prefixed with
 * `/inventory-app/` or the link 404s. If the mount path is ever changed,
 * update both sides together.
 */
import {
  LayoutGrid,
  Package,
  Boxes,
  ArrowLeftRight,
  RefreshCw,
  TrendingUp,
  Trash2,
  ClipboardCheck,
  ClipboardList,
  BarChart3,
  Coins,
  Hourglass,
  Warehouse,
  Scale,
  CalendarClock,
  Truck,
} from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";

export const INVENTORY_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/inventory-app/dashboard", label: "Overview", icon: LayoutGrid, end: true },
        { to: "/inventory-app/products", label: "Products", icon: Package },
        { to: "/inventory-app/stock", label: "Stock", icon: Boxes },
        { to: "/inventory-app/transfers", label: "Transfers", icon: ArrowLeftRight },
        { to: "/inventory-app/replenishment", label: "Replenishment", icon: RefreshCw },
        { to: "/inventory-app/forecast", label: "Forecast", icon: TrendingUp },
        { to: "/inventory-app/scrap", label: "Scrap", icon: Trash2 },
        { to: "/inventory-app/physical-counts", label: "Counts", icon: ClipboardList },
        { to: "/inventory-app/count", label: "New count", icon: ClipboardCheck },
        { to: "/inventory-app/cycle-schedules", label: "Cycle schedules", icon: CalendarClock },
      ],
    },
    {
      label: "Insights",
      items: [
        { to: "/inventory-app/reports", label: "Stock reports", icon: BarChart3, end: true },
        { to: "/inventory-app/reports/valuation", label: "Valuation", icon: Coins },
        { to: "/inventory-app/reports/aging", label: "Aging", icon: Hourglass },
      ],
    },
    {
      label: "Setup",
      items: [
        { to: "/inventory-app/warehouses", label: "Warehouses", icon: Warehouse },
        { to: "/inventory-app/uom", label: "Units of measure", icon: Scale },
      ],
    },
  ],
};
