# Packaging & Carton Catalogue — Architecture Audit

**Date:** 2026-08-02
**Scope:** Carton Catalogue (`/warehouse-app/cartons`) as the packaging
foundation of the WMS: master data, cartonization, packing workflow,
handling units, identification, printing, scanning, weighing, shipping.
**Outcome:** ADR 0105 (Packaging Master) + an 8-phase implementation plan.

---

## 1. What a Carton Catalogue is (first principles)

In SAP EWM, Oracle WMS, Manhattan, Blue Yonder and D365 SCM the
equivalent object is **packaging material master data** (EWM: *packaging
material* + *packaging specification*; D365: *container types* +
*packing profiles*; Manhattan: *package type* / *carton group*).

It is **not** inventory, **not** product packaging (pack-quantity /
UoM), and **not** the handling unit itself. It is the catalogue of
**empty physical containers the warehouse owns**, describing:

- *geometry* — inner and outer dimensions, cube, fill limits;
- *capability* — max weight, stackability, nesting, temperature band,
  hazmat rating, returnable/reusable;
- *commercial rules* — cost per unit, dimensional-weight divisor,
  carrier/service admissibility, surcharges;
- *availability* — which warehouses stock it, how many are left.

Consumers (business events, not tables):

| Event | Consumption |
|---|---|
| Pack station opens a carton | cartonization proposes a packaging type |
| Carton sealed | tare + cube + cost stamped onto the handling unit |
| Handling unit created | packaging type becomes the HU's physical identity |
| Label printed | packaging class selects media profile / label template |
| Shipment rated | dim weight + carrier admissibility |
| 3PL billing | carton cost as a billable activity |
| Replenishment | packaging supply on-hand per warehouse |

Owner: **Warehouse master data** (not Inventory — the product side owns
`product_packaging` / UoM, which is a *quantity* concept).

---

## 2. Current architecture (verified)

| Concern | Current state | Source |
|---|---|---|
| Master table | `wms_carton_types`: `code, name, length_cm, width_cm, height_cm, max_weight_kg, tare_weight_kg, cost, is_active, notes` | `20260717233348` |
| Access | business RLS + `inventory:write`, **direct client CRUD** | same |
| Cartonization | `suggest_carton(business_id, product_ids[], quantities[])` — sum of product cube vs carton cube, plus max weight | same |
| Pack stamping | `assign_carton_to_pack(carton_id, carton_type_id)` copies L/W/H, adds tare | same |
| Pack cartons | `wms_pack_cartons` + `carton_type_id` FK `ON DELETE SET NULL` | `20260717200738`, `20260717233348` |
| Handling units | `wms_lpn_type` enum `('pallet','carton','tote','other')`; **no** FK to the catalogue | `20260717183316`, ADR 0102 |
| Labels | `WMS_LABEL_KEY = lpn \| bin \| shipping \| packing_slip` — no carton label | `src/features/warehouse/labels/wmsLabels.ts` |
| SSCC | parsed inbound only (AI `00`); never minted | `src/lib/gs1/aiTable.ts` |
| Weighing | `SerialScaleDriver.read_weight` exists; pack weight typed by hand | `electron/hardware/drivers/`, `PackStation.tsx` |
| Scanning | scan-intent registry exists; no `pack.carton` intent | `src/features/warehouse/scanning/wmsScanIntent.ts` |
| Carriers | `public.carriers` exists; no packaging compatibility | `20260516175315` |
| UI | 203-line shadcn table + create dialog; no edit/search/detail | `src/pages/warehouse/CartonTypes.tsx` |

### Strengths

- Business/branch scoping and permission gating are correct and uniform.
- The *decision* (which carton) already lives server-side in an RPC —
  the right boundary, just an inadequate algorithm.
- The catalogue is already referenced from the pack event ledger.
- The handling-unit layer around it (ADR 0102) is genuinely
  enterprise-grade: quants on plates, RPC-only mutations, event ledger,
  FSM edge table, server-minted codes.

### Weaknesses

1. **Volume-only fit is unsafe.** A 200 cm rod "fits" a 30 cm carton
   because only cube is compared. No per-axis fit, no rotation, no fill
   cap, no multi-carton split. Any missing product dimension returns
   `NULL`, silently degrading to operator guessing.
2. **Cartons only — not a packaging master.** No packaging class
   (envelope, tube, crate, pallet, tote, insulated, drum, bag), no
   inner-vs-outer dimensions, no material, no dim-weight divisor, no
   hazmat/UN rating, no temperature band, no returnable flag, no
   stackability/nesting (ti/hi), no carrier-specific packaging, no
   per-warehouse availability or supply stock.
3. **Client-owned master-data writes.** Browser `insert`/`update`/
   `delete`: no `row_version`, no audit ledger, no outbox event, and a
   hard delete on a row referenced by shipping history.
4. **Two disjoint type vocabularies.** `wms_lpn_type` enum vs the
   catalogue: a "carton" plate cannot say *which* carton it is, so tare,
   cube and carrier rules never reach the shipment.
5. **Identification lifecycle missing.** No SSCC minting, no carton
   label template, no reprint-with-reason, no carton scan intent.
6. **`assign_carton_to_pack` is not idempotent** — repeated calls add
   tare weight again, corrupting shipping weight (reachable via the
   offline scan replay path).
7. **UX is a CRUD table** — no capacity/fill visualisation, no usage
   analytics, no compatibility view, no lifecycle, no drill-down.

---

## 3. Business-event trace

```text
Sales order → picking complete → pack station
  → suggested carton        WEAK    (volume-only, NULL on missing dims)
  → worker confirms         OK      (assign_carton_to_pack)
  → carton scanned          MISSING (no carton identity, no scan intent)
  → shipment packed         OK      (open/assign/seal/complete RPCs)
  → weight captured         PARTIAL (manual keyboard entry only)
  → shipping label printed  OK      (wms.label.shipping)
  → license plate assigned  PARTIAL (plate exists, no packaging identity)
  → carrier label printed   MISSING (no carrier admissibility/rating)
  → dispatch                OK      (Phase 5 dispatch path)
```

---

## 4. Target architecture

```text
Packaging Master (wms_packaging_types)
  ├─► Cartonization engine  (per-axis fit, ranking, multi-carton split)
  ├─► Handling units        (wms_license_plates.packaging_type_id)
  ├─► Identification        (SSCC mint → carton label → scan intent)
  ├─► Carrier compatibility (wms_packaging_carriers)
  └─► Supply availability   (wms_packaging_availability, consumed at seal)
```

Hard cut: `wms_carton_types` is migrated into `wms_packaging_types` and
dropped. No compatibility shim (no production users).

Phases: (0) docs, (1) data model, (2) RPC write layer + audit/events,
(3) cartonization v2, (4) identification/SSCC, (5) handling-unit
unification, (6) hardware (scale/printer/supply), (7) operational UX
workspace, (8) guards + docs. Tracked in `.lovable/plan.md`.
