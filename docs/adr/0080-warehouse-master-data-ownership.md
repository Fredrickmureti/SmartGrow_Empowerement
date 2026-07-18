# ADR 0080 — Warehouse master data ownership

**Status:** Accepted (2026-07-18) · **Complements:** 0064, 0068, 0076, 0078, 0079

## Context

ADR 0079 split physical execution (Warehouse app) from the stock ledger
(Inventory app) but left the **`warehouses` master-data row itself**
straddling both apps. In practice both `/inventory-app/warehouses/*` and
`/warehouse-app/warehouses/*` routed to the same components under
`src/pages/inventory/`, both sidebars listed "Warehouses" as setup, and
"Add Warehouse" in the WMS visibly rendered an Inventory-branded form.

Enterprise ERPs are unambiguous on this: in SAP S/4HANA + EWM, Oracle
SCM + WMS, Microsoft Dynamics 365 SCM, NetSuite, Odoo Enterprise, and
Infor/Manhattan WMS, the **facility record** — its code, address,
branch, activation, docks, zones, bins — is authored in the
logistics/WMS module. Inventory consumes it. Never the other way round.

## Decision

The `warehouses` table is **owned by the Warehouse app**. The Warehouse
app is the sole authoring surface (list, create, edit, view). Inventory
becomes a read-only consumer — it may reference a warehouse in filters,
scope gates, and peek sheets, but never render create/edit affordances.

Concretely:

| Concern | Owner |
|---|---|
| `warehouses` row lifecycle (create/edit/deactivate) | **Warehouse app** — `src/pages/warehouse/Warehouse{sList,New,Edit,View,Form}.tsx` |
| Warehouse facility navigation entry | **Warehouse app** only. Removed from Inventory sidebar. |
| Physical layout (zones, bins, docks) | Warehouse app (per ADR 0079) |
| Stock quantity / valuation / movements | Inventory app (unchanged) |
| `stock_locations` | Owned by Inventory schema, authored via Warehouse UI (per ADR 0079) |

Legacy `/inventory-app/warehouses[/*]` paths continue to resolve — they
now `<Navigate replace>` to `/warehouse-app/warehouses[/*]` so bookmarks
and cross-links survive.

## Cycle count contract

Cycle counting is **not duplicated** — the two surfaces are two halves
of the same enterprise lifecycle and must both exist:

- **Warehouse app** (`wms_count_sessions`, `wms_count_lines`) owns
  *scan-first execution*: blind counts, recounts, operator assignment,
  RF/mobile capture. Warehouse never mutates stock state directly.
- **Inventory app** (`physical_counts`, `physical_count_lines`) owns
  *variance approval and adjustment posting*. Only Inventory writes to
  `stock_quants` / `stock_movements`.

The bridge is a business event: a completed WMS count session emits
`warehouse.count.session.completed`; the Inventory posting workflow
consumes it, materialises a `physical_counts` row for review, and posts
adjustments via the sanctioned inventory RPCs. Both surfaces link to
each other in the UI so operators and controllers see the whole chain.

## Consequences

1. One canonical author for warehouse facilities. Confusion eliminated.
2. Deep links preserved via inventory-side `<Navigate>` — no broken
   bookmarks, no changed URLs for Warehouse app users.
3. Architecture guard (`wms-phase-master-data.test.ts`) prevents
   regression: no `src/pages/inventory/Warehouse*.tsx`, no
   `/inventory-app/warehouses` in the Inventory nav, no non-`Navigate`
   inventory route for `path="warehouses*"`.
4. No DB schema changes. Pure ownership/navigation/module-boundary
   refactor.

## Non-goals

- No changes to `stock_movements`, `stock_quants`, valuation, or lots.
- No changes to `wms_*` operational tables.
- No changes to `useWarehouses` — hook is app-agnostic; the ownership
  boundary is enforced at the page/route layer.
