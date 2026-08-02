# Packaging Master (ADR 0105) — verification result + remaining phases

**Last updated:** 2026-08-02 (independent verification round)
**Last genuinely completed phase:** Phase 6 (with two defects, see 6.1)
**Active phase:** 6.1 (corrections) → 7 (Packaging Master Workspace)

---

## Phase 1 — Independent verification of the previous engineer's claims

Checked directly against the codebase and the live database.

### Confirmed true
- Packaging Master schema exists: `wms_packaging_types` (34 cols incl. inner/outer
  dims, fill cap, dim-weight divisor, nesting, ti/hi, hazmat/UN, temp band,
  lifecycle, `row_version`), `wms_packaging_carriers`, `wms_packaging_availability`,
  `wms_packaging_events`.
- All packaging/SSCC tables have RLS on, `SELECT` for `authenticated`, and **no**
  INSERT/UPDATE/DELETE for `anon`/`authenticated` — writes really are RPC-only.
- RPC surface present: `wms_packaging_upsert`, `set_lifecycle`, `archive`,
  `set_carrier_rule`, `set_availability`, `suggest_packaging`,
  `assign_packaging_to_pack`, `wms_packaging_consume`, `wms_packaging_fits_item`,
  `wms_packaging_class_to_lpn_type`, `wms_lpn_set_packaging`,
  `wms_resolve_carton_scan`, full `wms_sscc_*` set.
- Phase 4.5 pack-path unification is real: PackStation and MobilePack both call
  `suggest_packaging` / `assign_packaging_to_pack`, both read the
  `{ carton_id }` envelope from `open_pack_carton`. No `suggest_carton` /
  `assign_carton_to_pack` call site remains in `src/`.
- Phase 5 is real: `wms_lpn_set_packaging` is registered in the replay
  dispatcher via `_wms_replay_lpn_set_packaging`, `wms_lpn_move` is registered,
  PackStation reads `packaging_type_id` (not the legacy column).
- Phase 6 is real: `wms_pack_cartons.packaging_consumed_at` exists,
  `seal_pack_carton` consumes exactly one unit behind that guard inside an
  exception block, `usePackScale` exists and PackStation weighs through it.

### Confirmed false / defective
1. **`wms_packaging_consume` is executable by `authenticated`.** The migration
   contains the `REVOKE ... FROM PUBLIC`, but the live grant check returns
   `EXECUTE = true` for `authenticated`, so a browser client can decrement
   packaging stock and write audit rows directly. The guard test only greps the
   migration text, so it passes while the database is wrong.
2. **Phase 7 has not started and the legacy screen is still the shipped one.**
   `/warehouse-app/cartons` renders `src/pages/warehouse/CartonTypes.tsx`, a
   203-line CRUD table doing **direct client `insert` / `update` / `delete` on
   `wms_carton_types`** — the exact anti-pattern the programme's invariants
   forbid, still reachable from the Warehouse nav.
3. **`wms_carton_types` still grants `INSERT` to `authenticated` and `SELECT` to
   `anon`,** unlike every Packaging Master table.
4. **No packaging master data exists** (`wms_packaging_types` = 0 rows). Every
   cartonization call in every business currently fails with
   `no_active_packaging`; the engine is unreachable end-to-end.
5. **Verification claims could not be reproduced:** the workspace's
   `node_modules` is incomplete (`vitest` and `react-router-dom` unresolved), so
   the "55/55 passing, tsgo clean" claim is unverified. Dependencies must be
   installed and both gates re-run before new work lands.
6. `@tanstack/react-table` is **not** installed, so the Phase 7 grid has an
   unmet dependency (`@tanstack/react-virtual` is present).

---

## Phase 6.1 — Corrections (do first)

- Reinstall dependencies; re-run
  `bunx vitest run src/test/architecture/packaging-master.test.ts src/test/hardware/pack-scale-normalization.test.ts src/test/architecture/lpn-handling-units.test.ts`
  and `bunx tsgo --noEmit -p tsconfig.app.json`. Fix whatever actually fails.
- Migration: `REVOKE ALL ON FUNCTION public.wms_packaging_consume(...) FROM PUBLIC, anon, authenticated;`
  and re-grant only `service_role`. Same audit for every packaging RPC that must
  not be client-callable.
- Strengthen the guard test so privilege assertions are expressed against the
  intended final grant state (grep for an explicit `FROM PUBLIC, anon, authenticated`
  revoke), not just any `REVOKE`.
- Migration: revoke `anon SELECT` and `authenticated INSERT/UPDATE/DELETE` on
  `wms_carton_types` (legacy table is read-only until Phase 8 drops it).

## Phase 7 — Packaging Master Workspace (replaces CartonTypes.tsx)

New module `src/features/warehouse/packaging/workspace/`, routed at
`/warehouse-app/packaging` with `/warehouse-app/cartons` redirecting to it; nav
label becomes "Packaging master". `CartonTypes.tsx` is deleted, not wrapped.

Layout: list + inspector (master/detail), not a CRUD table.
- **Grid**: TanStack Table v8 (`bun add @tanstack/react-table`) over
  `wms_packaging_types`, virtualized with the installed `@tanstack/react-virtual`.
  Faceted filters: class, lifecycle, material, carrier admissibility, stocked /
  low-stock, hazmat, temperature-controlled, returnable. Columns show code, name,
  class, inner/outer dims, max weight, tare, fill cap, cost, lifecycle badge,
  stock-on-hand chip.
- **Inspector** (right pane, tabbed):
  - *Geometry & handling* — inner vs outer dims with a proportional visual, usable
    volume, fill cap, dim-weight divisor, tare, nest ratio, ti/hi, stackable/returnable.
  - *Carrier admissibility* — per carrier/service rows (allowed, oversize,
    surcharge, divisor) via `wms_packaging_set_carrier_rule`.
  - *Availability* — per warehouse on-hand, reorder point, stocked flag via
    `wms_packaging_set_availability`; low-stock surfaced from the Phase 6
    `warehouse.packaging.reorder_needed` events.
  - *Compliance* — hazmat class, UN rating, temperature band.
  - *Activity* — timeline from `wms_packaging_events`.
- **Lifecycle rail** — `draft → active → restricted → retired` through
  `wms_packaging_set_lifecycle`; archive through `wms_packaging_archive`. No
  destructive delete.
- **Editor** — single form (create/edit) posting `wms_packaging_upsert` with
  `row_version`; optimistic-concurrency conflict surfaced as a reload prompt.
- **Seeding** — "Add standard packaging" action that upserts a baseline catalogue
  (small/medium/large regular slotted cartons, mailer envelope, tube, EUR/GMA
  pallet, tote, insulated shipper) through the RPC, so cartonization is usable on
  day one. Empty state points at it.
- **Guards** — extend `packaging-master.test.ts`: no client table writes anywhere
  under the workspace, every mutation sends `row_version`, no `wms_carton_types`
  reference in `src/`, semantic tokens only (no raw colour classes).

## Phase 8 — Decommission legacy

- Confirm no reader remains, then drop `suggest_carton`, `assign_carton_to_pack`,
  `wms_pack_cartons.carton_type_id`, table `wms_carton_types`.
- Remove the `suggest_carton` branch from `wms_replay_guarded_call`.
- Delete `wms-phase12.test.ts` assertions about the legacy table; replace with a
  guard that no `carton_type` identifier survives in `src/` or in new SQL.

## Phase 9 — Packing-workflow gaps found during this audit (new)

- `wms_resolve_carton_scan` exists but there is no **reprint / damaged-label**
  path: add `wms_sscc_mark_printed`-backed reprint action on the carton row in
  PackStation with reason capture (`wms_sscc_void` + re-allocate when the SSCC
  itself is compromised).
- **Packaging consumption has no replenishment loop UI** — the reorder events are
  emitted but nothing consumes them; surface them in the workspace Availability
  tab and the Warehouse exceptions inbox.
- **No packaging analytics**: cost per shipment, fill-rate distribution, dim-weight
  overage by packaging type. Add a compact usage panel fed by
  `wms_packaging_events` + sealed cartons.

### Deferred (unchanged)
Multi-carton bin-packing heuristics (Phase 13), cross-warehouse cross-dock (Phase 14).

---

## Technical notes

- Writes stay server-owned: every mutation is an RPC with `row_version`, an audit
  row in `wms_packaging_events`, and an outbox event. No `.from(...).insert()` on
  packaging tables from the client, ever.
- `packaging_class` and `lifecycle_status` are Postgres enums — derive UI options
  from the generated `Database` types, never hardcode string unions.
- The coarse `wms_lpn_type` facet stays server-derived via
  `wms_packaging_class_to_lpn_type`; the workspace never sets it.
