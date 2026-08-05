/**
 * Warehouse (WMS) workspace navigation — domain-oriented information
 * architecture (ADR 0102).
 *
 * WMS is the operational execution layer *above* Inventory. Inventory owns
 * quantities and cost; WMS owns physical location, operator, task, dock,
 * appointment, wave, pick, pack, load. See ADR 0079.
 *
 * ## Structure rules (do not break these when adding a surface)
 *
 * 1. The top level is the **goods-flow domain model**, not a page list:
 *    Work / Inbound / Inventory control / Outbound / Yard / Workforce /
 *    Analysis / Configuration.
 * 2. **Execution never mixes with configuration.** Anything an administrator
 *    sets up once (strategies, layout, catalogues, master registers) belongs
 *    in the Configuration group — never beside a shift-time workflow.
 * 3. **High-frequency surfaces stay unnested.** The `Work` group is the
 *    operator's landing zone and is deliberately flat and short so the most
 *    repeated tasks are always one click away.
 * 4. **New capabilities attach as `children` of an existing domain**, never as
 *    a new top-level row. Adding a top-level group requires a new domain
 *    boundary, i.e. an ADR.
 * 5. Nav depth is capped at 2 and each group at 8 items. Enforced by
 *    `src/test/architecture/warehouse-nav-ia.test.ts`.
 * 6. Only wire entries for pages that are BUILT and functional; never point at
 *    a placeholder.
 *
 * The Warehouse app is mounted at `/warehouse-app/*`; every `to:` must be
 * prefixed with `/warehouse-app/`.
 */
import {
  Activity,
  AlertTriangle,
  Box,
  CalendarClock,
  ClipboardCheck,
  Container,
  DoorOpen,
  Forklift,
  Gauge,
  Inbox,
  LayoutGrid,
  ListChecks,
  Network,
  PackageOpen,
  ParkingSquare,
  Receipt,
  Repeat,
  Send,
  ShieldCheck,
  Split,
  Truck,
  Undo2,
  Users,
  Warehouse,
  Waves,
} from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";

export const WAREHOUSE_NAV: WorkspaceNav = {
  groups: [
    {
      // Highest-frequency surfaces. Intentionally flat — an operator should
      // never expand a tree to reach their queue.
      label: "Work",
      items: [
        { to: "/warehouse-app/dashboard", label: "Overview", icon: LayoutGrid, end: true },
        { to: "/warehouse-app/tasks", label: "My tasks", icon: ListChecks },
        { to: "/warehouse-app/exceptions", label: "Exceptions", icon: AlertTriangle },
      ],
    },
    {
      // Goods-in flow: appointment → gate → receipt → inspection → putaway.
      label: "Inbound",
      items: [
        { to: "/warehouse-app/dashboard/inbound", label: "Inbound control tower", icon: Inbox },
        { to: "/warehouse-app/schedule", label: "Appointments", icon: CalendarClock },
        { to: "/warehouse-app/receiving", label: "Receiving", icon: Inbox },
        { to: "/warehouse-app/qc", label: "Quality inspections", icon: ShieldCheck },
        { to: "/warehouse-app/putaway", label: "Putaway", icon: Truck, end: true },
        { to: "/warehouse-app/crossdock", label: "Cross-dock", icon: Split },
        { to: "/warehouse-app/returns", label: "Returns", icon: Undo2 },
      ],
    },
    {
      // Stock integrity and storage optimisation inside the four walls.
      label: "Inventory control",
      items: [
        { to: "/warehouse-app/replenishment", label: "Replenishment", icon: Repeat },
        { to: "/warehouse-app/counts", label: "Cycle counts", icon: ClipboardCheck },
        { to: "/warehouse-app/slotting", label: "Slotting", icon: Gauge },
        { to: "/warehouse-app/plates", label: "Handling units", icon: PackageOpen },
      ],
    },
    {
      // Goods-out flow: wave → pick → pack → load → depart.
      label: "Outbound",
      items: [
        { to: "/warehouse-app/dashboard/outbound", label: "Outbound control tower", icon: Send },
        { to: "/warehouse-app/waves", label: "Wave planning", icon: Waves },
        { to: "/warehouse-app/dispatch", label: "Dispatch & loading", icon: Send },
      ],
    },
    {
      // Everything outside the dock door.
      label: "Yard",
      items: [
        { to: "/warehouse-app/yard", label: "Yard overview", icon: ParkingSquare, end: true },
        { to: "/warehouse-app/yard/gate", label: "Gate", icon: DoorOpen },
        { to: "/warehouse-app/yard/marshal", label: "Yard marshal", icon: Forklift },
        { to: "/warehouse-app/yard/trailers", label: "Trailers", icon: Container },
      ],
    },
    {
      label: "Workforce",
      items: [{ to: "/warehouse-app/labour", label: "Labour", icon: Users }],
    },
    {
      // Read-only, after-the-fact views. Supervisors and finance, not operators.
      label: "Analysis",
      items: [
        { to: "/warehouse-app/telemetry", label: "Operations performance", icon: Activity },
        { to: "/warehouse-app/billing", label: "3PL billing", icon: Receipt },
      ],
    },
    {
      // Administrator surfaces. Set up once, rarely touched during a shift.
      label: "Configuration",
      items: [
        { to: "/warehouse-app/warehouses", label: "Warehouses", icon: Warehouse },
        { to: "/warehouse-app/layout", label: "Layout & storage", icon: Network },
        { to: "/warehouse-app/putaway/strategies", label: "Putaway strategies", icon: Gauge },
        { to: "/warehouse-app/packaging", label: "Packaging catalogue", icon: Box },
      ],
    },
  ],
};
