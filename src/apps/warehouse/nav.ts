/**
 * Warehouse (WMS) workspace navigation — Phase 0 scaffold.
 *
 * WMS is the operational execution layer *above* Inventory. Inventory owns
 * quantities and cost; WMS owns physical location, operator, task, dock,
 * appointment, wave, pick, pack, load. See ADR 0079.
 *
 * The Warehouse app is mounted at `/warehouse-app/*` in src/App.tsx.
 * Every `to:` must be prefixed with `/warehouse-app/`.
 *
 * Only pages implemented in Phase 0 are wired here. Phases 1–7 (LPN, tasks,
 * receiving, putaway, picking, packing, dispatch, QC, operators) will
 * append entries as they ship — do not add nav entries for un-implemented
 * routes because the sidebar would 404.
 */
import {
  LayoutGrid,
  Warehouse,
  Network,
  Truck,
  PackageOpen,
  ClipboardList,
  Package,
  Ship,
  ShieldCheck,
  Users,
  Tag,
} from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";

export const WAREHOUSE_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/warehouse-app/dashboard", label: "Overview", icon: LayoutGrid, end: true },
        { to: "/warehouse-app/warehouses", label: "Warehouses", icon: Warehouse },
        { to: "/warehouse-app/layout", label: "Layout (zones / bins)", icon: Network },
      ],
    },
    {
      label: "Execution (coming online)",
      items: [
        { to: "/warehouse-app/receiving", label: "Receiving", icon: Truck },
        { to: "/warehouse-app/putaway", label: "Put-away", icon: PackageOpen },
        { to: "/warehouse-app/tasks", label: "Operator tasks", icon: ClipboardList },
        { to: "/warehouse-app/picking", label: "Picking", icon: Package },
        { to: "/warehouse-app/packing", label: "Packing", icon: Package },
        { to: "/warehouse-app/dispatch", label: "Dispatch", icon: Ship },
        { to: "/warehouse-app/qc", label: "Quality control", icon: ShieldCheck },
      ],
    },
    {
      label: "Master",
      items: [
        { to: "/warehouse-app/plates", label: "License plates", icon: Tag },
        { to: "/warehouse-app/operators", label: "Operators", icon: Users },
      ],
    },
  ],
};
