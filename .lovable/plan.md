# Warehouse Layout (WMS) — Digital Twin Roadmap

## STATUS BOARD (authoritative — update after every implementation)

**Currently active phase: Phase 4 — Location barcode lifecycle (not started).**

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Location master server-side (resolver, nesting trigger, retire guard, overview RPC, generator) | ✅ Done — migration `20260802095247` applied |
| 2 | Warehouse workspace (tree + floor map + inspector, legacy page deleted) | ✅ Done |
| 3 | Authoring: designer route, multi-tier generator, live dry-run preview, move/reparent, business language | ✅ Done |
| 4 | Barcode lifecycle: label preview, bulk print, verify mode, resolver guard test | ⏳ Next |
| 5 | Operator surfaces (`MobilePutaway` / `MobilePick` / `MobileCount`) use the location resolver | ⛔ Pending |
| 6 | Cleanup + ADR notes (0064 note, 0104 finalisation) | ⛔ Pending |

### Phase 3 — what was implemented and verified
- `useLocationMutations.ts` **rewritten**: the previous `generate` call used a signature that did not exist (`p_level/p_prefix/p_from/p_to`); it now matches the real `wms_generate_locations(p_warehouse_id, p_parent_id, p_levels jsonb, p_separator, p_code_prefix, p_serpentine, p_capacity, p_barcode_auto, p_dry_run)`. Added `preview()` (dry run — same SQL, no writes) and `move` (re-parent).
- `LocationRunBuilder.tsx` (new): multi-tier run authoring ("6 aisles → 4 racks each → 10 bins each"), snake walk order, auto label code, per-bin capacity, and a **live preview produced by the database dry run**, not a client re-implementation.
- `LayoutDesigner.tsx` (new page) at `/warehouse-app/layout/design`: full-screen, no dialogs — existing structure on the left (search + tree + "top of the warehouse" root target), run builder on the right. Route registered in `src/apps/warehouse/routes.tsx` (write-gated, not `allowReadOnly`).
- `MoveLocationDialog.tsx` (new): explicit "Move to…" picker; offers only parents whose level may legally hold this level, excludes self/descendants, offers the warehouse root where legal. DB trigger remains authority.
- `LocationBuilderDialog.tsx` reduced to a thin wrapper over `LocationRunBuilder` — one authoring implementation, no duplicate logic.
- Inspector gained the `onMove` action; workspace header gained the Layout designer link.
- Verified: `tsgo --noEmit` clean across the project.

### Known gaps carried into Phase 4
- Bin label printing exists via `BinLabelDialog` but there is **no rendered preview** of the compiled `wms.label.bin` template, no "verify labels" scan mode, and no architecture guard test forbidding direct `stock_locations` barcode queries.
- Bulk print is currently "all bins" from the header; there is no multi-select table surface yet (Phase 2's Table view was descoped — reinstate it in Phase 4 as the multi-select print source).

### Instructions for the next agent
1. **Verify before building.** Load `/warehouse-app/layout` and `/warehouse-app/layout/design`, generate a small run (e.g. 2 aisles × 2 racks × 3 bins) and confirm: dry-run preview codes match created rows, walk order is serpentine, `barcode` is stamped, the nesting trigger rejects an illegal move, and the retire guard blocks blocking a stocked bin. Re-run `tsgo --noEmit`.
2. **Then start Phase 4** (below) — barcode lifecycle end to end. Do not start Phase 5 until Phase 4 prints, previews, verifies and resolves.
3. Keep execution chronological; do not open unrelated warehouse areas.

---

## Audit findings (verified against code + live database)


**Data model — solid foundation, unused.** `stock_locations` already carries everything an enterprise location master needs: `warehouse_id`, self-referencing `parent_location_id`, `code`, `name`, `location_type`, `usage`, `structure_level`, `barcode`, `capacity_max_units`, `capacity_max_weight`, `pick_sequence`, `putaway_priority`, `is_receiving_staging`, `is_putaway_target`, `is_active`, `is_default`. `stock_quants` keys stock at `(product, location, lot)`. ADR 0064 and ADR 0079 define the intended split correctly: Inventory owns quantity/value, Warehouse owns physical execution.

Live state: 2 warehouses, **5 locations — all auto-seeded defaults, zero with a `structure_level`**, 1 quant row, 0 tasks, 0 LPNs. So the layout module has never been used to author a real warehouse. This is effectively greenfield: no migration risk, no legacy data to preserve.

**The layout page is a CRUD tree, and a thin one.** `src/pages/warehouse/WarehouseLayoutPage.tsx` (402 lines) is the entire module. It does one thing: fetch all rows for a warehouse, build an in-memory tree, render nested `<li>`s, and offer one modal with 5 fields. Concretely missing:
- No edit, no deactivate, no delete, no move/reparent, no bulk creation. A 40-aisle warehouse means ~2,000 modal submissions.
- No search, no filter, no virtualization — it renders every node.
- No validation of level nesting (the level dropdown lets you put a Zone under a Bin), no uniqueness feedback, no code-scheme generation.
- `capacity_max_units`, `capacity_max_weight`, `putaway_priority`, `is_putaway_target`, `is_receiving_staging`, `location_type` are **never written by the UI** — the columns exist but the only authoring surface can't set them. Every created row is hardcoded `location_type: 'internal'`.
- Zero operational data: no stock counts, no occupancy, no tasks, no activity. The page cannot answer "which bins have stock", which is the first question anyone asks.
- Language is developer language: "Add child", "Level", "structure_level" badges.

**Barcode lifecycle is broken at the location end.** `barcode` is a free-text field an operator types by hand. There is no generation, no uniqueness constraint enforced in the UI, no verification, and critically **no resolver**: `resolve_product_identity` handles products (see the product-identification memory), and `useWmsIdentityGate` gates product scans — but nothing resolves a *location* barcode to a `stock_locations` row. `wmsScanIntent` declares `putaway.bin`, `pick.location`, `count.location` intents, yet no shared hook turns those scans into a location. Mobile put-away's header comment says "scan bin barcode to confirm destination" while the file never queries `stock_locations`.

**Label printing exists but is unreachable for bins.** The print pipeline is mature (`PrintService`, `labelCompiler`, ZPL/PDF engines, `PrintPreviewDialog`, media geometry, reprint audit). A `wms.label.bin` ZPL template (50×30mm) is seeded by migration `20260729060551`. But `WMS_LABEL_KEY.BIN` is referenced in exactly one file — its own declaration. **No UI anywhere prints a location label.** So authored bins can never be physically labelled, which means they can never be scanned, which means the hierarchy has no operational effect.

**Hardware and mobile are further along than layout.** `ScannerPairingButton` + `/scan/$token` already give phone-as-scanner pairing; `scanRouter`/`scanBus` handle USB/Bluetooth HID and camera (`@zxing`); `MobileWarehouseLayout` has an offline queue, drain loop, and audio/haptic scan feedback. Eight `/wm/*` operator screens exist. The gap is not hardware — it is that none of them can resolve or confirm a *location*.

**Verdict:** the data model is right and should be kept; the authoring/visualization layer is a placeholder and should be replaced outright, not extended.

---

## Plan

### Phase 1 — Location master: server-side truth
One migration adding what the UI cannot express today:
- `resolve_location_identity(business, code, warehouse)` — tenant-gated SQL resolver mirroring the product resolver's contract (`match_count`, normalized `upper(btrim())` codes, `anon` revoked). Returns the location row plus its ancestor path.
- Partial unique index on `(business_id, upper(btrim(barcode)))` where barcode is not null.
- Trigger enforcing legal nesting (`zone > aisle > rack > shelf > bin`; `dock`/`staging_in`/`staging_out` are zone-level) and blocking deactivation/deletion of a location holding quants or open tasks.
- `wms_location_overview(warehouse_id)` — one set-returning function feeding the whole workspace: per-location on-hand units, distinct SKUs, lot count, reserved units, occupancy % against `capacity_max_units`, open task counts by type, blocked/empty/full state, and last movement timestamp. Rolled up the tree so a Zone shows its subtree totals.
- `wms_generate_locations(...)` — bulk generator: given a zone, aisle range, racks per aisle, shelves per rack, bins per shelf, and a code pattern, it creates the whole subtree in one transaction with serpentine or straight `pick_sequence` numbering.

### Phase 2 — The Warehouse workspace (replaces the current page)
`/warehouse-app/layout` becomes a three-pane operational workspace, not a form host:

```text
┌────────────┬──────────────────────────────┬──────────────┐
│ Structure  │  Map / Grid / Table  (tabs)  │  Inspector   │
│ (virtual   │                              │  selected    │
│  tree,     │  Zone A  ▓▓▓▓░░  62% 1,240u  │  location:   │
│  search,   │  Zone B  ▓▓▓▓▓▓  98% blocked │  stock, tasks│
│  filters)  │  Dock 1  ○ idle              │  capacity,   │
│            │                              │  barcode,    │
│            │                              │  activity    │
└────────────┴──────────────────────────────┴──────────────┘
```

- **Structure pane** — virtualized tree (`@tanstack/react-virtual`, already a dependency) with instant search by code/name/barcode, filters (has stock / empty / blocked / needs count / putaway targets), and status dots. Handles 500k nodes because only visible rows mount.
- **Map view** — the primary view. Aisles laid out as columns, racks/shelves as cells, colour-encoded by a switchable metric: occupancy heatmap, SKU density, activity in last 24h, or exception state. Click drills down (Warehouse → Zone → Aisle → Rack) with a breadcrumb back out. Built from the design-system tokens; no third-party floor-plan library — the drill-down grid is deterministic from the hierarchy and costs nothing to maintain.
- **Grid view** — dense card view for a single parent's children, for supervisors scanning one aisle.
- **Table view** — the power surface: virtualized, sortable, multi-select, column-configurable, CSV export.
- **Inspector** — selected location: identity, ancestor path, capacity + occupancy gauge, on-hand by product/lot, reserved, open tasks, recent movements, barcode with print action. All progressive: closed by default, opens on selection.
- **Live** — subscribes through the existing `useWmsRealtimeSync` so quants and task changes repaint tiles without a refresh.

### Phase 3 — Authoring as a workspace, not a modal
- **Layout Designer** — a dedicated focused route (`/warehouse-app/layout/design`), full-screen, no dialogs. Left: structure being built. Right: the bulk generator with a **live preview of the codes it will create** before you commit. Serpentine/straight pick-path picker with a visual path overlay.
- **Inline edit** — rename, recode, capacity, putaway priority, pick sequence, activate/deactivate edited in the Inspector, saved in place.
- **Move / reparent** — explicit "Move to…" action with an ancestor picker (guarded by the nesting trigger). No drag-and-drop as the only path — supervisors on touch devices need a deterministic control.
- **Business language throughout** — "Add child" becomes "Add aisles to this zone" / "Add bins to this shelf", driven by the parent's level. "Level" becomes the concrete noun. Location types are described ("Quarantine — stock here is not available to pick"), not enum-named.

### Phase 4 — Location barcode lifecycle, end to end
- **Generate**: on creation, barcode defaults to the location code (Code 128) — checkable per warehouse in the designer, with an optional prefix so location scans are distinguishable from GTINs at a glance.
- **Preview**: a Location Label preview that renders the seeded `wms.label.bin` template through the existing compiler to a PDF surface in `PrintPreviewDialog`. ZPL/EPL stay authoritative for the printer — the preview renders the compiled geometry, it does not become a second render path (respects ADR-0085).
- **Print**: single-label print from the Inspector; **bulk print** from the table's multi-select ("Print 240 bin labels"), routed through `printWmsLabel` with the existing printer/media selection and reprint audit trail.
- **Verify**: a "Verify labels" mode — scan a printed label, the workspace flashes and selects that location, confirming the physical label maps to the digital one.
- **Resolve**: `useResolveLocationIdentity` hook over the Phase 1 RPC, mirroring the product gate's contract — `ambiguous`/`not_found` **blocks** and emits an error to `scanFeedbackBus`. This becomes the single seam; a guard test in `src/test/architecture/` forbids any surface from querying `stock_locations` by barcode directly, matching the existing identity-resolver guard.
- **Scan-aware workspace**: the layout page registers `pick.location` intent when its scan mode is armed, with a visible "Scanning armed — scan a location" affordance. Scanning jumps the tree, map, and inspector to that location.

### Phase 5 — Wire the operator surfaces to real locations
`MobilePutaway`, `MobilePick`, `MobileCount` currently claim to scan bins but do not. Each gets the new resolver hook so scanning a bin label confirms the destination/source against the task, with the existing audio/haptic feedback and offline queue. This closes the loop: authored bin → printed label → scanned by an operator → quant lands in a real bin rather than the warehouse default.

### Phase 6 — Remove the old implementation
`WarehouseLayoutPage.tsx` is deleted, not deprecated. One authoritative layout architecture, per ADR 0079. A new ADR (0104) records the workspace model, the location-resolver seam, and the label lifecycle; `docs/adr/0064` gets a note that Phase 2 location stamping is now unblocked.

### Technical notes
- No new heavyweight dependencies. `@tanstack/react-virtual`, `framer-motion`, `recharts`, `@zxing`, and the print pipeline are all already installed and are sufficient. A floor-plan/graph library would add a coordinate model the warehouse data does not have and would be maintained for one screen.
- All colour/state encoding uses design-system tokens; no hardcoded colour utilities, so the heatmap themes correctly.
- Every new table-less RPC is `security definer` with tenant gating and `anon` revoked, matching the platform's existing pattern.
- Guard tests: nesting rules, resolver single-seam, label-key parity with the SQL seeder, and "no direct `stock_locations` barcode query".

### Scope boundary
Inventory-owned tables are untouched. No cost or valuation logic changes. Quant/movement writers are not rewritten in this work — Phase 5 only supplies the resolved `location_id` those writers already accept.
