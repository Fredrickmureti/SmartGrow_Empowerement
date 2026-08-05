---
name: Warehouse navigation information architecture (ADR 0121)
description: Domain-oriented Warehouse sidebar structure — goods-flow groups, execution vs configuration separation, depth/size caps, and how new WMS surfaces must attach.
type: feature
---

# Warehouse IA — ADR 0121

`src/apps/warehouse/nav.ts` (`WAREHOUSE_NAV`) is organised by goods-flow
domain, not by page:

```
Work              Overview · My tasks · Exceptions        (flat, high frequency)
Inbound           tower · Appointments · Receiving · Quality inspections ·
                  Putaway · Cross-dock · Returns
Inventory control Replenishment · Cycle counts · Slotting · Handling units
Outbound          tower · Wave planning · Dispatch & loading
Yard              Yard overview · Gate · Yard marshal · Trailers
Workforce         Labour
Analysis          Operations performance · 3PL billing
Configuration     Warehouses · Layout & storage · Putaway strategies ·
                  Packaging catalogue                    (always last)
```

Rules when adding a warehouse surface:

1. Attach it inside an existing domain, as an item or as
   `WorkspaceNavItem.children`. A new top-level group needs a new ADR.
2. Administrator/setup surfaces go in `Configuration`, never beside execution.
3. `Work` stays flat and short — it is the operator landing zone.
4. Depth <= 2, group size <= 8, no orphan routes, no dead links. Enforced by
   `src/test/architecture/warehouse-nav-ia.test.ts`; exemptions from the
   no-orphan rule go in that file's `NAV_EXEMPT` map with a reason.
5. URLs under `/warehouse-app/*` are frozen — IA changes are labels and
   grouping only.

Terminology: Handling units (not License plates), Operations performance (not
Execution telemetry), Appointments (not Dock schedule), Quality inspections,
Dispatch & loading, Layout & storage, Yard overview, Trailers.

ADR 0101 still applies: `WAREHOUSE_APP` pairs with exactly one nav.
