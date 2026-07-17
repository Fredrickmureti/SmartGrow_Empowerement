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
import { LayoutGrid, Warehouse, Network, PackageOpen, ListChecks } from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";

export const WAREHOUSE_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/warehouse-app/dashboard", label: "Overview", icon: LayoutGrid, end: true },
        { to: "/warehouse-app/tasks", label: "Operator tasks", icon: ListChecks },
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
