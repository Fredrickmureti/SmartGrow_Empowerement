# Packaging Master — audit re-verified, remaining phases

The architecture audit for this domain already exists and is accepted:
`.lovable/plan.md` (audit body), `docs/audit/2026-08-02-packaging-master-audit.md`,
and `docs/adr/0105-packaging-master.md`. I re-verified the current state of the code
against it rather than re-auditing from scratch.

## Verified current state

Done and in the codebase:
- **Phase 1 — data model.** `wms_packaging_types` (9 packaging classes, inner + outer
  dims, weight limits, fill cap, dim-weight divisor, hazmat/UN, temperature band,
  returnable/stackable/nesting, ti/hi, four-state lifecycle, `row_version`),
  `wms_packaging_carriers`, `wms_packaging_availability`, `wms_packaging_events`.
- **Phase 2 — server-owned writes.** `wms_packaging_upsert`, `set_lifecycle`,
  `archive`, `set_carrier_rule`, `set_availability`; business + `inventory:write`
  guarded; audit ledger + `warehouse.packaging.*` outbox events; direct client
  INSERT/UPDATE/DELETE revoked.
- **Phase 3 — cartonization v2.** `suggest_packaging` with rotation-aware per-axis
  fit, fill cap, dim vs actual weight, carrier/hazmat/stock filters, split strategy
  and explicit failure reasons; client seam `packagingEngine.ts`; PackStation reads
  the ranked candidates.
- **Phase 4 — identity.** `wms_gs1_config`, `wms_sscc_registry`, check-digit/build/
  validate functions, `wms_sscc_allocate` / `void` / `mark_printed`, client seam
  `cartonSscc.ts` + `CartonSsccLabelButton`.

Not done (confirmed by reading the schema and pages):
- `wms_license_plates` has **no** `packaging_type_id` — handling units still cannot
  say which packaging they physically are (Phase 5).
- PackStation seal weight is still hand-typed; the serial scale driver is never read
  at seal, and packaging supply is never decremented (Phase 6).
- `src/pages/warehouse/CartonTypes.tsx` is still the **legacy 203-line CRUD table
  writing `wms_carton_types` directly from the browser**. The new master has no UI
  at all, and the old table still exists.

So the remaining work is Phases 5 and 6 plus two phases the original plan did not
contain: the operator-facing Packaging Master workspace, and retirement of the
legacy carton table.

## Phase 5 — Handling-unit unification

- Migration: `wms_license_plates.packaging_type_id` (FK, nullable), backfilled where
  a pack carton already stamps a packaging type; `wms_lpn_type` kept only as a coarse
  facet derived from the packaging class via a trigger/derivation function.
- Plate creation/seal RPCs accept and validate the packaging type (same business,
  lifecycle not `retired`), and stamp tare + outer cube from the master onto the
  plate/shipment handling unit.
- Carrier admissibility validated at seal: sealing with packaging not admissible for
  the shipment's carrier raises a named error the pack UI can explain.
- `LicensePlates` / `LicensePlateView` show the packaging identity (code, class,
  tare, cube) instead of only the enum facet.

## Phase 6 — Hardware at seal

- Scale capture in the seal dialog through the existing `hardwareClient` command
  router (`read_weight`), with manual override and a variance flag when the typed
  weight deviates from the captured weight beyond tolerance.
- Carton label printing routed by packaging class / media profile through
  `printWmsLabel` (no raw ZPL, per ADR 0089/0086).
- Packaging-supply decrement at seal against `wms_packaging_availability` via RPC,
  with a low-stock signal surfaced on the Packaging Master workspace.

## Phase 7 — Packaging Master workspace (replaces the CRUD page)

Route stays `/warehouse-app/cartons` (nav label becomes "Packaging master"), page
rewritten as a three-pane operational workspace, not a table:

- **Left rail:** class explorer (carton / envelope / tube / crate / pallet / tote /
  insulated / drum / bag) with counts and lifecycle filters.
- **Centre:** virtualized grid (TanStack Table + existing `@tanstack/react-virtual`;
  no new heavy grid dependency, no hand-rolled div tables) with columns for code,
  class, inner/outer dims, max weight, tare, dim weight, cost, lifecycle, on-hand
  supply; sortable, filterable, column-visibility persisted.
- **Right inspector:** tabs — Overview (scale-accurate proportion preview + capacity
  bars), Compatibility (carrier × service admissibility, oversize/surcharge, hazmat,
  temperature band), Supply (per-warehouse on hand vs reorder point), Usage (pack
  volume, fill-rate distribution, last used), History (`wms_packaging_events`
  timeline).
- All writes go through the Phase 2 RPCs with `row_version` conflict handling;
  lifecycle transitions are explicit actions (draft → active → restricted → retired),
  never a delete.

## Phase 8 — Legacy retirement

- Repoint the last `carton_type` naming in PackStation / MobilePack to packaging
  terminology, drop `wms_carton_types` and `suggest_carton`, delete
  `wms-phase12.test.ts` assertions that pin the legacy table, and extend
  `src/test/architecture/packaging-master.test.ts` with the Phase 5–7 guards the ADR
  already promises (plates carry `packaging_type_id`, no `wms_carton_types`
  reference anywhere, carton labels only via `printWmsLabel`, no client writes to the
  master tables).

## Technical notes

- One phase per turn, each complete and internally coherent; every migration includes
  GRANTs + RLS, and every new writer is `SECURITY DEFINER` + permission-guarded.
- No compatibility shims: the legacy table is dropped, not dual-written.
- New UI code reuses the existing design-system primitives and shadcn components;
  the only new frontend dependency considered is `@tanstack/react-table`.
