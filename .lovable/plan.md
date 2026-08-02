# Packaging Master (ADR 0105) — Round 2: verification result & remaining phases

## Phase 1 — Independent verification of the previous engineer's claims

Method: database introspection (`pg_proc`, `information_schema.columns`,
`pg_policies`, effective `has_table_privilege`), plus direct reads of the
client code and guard tests. The test suite could not be executed in this
sandbox (`vitest` / `@vitejs/plugin-react-swc` are not installed here), so
every claim below was confirmed by schema + source inspection instead.

| Claim | Verdict | Evidence |
|---|---|---|
| Phase 1 — `wms_packaging_types` + carriers / availability / events | **True** | all four tables exist with `packaging_class`, `lifecycle_status`, `row_version`, `tare_weight_kg` |
| Phase 2 — RPC-only writes (`wms_packaging_upsert`, `set_lifecycle`, `archive`, `set_carrier_rule`, `set_availability`) | **True** | all five functions exist, business + `inventory:write` guarded |
| Phase 2 — "client write grants revoked" | **Partly false** | `authenticated` INSERT/UPDATE revoked only on `wms_packaging_types`, `_carriers`, `_availability`. Still granted on `wms_packaging_events`, `wms_sscc_registry`, `wms_sscc_events`, `wms_gs1_config`. `anon` retains INSERT/UPDATE on **all** of them. Writes are currently denied only because RLS has SELECT-only policies — the grants contradict the ADR and rely on a second mechanism |
| Phase 3 — `suggest_packaging` (3-axis rotation fit, split, dim weight, explainable reasons) | **True** | `suggest_packaging`, `wms_packaging_fits_item` present; client seam `packagingEngine.ts` surfaces every failure code |
| Phase 3b — idempotent `assign_packaging_to_pack` | **True** | function exists, `wms_pack_cartons.tare_applied_kg` present |
| Phase 4 — GS1/SSCC server-side identity | **True** | `wms_gs1_config`, `wms_sscc_registry`, `wms_sscc_events`, `gs1_check_digit`, `wms_sscc_build/allocate/void/label_payload/mark_printed/resolve` |
| Client wiring — PackStation on the new engine | **True** | reads `wms_packaging_types`, calls `suggest_packaging` + `assign_packaging_to_pack`, mints/prints via `CartonSsccLabelButton` |
| "No `wms_carton_types` reference left" | **False (Phase 8 openly pending)** | `CartonTypes.tsx` still does client `insert` / `update` / `delete` on `wms_carton_types`; `MobilePack.tsx` still calls `suggest_carton` + `assign_carton_to_pack` |
| Guards | **Weak** | `packaging-master.test.ts` asserts *migration text*, not effective privileges; `wms-phase12.test.ts` still **enforces** the legacy carton path, so two guards now pull in opposite directions |
| Phase 5 — handling-unit unification | **Not started (as claimed)** | `wms_license_plates` has no `packaging_type_id`; `pack.carton` scan intent is declared in the union type but never registered or resolved |

### New findings the previous plan did not capture

1. **Split pack station.** Desktop PackStation uses cartonization v2; the
   mobile pack station (`MobilePack.tsx`) still uses volume-only
   `suggest_carton` and the non-idempotent `assign_carton_to_pack`. Two
   operators packing the same wave get different packaging decisions, and
   the mobile path can double-apply tare on offline replay. This is a live
   correctness defect, not just leftover legacy, and must be fixed before
   any new surface work.
2. **Privilege drift** (row above): grant hardening was incomplete and the
   guard cannot detect it because it greps SQL text.
3. **Contradictory guards**: `wms-phase12.test.ts` locks in the legacy
   contract that Phase 8 must delete.
4. **`pack.carton` scan intent is a stub** — the type exists, no resolver.

## Phase 2 — Revised phase list (resuming from the last genuinely complete milestone: Phase 4)

**Phase 4.5 — Consolidate the pack path & harden privileges (new, first).**
Repoint `MobilePack.tsx` to `suggest_packaging` + `assign_packaging_to_pack`
through the existing `packagingEngine` seam (no second client seam), so both
pack stations share one engine. Migration: revoke `INSERT, UPDATE, DELETE`
from `authenticated` **and** `anon` on `wms_packaging_events`,
`wms_sscc_registry`, `wms_sscc_events`, `wms_gs1_config`, and from `anon` on
the three master tables; keep `SELECT` for `authenticated` only. Upgrade
`packaging-master.test.ts` to assert *effective* privileges via a schema
snapshot rather than regexing migration text, and delete the legacy
assertions in `wms-phase12.test.ts` that conflict with ADR 0105.

**Phase 5 — Handling-unit unification.** `wms_license_plates.packaging_type_id`
(FK to the master, tare/cube read from it); `wms_lpn_type` retained only as a
coarse facet derived from `packaging_class`; carton seal creates/updates the
shipment handling unit with tare + cube from the master and validates carrier
admissibility; register a real `pack.carton` scan intent resolving through
`wms_resolve_sscc` so scanning a sealed carton returns its plate/shipment.

**Phase 6 — Hardware & supply consumption.** Read the scale at seal through
the existing hardware command router (`read_weight`) with manual override and
a variance flag; route the carton label per packaging class / media profile;
decrement `wms_packaging_availability` at seal and raise a replenishment
exception below the reorder point.

**Phase 7 — Packaging Master workspace (UI).** Replace `CartonTypes.tsx` and
the `/warehouse-app/cartons` nav entry with `/warehouse-app/packaging`:
TanStack Table v8 grid (faceted filters, saved views) over
`@tanstack/react-virtual` (already a dependency), master/detail split with an
inspector — dimensions and scaled proportion preview, capacity/fill bars,
carrier compatibility matrix, availability by warehouse, usage analytics from
`wms_pack_cartons`, lifecycle timeline from `wms_packaging_events` — routed
drill-down `/warehouse-app/packaging/:id`, and dedicated create/edit routes
calling the Phase 2 RPCs (no client table writes, `row_version` echoed for
optimistic concurrency). New dependency: `@tanstack/react-table` only.

**Phase 8 — Decommission legacy.** Drop `wms_carton_types`, `suggest_carton`,
`assign_carton_to_pack` and `wms_pack_cartons.carton_type_id`; remove
`CartonTypes.tsx`; regenerate types; update
`docs/architecture/WMS_MODULE_OWNERSHIP.md` and ADR 0083 (superseded note).

## Working rules

- One phase at a time; each phase ends green on `npx tsgo --noEmit` plus the
  architecture suite before the next begins.
- Hard cut, no compatibility shims (no production users).
- No new client seam duplicates `packagingEngine.ts` / `cartonSscc.ts`.
