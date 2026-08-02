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
