# ADR 0105 — Packaging Master (supersedes the Carton Catalogue)

**Status:** Accepted (2026-08-02)
**Related:** ADR 0079 (Inventory ↔ Warehouse split), ADR 0083
(cartonization v1), ADR 0102 (license plates as handling units),
ADR 0076 (stock event fabric), ADR 0071 (GS1 scanner parsing)
**Audit:** `docs/audit/2026-08-02-packaging-master-audit.md`

## Context

ADR 0083 introduced `wms_carton_types` — a box list (code, name, one set
of dimensions, max weight, tare, cost, active flag) plus `suggest_carton`,
which compares the **sum of product cube** against **carton cube**. The
audit found that this cannot serve as the packaging foundation of the WMS:

- volume-only fit accepts geometrically impossible packs;
- only one packaging shape exists (carton) — no envelope, tube, crate,
  pallet, tote, insulated, drum or bag; no hazmat, cold-chain, returnable,
  stackability/nesting, dim-weight or carrier admissibility attributes;
- master data is written directly from the browser: no optimistic
  concurrency, no audit ledger, no outbox event, hard deletes on rows
  referenced by shipping history;
- the handling-unit type vocabulary (`wms_lpn_type` enum) is disjoint from
  the catalogue, so a carton plate cannot say *which* carton it is;
- cartons have no identity: no SSCC, no carton label, no scan intent.

## Decision

The domain is renamed and re-founded as a **Packaging Master**.

1. **`wms_packaging_types`** replaces `wms_carton_types`. It carries a
   packaging **class** (`carton | envelope | tube | crate | pallet |
   tote | insulated | drum | bag`), inner **and** outer dimensions,
   weight limits, `max_volume_fill_pct`, `dim_weight_divisor`, material,
   cost, `is_returnable`, `is_stackable`, `nest_ratio`,
   `units_per_layer` / `layers_per_unit` (ti/hi), `hazmat_class` /
   `un_rating`, `temp_min_c` / `temp_max_c`, a four-state
   `lifecycle_status` (`draft | active | restricted | retired`) and
   `row_version`.
2. **`wms_packaging_carriers`** — packaging × carrier (× optional
   service code) admissibility with oversize/surcharge flags.
3. **`wms_packaging_availability`** — per-warehouse stock of the
   packaging supply itself (on hand, reorder point), decremented at seal.
4. **`wms_packaging_events`** — append-only audit ledger for every
   create/update/lifecycle/print action on a packaging type.
5. **Writes are RPC-only.** `wms_packaging_upsert`,
   `wms_packaging_set_lifecycle`, `wms_packaging_archive` are
   `SECURITY DEFINER`, business-guarded, `inventory:write` gated and
   `row_version` checked; direct table writes are revoked from
   `authenticated`. Each RPC writes an event row and a
   `warehouse.packaging.*` outbox event (ADR 0076 fabric).
6. **Cartonization v2** (`suggest_packaging`) returns a *ranked candidate
   set* using per-axis fit with rotation, the fill cap, dim weight vs
   actual weight, and hazmat / cold-chain / carrier filters, and splits
   into multiple units when no single packaging fits. Missing product
   dimensions produce an explicit `reason`, never a silent `NULL`.
7. **Handling units reference the master.**
   `wms_license_plates.packaging_type_id` becomes the plate's physical
   identity; `wms_lpn_type` survives only as a coarse facet derived from
   the packaging class.
8. **Identity and hardware.** SSCC is minted server-side
   (`wms_next_sscc`), a `wms.label.carton` template joins the WMS label
   registry, sealing reads the scale through the existing hardware
   command router, and a `pack.carton` scan intent resolves a sealed
   carton back to its handling unit.

`wms_carton_types` is migrated and **dropped** — no compatibility shim
(there are no production users). `assign_carton_to_pack` becomes
idempotent: tare is applied once per stamped packaging type.

## Consequences

- Cartonization becomes explainable and safe; the pack station shows
  *why* a packaging type was proposed and what the alternatives cost.
- Shipping gains dim weight and carrier admissibility at source.
- 3PL billing and packaging replenishment get first-class data.
- Master data becomes auditable and event-driven like the rest of WMS.
- Every surface that read `wms_carton_types` must be repointed in the
  same phase; nothing is left dual-writing.

## Guards

`src/test/architecture/packaging-master.test.ts`: no client write to
`wms_packaging_types`, no remaining `wms_carton_types` reference, SSCC
minted server-side only, carton labels only via `printWmsLabel`,
PackStation calls `suggest_packaging`, plates carry
`packaging_type_id`.
