/**
 * Warehouse (WMS) workspace navigation.
 *
 * WMS is the operational execution layer *above* Inventory. Inventory owns
 * quantities and cost; WMS owns physical location, operator, task, dock,
 * appointment, wave, pick, pack, load. See ADR 0079.
 *
 * The Warehouse app is mounted at `/warehouse-app/*` in src/App.tsx.
 * Every `to:` must be prefixed with `/warehouse-app/`.
 *
 * RULE: only wire nav entries for pages that are BUILT and functional. When
 * a phase ships (receiving, putaway, picking, packing, dispatch, QC,
 * operators), append its entry here — never point at a placeholder.
 */
import { LayoutGrid, Warehouse, Network, PackageOpen, ListChecks, Truck, Waves, ClipboardCheck, Send, CalendarClock, ShieldCheck, Repeat, Gauge } from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";

export const WAREHOUSE_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/warehouse-app/dashboard", label: "Overview", icon: LayoutGrid, end: true },
        { to: "/warehouse-app/tasks", label: "Operator tasks", icon: ListChecks },
        { to: "/warehouse-app/putaway", label: "Putaway", icon: Truck },
        { to: "/warehouse-app/waves", label: "Wave planner", icon: Waves },
        { to: "/warehouse-app/replenishment", label: "Replenishment", icon: Repeat },
        { to: "/warehouse-app/counts", label: "Cycle counts", icon: ClipboardCheck },
        { to: "/warehouse-app/dispatch", label: "Dispatch", icon: Send },
        { to: "/warehouse-app/schedule", label: "Dock schedule", icon: CalendarClock },
        { to: "/warehouse-app/qc", label: "Quality control", icon: ShieldCheck },
        { to: "/warehouse-app/slotting", label: "Slotting", icon: Gauge },
      ],
    },
    {
      label: "Master",
      items: [
        { to: "/warehouse-app/warehouses", label: "Warehouses", icon: Warehouse },
        { to: "/warehouse-app/layout", label: "Layout (zones / bins)", icon: Network },
        { to: "/warehouse-app/plates", label: "License plates", icon: PackageOpen },
      ],
    },
  ],
};
