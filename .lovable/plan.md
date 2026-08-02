# License Plate (LPN) Architecture Audit — Findings & Rebuild Plan

## What an LPN must be

A License Plate is the **identity of a physical handling unit** (pallet, carton, tote, cage,
returnable container). Enterprise WMS platforms treat it as an inventory-bearing container:
stock is held *on the plate*, the plate is held *in a bin*, and moving the plate moves every
unit inside it in one transaction. Operators address plates, never quant rows. The plate is
born at receiving (or at packing), is labelled, scanned at every touch, nests inside parent
plates, splits and merges, ships, returns, and is finally retired — each step a business event.

## Audit result: the current module cannot support that

Verified against the schema, migrations, and both pages:

1. **No contents model.** There is no LPN-contents table. `stock_quants` has `location_id`,
   `lot_number`, `package_id` — and `package_id` is a foreign key to `product_packaging`
   (a box/case UoM), not to a plate. The plate therefore holds nothing.
2. **The detail page's Contents panel queries the wrong domain.** It reads `stock_quants`
   filtered by `package_id = <lpn id>`; that column can never contain a plate id, so the
   panel is permanently empty by construction.
3. **Moving a plate does not move inventory.** `move_lpn` only rewrites
   `current_location_id` on the plate row. No quant relocation, no `stock_movements` row.
   Physical stock and the ledger silently diverge on every move.
4. **Lifecycle is CRUD, not events.** Creation is a raw client-side `insert` with a random
   code minted in the browser (no sequence, no SSCC/GS1). The status enum has 16 values;
   the UI models 4 and mislabels "Retire" as `voided`. There is no split, merge, pack,
   unpack, nest, unnest or return operation anywhere — `parent_lpn_id` exists as a column
   with no operation behind it.
5. **Scanning is absent from the module.** The WMS scan-intent registry already supports
   `receiving.lpn`, `putaway.lpn`, `load.lpn`, `qc.lpn`, but neither plate page subscribes.
   An operator cannot scan a plate to find or act on it.
6. **Printing is on the right platform but blind.** `printWmsLabel` → `PrintService` is
   correct and stays. There is no preview, no reprint-with-reason, no damaged-label replace,
   no bulk label run, and the print call passes an empty warehouse name.
7. **The workspace answers none of the operational questions.** No count of active plates,
   no location context, no contents, no last-touch operator, no timeline, no row actions,
   no virtualisation at scale.

Conclusion: the plate is currently a labelled row, not a handling unit. Rebuild the domain,
then rebuild the workspace on top of it.

## Plan

### 1. Domain: make plates inventory-bearing

New migration (grants, then RLS, then policies on every table):

- `wms_lpn_contents` — `(lpn_id, product_id, lot_number, serial_number, quantity, uom,
  packaging_id, received_at)`, business/branch scoped, unique on the natural key. The
  authoritative statement of what is on a plate.
- `wms_lpn_movements` — append-only per-plate history: from/to location, from/to parent,
  operation kind, operator, task/reference, timestamp. Powers the timeline and "who touched
  it last" without scanning the global outbox.
- Extend `wms_license_plates` with `container_type_id` (link to the existing carton
  catalogue), `tare_weight`, `gross_weight`, `is_returnable`, `retired_at`, `retired_reason`,
  `last_moved_at`, `last_moved_by`.
- Code generation moves server-side: a per-business sequence with an SSCC-compatible format,
  replacing the browser's random code.

### 2. Domain: lifecycle as first-class operations

One RPC per business event, all `SECURITY DEFINER`, all guarded on `row_version`, all
emitting through the existing outbox trigger fabric:

- `wms_lpn_create` (receiving, packing, ad-hoc), `wms_lpn_add_contents`,
  `wms_lpn_remove_contents`
- `wms_lpn_move` — **replaces** `move_lpn`: relocates the plate, relocates every quant it
  holds, writes `stock_movements` rows, cascades to nested child plates, one transaction
- `wms_lpn_split` (move a subset of contents onto a new plate), `wms_lpn_merge`,
  `wms_lpn_nest` / `wms_lpn_unnest`
- `wms_lpn_seal`, `wms_lpn_dispatch`, `wms_lpn_receive_return`, `wms_lpn_retire`
- Status transitions enforced by an explicit FSM table, so illegal jumps are rejected in the
  database rather than by UI conditionals.

### 3. Workspace UI (replaces both current pages)

`/warehouse-app/plates` becomes an operational console:

- Header KPI strip: active plates, in transit, unlocated, sealed awaiting dispatch,
  quarantined.
- A persistent **scan bar** wired to `useWmsScanIntent` — scan a plate code anywhere in the
  module to jump straight to it. GS1/SSCC labels parse through the existing `interpretScan`.
- Virtualised data grid (TanStack Virtual over the existing table primitives) with faceted
  filters, saved views, and row-level quick actions (move, print, split, merge, retire).
- Warehouse context rendered as the full path Warehouse → Zone → Aisle → Rack → Bin, not a
  bare code.
- Multi-select for bulk move, bulk label print, bulk retire.

`/warehouse-app/plates/:id` becomes a handling-unit cockpit:

- Identity header: code, large scannable barcode, type, container, status chip, weights.
- Nesting tree (parent + children) with nest / unnest actions.
- Contents table from `wms_lpn_contents` (product, lot, serial, qty, reserved).
- Location card with the full hierarchy path and putaway suggestions.
- Timeline from `wms_lpn_movements`, each entry naming operator and reference document.
- Action rail: Move, Split, Merge, Seal, Dispatch, Return, Retire, Print / Reprint — each
  enabled strictly by the FSM's allowed transitions.

### 4. Scanning

Every plate surface declares its intent through the existing registry — no new scanning
stack. Keyboard-wedge scanners, Zebra/Honeywell handhelds, Bluetooth scanners and the mobile
camera path all already terminate in `scanBus`/`scanRouter`, so the module gains all of them
by subscribing. A mobile plate lookup screen joins the existing `warehouse-mobile` set so a
forklift operator can scan → see contents → move.

### 5. Printing

Stays on the enterprise print platform (`printWmsLabel` → `PrintService`). Added:

- **Preview before print** — compile the `wms.label.lpn` template through the existing
  `labelCompiler` and render it in the shared preview dialog: Generate → Preview → Validate
  → Print, with printer selection resolved by the existing policy layer.
- Reprint with a reason code (damaged / lost / relabel), recorded against the plate.
- Bulk label runs from the grid selection.
- Correct variable binding (warehouse name, full location path, contents summary, GS1 code).

### 6. Deletions (no legacy left behind)

- Delete `move_lpn` (RPC and all call sites, including the putaway task RPC, which repoints
  to `wms_lpn_move`).
- Delete the `stock_quants.package_id` contents query and the client-side code generator.
- Replace `LicensePlates.tsx` and `LicensePlateView.tsx` wholesale; the new module lives
  under `src/features/warehouse/lpn/` (hooks, operations, components) with thin route pages.
- No compatibility shims, no dual paths.

### 7. Guards

New ADR (`0102-license-plate-handling-units`) plus an architecture test pinning: contents and
movement tables exist; no surface writes `wms_license_plates` directly; `move_lpn` is gone;
plate surfaces subscribe to a scan intent; printing goes only through `printWmsLabel`.

## Technical notes

Migrations follow the grant → RLS → policy order. All RPCs re-check
`user_can_access_business` and `inventory:write`. Events continue to flow through the
existing `_wms_emit_event` trigger fabric so the `warehouse.lpn.*` topics stay in the
catalog. Inventory writes reuse `stock_movements`, keeping the canonical ledger (ADR 0079)
the single source of truth for quantity and cost.

Note: the dev server currently fails to boot for reasons unrelated to this module (a Tailwind
/ PostCSS plugin resolution error and a `JSX` namespace type error in
`useScanFeedback.tsx`). Those are fixed first, in build mode, before this work starts.