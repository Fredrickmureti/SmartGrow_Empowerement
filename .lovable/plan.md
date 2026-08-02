
# Carton Catalogue — Architecture Audit & Target Architecture

## What I verified (evidence, not assumption)

- Table: `wms_carton_types` (migration `20260717233348`) — `code, name, length_cm, width_cm, height_cm, max_weight_kg, tare_weight_kg, cost, is_active, notes`. Business-scoped RLS + `inventory:write`. Nothing else.
- Engine: `suggest_carton(business_id, product_ids[], quantities[])` — sums `products.length_cm*width_cm*height_cm` and `weight_kg`, returns the smallest active carton whose **volume** and max weight cover the total.
- `assign_carton_to_pack(carton_id, carton_type_id)` copies L/W/H onto `wms_pack_cartons` and does `weight_kg = COALESCE(weight_kg,0) + tare_weight_kg`.
- UI: `src/pages/warehouse/CartonTypes.tsx` — 203 lines, shadcn `Table` + one create `Dialog`, direct client `insert` / `update(is_active)` / `delete`. No edit, search, filter, detail, or usage view.
- Handling units: `wms_lpn_type` is a hardcoded enum `('pallet','carton','tote','other')` (migration `20260717183316`); `wms_license_plates` has **no** link to a carton/packaging type. Plate stock model is sound (ADR 0102, `stock_quants.lpn_id`, RPC-only ops, `wms_lpn_events`, `wms_lpn_status_edges`).
- Labels: `WMS_LABEL_KEY` = `lpn | bin | shipping | packing_slip`. No carton/handling-unit label, and **no SSCC minting anywhere** — GS1 AI `00` exists in `src/lib/gs1/aiTable.ts` for *parsing inbound scans only*.
- Hardware: `electron/hardware/drivers/SerialScaleDriver.ts` (`read_weight`) exists, but PackStation seal weight is typed by hand — the scale is never read at pack.
- Product-side packaging (`product_packaging`: name + `qty_in_base_uom` + barcode) is a UoM/pack-quantity concept with **no dimensions or weight**, so cartonization cannot use it.
- Carriers: `public.carriers` exists; there is no carrier↔packaging compatibility anywhere.

## Architectural verdict

The plate/handling-unit layer is enterprise-grade. The Carton Catalogue is not: it is a single-shape box list with client-side CRUD, and it is the weakest link in the pack→ship chain.

Strengths: correct business/branch scoping; catalogue is already referenced from pack events; cartonization is already an RPC (server-owned decision); guards exist (`wms-phase12.test.ts`).

Weaknesses, ordered by operational impact:

1. **Volume-only fit is unsafe.** A 200 cm rod "fits" a 30 cm carton because only cube is compared. No per-axis fit, no rotation, no fill-rate cap, no multi-carton split. Any missing product dimension returns NULL and the whole suggestion silently degrades to operator guessing.
2. **Not a packaging master, only cartons.** No packaging class (envelope, tube, crate, pallet, tote, insulated, reusable), no material, no outer dims (only one dim set — inner vs outer is ambiguous today), no dimensional-weight divisor, no hazmat/UN rating, no cold-chain/temperature band, no returnable/reusable flag, no stackability/nesting (ti/hi), no carrier-specific packaging, no per-warehouse availability, no packaging-supply stock or replenishment.
3. **Client-owned writes on master data.** Insert/update/delete straight from the browser: no `row_version`, no audit ledger, no `business_event_outbox` event, and a hard `DELETE` on a row referenced by historical `wms_pack_cartons` — packing history loses its packaging identity.
4. **Two disjoint type vocabularies.** `wms_lpn_type` enum vs the carton catalogue. A "carton" plate cannot say *which* carton it is, so tare, cube and carrier rules never reach the shipment.
5. **Identification lifecycle is missing.** Cartons are never SSCC-labelled or minted, there is no carton label template, no reprint-with-reason path (plates have one; cartons don't), and no `pack.carton` scan intent — so "worker scans carton" in the target flow cannot happen.
6. **`assign_carton_to_pack` is not idempotent** — a second call adds tare weight again, corrupting shipping weight (real bug, offline replay makes it reachable).
7. **UX is a CRUD table**, not an operational surface: no capacity/fill visualisation, no usage analytics, no compatibility view, no lifecycle, no drill-down inspector.

Business-event trace against the target flow: Pick → Pack → **Suggested carton (weak)** → **Worker confirms (ok)** → **Carton scanned (missing)** → Packed (ok) → **Weight captured (manual only)** → Shipping label (ok) → **License plate ↔ carton identity (missing)** → Carrier label (missing) → Dispatch (ok).

## Target architecture

Domain rename: **Packaging Master** (`wms_packaging_types`) — owned by Warehouse master data, consumed by cartonization, pack, handling units, printing, shipping and 3PL billing. `wms_carton_types` is migrated and dropped, not shimmed (no production users).

```text
Packaging Master ──┬─► Cartonization engine (fit + rank + split)
                   ├─► Handling units (wms_license_plates.packaging_type_id, tare/cube)
                   ├─► Identification (SSCC mint → carton label → scan intent)
                   ├─► Carrier compatibility (packaging × carrier × service)
                   └─► Supply stock per warehouse (consumption at seal)
```

## Phases (one complete phase at a time)

**Phase 0 — Deliverables.** `docs/audit/2026-08-02-packaging-master-audit.md` (this audit, expanded with call-site tables) and `docs/adr/0105-packaging-master.md`.

**Phase 1 — Data model.** Migration: `wms_packaging_types` with class enum (`carton|envelope|tube|crate|pallet|tote|insulated|drum|bag`), inner + outer dims, `max_weight_kg`, `tare_weight_kg`, `max_volume_fill_pct`, `dim_weight_divisor`, material, cost, `is_returnable`, `is_stackable`, `nest_ratio`, `units_per_layer`/`layers_per_unit`, `hazmat_class`/`un_rating`, `temp_min_c`/`temp_max_c`, `lifecycle_status` (`draft|active|restricted|retired`), `row_version`, audit columns; `wms_packaging_carriers` (packaging × carrier × service, oversize/surcharge); `wms_packaging_availability` (warehouse scope + on-hand/reorder point); `wms_packaging_events` audit ledger. Data migrated from `wms_carton_types`; FK on `wms_pack_cartons` and history repointed; old table dropped. GRANTs + RLS on every new table.

**Phase 2 — Server write layer.** `wms_packaging_upsert`, `wms_packaging_set_lifecycle`, `wms_packaging_archive` (blocks archive-with-usage), all `SECURITY DEFINER`, business/branch + `inventory:write` guarded, `row_version`-checked, each writing `wms_packaging_events` and a `warehouse.packaging.*` outbox event via the existing fabric (ADR 0076). Revoke direct table writes from `authenticated`.

**Phase 3 — Cartonization v2.** `suggest_packaging(...)` returning a ranked candidate set: per-axis fit with rotation, fill-rate cap, dim-weight vs actual weight, hazmat/cold-chain/carrier filters, multi-carton split when one unit cannot hold the bundle, and an explicit `reason` when dimensions are missing instead of silent NULL. Make `assign_carton_to_pack` idempotent (tare applied once, keyed on the type already stamped). Wire PackStation to the ranked list with a "why this carton" explainer.

**Phase 4 — Identification.** `wms_next_sscc` (GS1 company-prefix + check digit) minted at carton open; `wms.label.carton` template + `printWmsLabel` key; reprint-with-reason writing to the carton/plate event ledger; `pack.carton` scan intent so scanning a sealed carton resolves it (reusing `interpretScan`).

**Phase 5 — Handling-unit unification.** `wms_license_plates.packaging_type_id`; `wms_lpn_type` derived from packaging class (enum retained only as a coarse facet); pack seal creates/updates the shipment handling unit with tare + cube from the master; carrier compatibility validated at seal.

**Phase 6 — Hardware.** Scale capture at seal through the existing hardware command router (`read_weight`) with manual override + variance flag; label-printer routing per packaging class/media profile; packaging-supply decrement at seal against `wms_packaging_availability`.

**Phase 7 — Operational UX.** Replace `CartonTypes.tsx` with a `PackagingMaster` workspace: TanStack Table (v8) grid with faceted filters/saved views + `@tanstack/react-virtual` rows, master/detail split with an inspector (dimensions, scaled proportion preview, capacity & fill bars, carrier compatibility matrix, availability by warehouse, usage analytics from `wms_pack_cartons`, lifecycle timeline from `wms_packaging_events`), routed drill-down `/warehouse-app/packaging/:id`, and dedicated create/edit routes instead of the dialog. New dependency: `@tanstack/react-table` only; everything else is existing shadcn/Radix + design-system primitives.

**Phase 8 — Guards & docs.** Replace `wms-phase12.test.ts` carton assertions with `packaging-master.test.ts`: no client write to `wms_packaging_types`, no `wms_carton_types` reference left, SSCC minted server-side only, carton labels only via `printWmsLabel`, PackStation calls `suggest_packaging`, LPN carries `packaging_type_id`. Update `WMS_MODULE_OWNERSHIP.md`, nav label, and `.lovable/plan.md`.

## Notes

- Phases 1–3 are the architectural core; 4–6 close the hardware/identity gaps; 7 is the surface. I will not start a phase before the previous one is green (`tsgo --noEmit` + architecture suite).
- Hard cut, no compat shim, per your instruction that no production users exist.
