# Warehouse Ownership & Domain Boundary — Audit Verdict + Redesign Plan

## 1. First-principles verdict

In every mature ERP (SAP S/4 + EWM, Oracle SCM + WMS, D365 SCM, NetSuite, Odoo Enterprise, Infor/Manhattan WMS) the pattern is identical:

- **Warehouse identity** (the facility, its code, address, branch, activation, docks, zones, bins) is **enterprise/organisational master data**, authored in the WMS / logistics-structure module.
- **Inventory** is a *consumer* of that master data. Inventory owns quantity, valuation, lots, movements — never the facility record itself.
- **Warehouse Operations** (tasks, waves, picks, packs, appointments, LPNs) live above the facility, in WMS.
- **Cycle counting** is universally split: WMS performs *scan-first execution* (sessions, blind counts, recounts on the floor); Inventory owns *variance approval + adjustment posting* because only Inventory may mutate stock state.

Applied to our codebase:

- `warehouses` table = enterprise master data → **canonical owner: Warehouse app**.
- `stock_locations`, `stock_transfers`, `stock_quants`, `stock_movements` = inventory state → **canonical owner: Inventory app** (already correct per ADR-0079).
- `wms_*` tables = operational execution → **Warehouse app** (already correct).
- Cycle count split (`wms_count_sessions` in Warehouse, `physical_counts` in Inventory) = the textbook WMS↔Inventory boundary → **already correct, keep and formalise**.

## 2. What the audit actually found

Reads confirmed the following state (not opinion):

1. **Duplicated route surface.** `src/apps/inventory/routes.tsx` lines 136–182 and `src/apps/warehouse/routes.tsx` lines 69–100 both expose `warehouses`, `warehouses/new`, `warehouses/:id`, `warehouses/:id/edit`, wired to the *same* page modules under `src/pages/inventory/` (`WarehouseNew`, `WarehouseEdit`, `WarehouseView`) and `src/pages/Warehouses`. That is why "Add Warehouse" in the Warehouse app *appears* to jump to Inventory — it doesn't; it renders the same component. The confusion is real but structural, not behavioural.
2. **Nav duplicated.** `INVENTORY_NAV` (`src/apps/inventory/nav.ts:59`) and `WAREHOUSE_NAV` (`src/apps/warehouse/nav.ts:42`) both list "Warehouses" as master data. Two doors, one room.
3. **Inventory app also exposes Transfers (`/inventory-app/transfers`)** — this is correct (transfers are inventory movements, not warehouse execution) and stays put. The user's mention of "Active Transfers / Stock Transfers under Inventory" is expected inventory behaviour.
4. **Page files physically live under `src/pages/inventory/Warehouse{New,Edit,View}.tsx`** — a naming leftover from before ADR-0079. Warehouse routes import them from there (`src/apps/warehouse/routes.tsx:19-21`), which is the deepest reason ownership *looks* fragmented.
5. **ADR-0079 already declared the split** (Inventory owns quants/valuation; Warehouse owns physical execution) but the master-data ownership question was left ambiguous — it said `stock_locations` is "shared, owned by Inventory schema, authored via Warehouse UI" but never made the same explicit call for the `warehouses` table itself.
6. **Cycle counts are not duplicated.** `src/pages/warehouse/CycleCounts.tsx` + `CountSession.tsx` + `CountReview.tsx` operate on `wms_count_sessions` (scan-first execution). `src/apps/inventory` "Counts / Physical Count Workspace" operate on `physical_counts` and post adjustments via inventory RPCs. Two capabilities, one lifecycle — WMS session → emits event → Inventory posts. This is the enterprise pattern; **preserve it**.

## 3. Decision

**Warehouse master data (the `warehouses` row and its facility-level configuration) is owned by the Warehouse app.** Inventory becomes a read-only consumer. This aligns with SAP EWM, Oracle WMS, D365 SCM and matches ADR-0079's spirit.

**Cycle Counts stay split as-is.** Warehouse = execution surface; Inventory = adjustment authority. Document the contract; do not merge.

## 4. Plan (execution)

### Batch W1 — Codify the decision (ADR)
- New `docs/adr/0080-warehouse-master-data-ownership.md`: declares Warehouse app as canonical author of `warehouses` rows; Inventory holds a read-only badge/link; `stock_locations` continues per ADR-0079; cycle-count split formalised with the event contract (`warehouse.count.session.completed` → inventory posts).

### Batch W2 — Consolidate the master-data pages under Warehouse
- Move `src/pages/inventory/Warehouse{New,Edit,View,Form}.tsx` → `src/pages/warehouse/Warehouse{New,Edit,View,Form}.tsx`. Move `src/pages/Warehouses.tsx` → `src/pages/warehouse/WarehousesList.tsx`.
- Update all imports (both `src/apps/warehouse/routes.tsx` and any strays). No behavioural change to the components themselves — this is a namespace move so ownership is enforceable by directory.

### Batch W3 — Retire duplicate Inventory routes/nav for Warehouses
- `src/apps/inventory/routes.tsx`: replace `warehouses`, `warehouses/new`, `warehouses/:id`, `warehouses/:id/edit` with `<Navigate to="/warehouse-app/warehouses[...]" replace />` (deep-link preserving, same pattern ADR-0079 already used for `/inventory-app/warehouses/*`).
- `src/apps/inventory/nav.ts`: drop the "Warehouses" nav item from the Setup group. Keep "Transfers" (correctly Inventory).
- Anywhere in Inventory pages that links to `/inventory-app/warehouses/*`, update to `/warehouse-app/warehouses/*` (grep for `/inventory-app/warehouses`).

### Batch W4 — Inventory read-only consumer surface
- In Inventory Overview / Stock filters where a warehouse chip appears, keep the chip but change any "manage warehouses" link to point at `/warehouse-app/warehouses`. Inventory never renders create/edit affordances for facilities.

### Batch W5 — Cycle count contract, made explicit
- Add a short section to ADR 0080 describing the current event: `wms_count_sessions` completion emits `warehouse.count.session.completed` → the Inventory posting workflow consumes it into `physical_counts` (variance review + adjustment post).
- Add a UI callout on `/warehouse-app/counts` ("Adjustments are posted by Inventory → open the Inventory review here") and on Inventory's Counts page ("Scan sessions live in Warehouse → open here"). One sentence each, hyperlinked. No logic change.

### Batch W6 — Guardrails (architecture tests)
Extend `src/test/architecture/wms-phase1.test.ts` (or add `wms-phase-master-data.test.ts`) to assert:
- No `src/pages/inventory/Warehouse*.tsx` files exist.
- `src/apps/inventory/routes.tsx` contains no non-`Navigate` element for `path="warehouses*"`.
- `src/apps/inventory/nav.ts` does not include `/inventory-app/warehouses`.
- Every `warehouses`/`wms_*` create/update/delete originates from `src/pages/warehouse/**` or `src/hooks/useWarehouses.ts` (write helper); Inventory code is read-only.

### Batch W7 — Verify
- `tsgo -p tsconfig.app.json`.
- `bunx vitest run src/test/architecture`.
- Manual: `/inventory-app/warehouses` redirects to `/warehouse-app/warehouses`; deep links (`/inventory-app/warehouses/<id>`) redirect to `/warehouse-app/warehouses/<id>`; sidebars each show Warehouses only in the Warehouse app; Cycle Counts still function on both sides.

## 5. What is explicitly NOT changing
- `stock_locations`, `stock_transfers`, `stock_quants`, `stock_movements`, valuation, lots → remain Inventory.
- WMS `wms_*` operational tables → remain Warehouse.
- Cycle count *capabilities* on both sides → remain, contract formalised.
- No DB schema changes. This is a pure ownership/navigation/module-boundary refactor plus one ADR.

## 6. Technical notes
- Redirects use `<Navigate replace>` and must preserve `:id` and `edit` sub-paths. Use `useParams` inside a small `<InventoryWarehouseRedirect />` wrapper rather than four static routes, so `/edit`, `/new`, and `/:id` all forward cleanly.
- `useWarehouses.ts` stays where it is; both apps continue to read from it (read-only in Inventory is a UI concern, not a hook concern).
- Architecture tests use the same walk-src pattern as `wms-phase1.test.ts`.

Awaiting approval before I switch to build mode and execute batches W1–W7.

