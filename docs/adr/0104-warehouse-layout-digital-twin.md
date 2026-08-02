# ADR 0104 — Warehouse layout as an operational digital twin

Status: Accepted (2026-08-02)
Extends: ADR 0064 (locations/quants), ADR 0079 (Inventory vs Warehouse split), ADR 0085 (barcode/PDF rendering ownership), ADR 0089 (label identity)

## Context

`/warehouse-app/layout` was a CRUD tree over `stock_locations`: create a
node, name it, pick a level. It exposed schema vocabulary ("Add Child",
"structure level"), showed no operational state, had no bulk authoring, no
barcode lifecycle, and no scan path. `stock_locations` already carried
`structure_level`, `barcode`, `pick_sequence`, `putaway_priority` and
capacity columns — almost all unpopulated, because nothing made them
meaningful.

## Decision

The layout surface becomes the digital twin of the building. Three
decisions carry it:

1. **Server owns the structural rules.** Nesting (zone > aisle > rack >
   shelf > bin), unique label codes per business, retire guards, the
   operational rollup (`wms_location_overview`) and bulk authoring
   (`wms_generate_locations`, including serpentine walk order) live in SQL,
   so UI, import and seed paths cannot disagree.
2. **One location resolver.** `resolve_location_identity` is the single
   tenant-gated code/barcode lookup, consumed by
   `useResolveLocationIdentity`. Ambiguity is surfaced, never guessed —
   the same contract as product identity.
3. **The UI speaks warehouse, not schema.** Every level string comes from
   `features/warehouse/locations/vocabulary.ts`. Locations are shown with
   what is in them and what work is open against them; the floor view is
   colour-coded by operational state.

Bin labels reuse the existing print pipeline (`wms.label.bin` →
`useLabelPrint` → `PrintService.printLabel`). The on-screen label preview
is geometry only — ADR 0085 keeps rasterisation server-side.

## Consequences

- `src/pages/warehouse/WarehouseLayoutPage.tsx` is deleted; no legacy path
  is maintained.
- `stock_locations` operational columns become authored data, which
  unblocks put-away suggestion, pick-path ordering and capacity checks
  without further schema work.
- Inventory remains canonical for quantity and value; this surface reads
  quants and tasks, and never writes stock.

## Addendum — label lifecycle and the operator seam (2026-08-03)

Three additions close the loop between the authored twin and the floor:

- **Table pane.** The workspace gains a third view alongside Structure and
  Floor: a virtualised, multi-select table filtered by operational state
  (holding stock, empty, busy, blocked, *no label yet*). Selection drives the
  bulk acts — mint barcodes, print labels — because labelling is a run, not a
  per-row chore. "Bins without a label" is a first-class KPI; an unlabelled
  bin can only be reached by typing, which is how mis-picks start.
- **Print → verify.** Bin-label reprints key on
  `wms.bin-label:{location}:r{revision}`, where the revision counts prior
  `print_jobs` rows for that position, so relabelling is auditable instead of
  looking like a first print on every run. `LabelVerifyDialog` then turns a
  scan walk into pass/fail and reprints the outstanding set.
- **One operator seam.** `BinScanField` replaces every
  `scan.trim().toLowerCase() === location.code` compare on the RF screens
  (put-away, pick; count matches lines on the resolved location id). It
  resolves through `resolve_location_identity` and registers the correct WMS
  scan intent, so barcode-vs-code divergence and cross-warehouse code clashes
  are handled once. Enforced by
  `src/test/architecture/wms-location-resolver-single-seam.test.ts`.

## Addendum 2 — the item leg of an RF scan (2026-08-02)

A bin scan resolved through one seam while the SKU next to it was still a
`toLowerCase()` compare is only half a scan: a case GTIN, a GS1-128 label with
lot and expiry, or an alternate identifier all read as "wrong product".

`src/features/warehouse/scanning/ProductScanField.tsx` is now the counterpart
to `BinScanField`: it runs every item scan through `useWmsIdentityGate` →
`resolve_product_identity` (ADR-0017 / ADR-0071), blocks on unknown and
ambiguous codes with scan feedback rather than a bare toast, reports the
matched packaging level, and registers the `pick.item` / `count.item` intent so
wedge, ring and paired-phone scanners feed it directly.

Consequence: `MobilePick` confirms the item by product id, and `MobileCount`
matches its count line on `(resolved location id, resolved product id)` — no
string compare survives on either leg. A third case in the guard test forbids
`sku*/item*/product*.trim().toLowerCase() ===` in `warehouse-mobile`.
