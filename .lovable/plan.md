
# Warehouse Layout (WMS) — verification result and remaining work

## Phase 1 — What I verified in the codebase

I checked every claim on the status board in `.lovable/plan.md` against the actual files and migrations.

**Genuinely complete (confirmed):**
- **Phase 1 (server-side location master).** Migration `20260802095247` exists and contains `resolve_location_identity`, `wms_location_overview`, and `wms_generate_locations`. Typed and consumed from `src/features/warehouse/locations/`.
- **Phase 2 (workspace replaces CRUD page).** `src/pages/warehouse/WarehouseLayoutPage.tsx` is gone; `WarehouseLayoutWorkspace.tsx` (tree + floor map + inspector + occupancy) is the single surface. ADR 0104 records the decision.
- **Phase 3 (authoring).** `LayoutDesigner.tsx`, `LocationRunBuilder.tsx` (multi-tier run with database dry-run preview), `MoveLocationDialog.tsx`, and business-language `vocabulary.ts` all exist; `LocationBuilderDialog` is a thin wrapper, so there is one authoring implementation.

**Claimed "next / not started" but actually partly shipped:**
- Bin labels: `BinLabelDialog.tsx` already does a geometry preview and bulk print through `useLabelPrint` → `PrintService`, with copies and a missing-printer CTA.
- `useResolveLocationIdentity` exists and the workspace already arms a scan intent that jumps the tree/map/inspector to the scanned location.

**Genuinely still missing (this is the real remaining scope):**
1. No **table view with multi-select** — bulk print is "everything under the selection", so you cannot pick 240 specific bins.
2. No **verify-labels mode** — no way to walk the aisle scanning printed labels and confirm each maps to the right digital location, with a visible pass/fail trail.
3. No **guard test** forbidding surfaces from querying `stock_locations` by barcode directly, so the resolver is not yet an enforced single seam.
4. **Operator surfaces still fake location scanning.** `MobilePutaway`, `MobilePick`, and `MobileCount` compare a typed string against `location.code` with `toLowerCase()`. They never call the resolver, so a printed *barcode* (as opposed to the code) fails, ambiguity is silently mis-handled, and there is no hardware scan-bus intent or scan feedback. This is the biggest correctness gap in the module.
5. ADR 0064 has no note that Phase 2 location stamping is unblocked; the roadmap file's status board is stale.

## Phase 2 — Additions I am appending to the plan

Found by reading the surrounding architecture, not in the prior plan:
- **Label reprint provenance.** `idempotencyKey` uses `Date.now()`, so every reprint is a new key and the reprint audit cannot answer "how many times was bin A-01-02 relabelled". Key on `(location_id, revision)` instead.
- **Barcode default is not guaranteed.** The generator accepts `p_barcode_auto`, but locations created one-off from the inspector can end up with `barcode = null`; those rows silently drop out of `printable` in the label dialog and can never be scanned. Needs a visible "unlabelled locations" count and a backfill action.
- **Count screen matches on two loose strings** — bin + SKU — with no resolver on either side; it should route both through the existing product identity gate and the new location gate.

## Phase 3 — Execution order

### 4a. Table view + multi-select (workspace third tab)
Virtualized table of locations for the selected subtree: code, path, level, on-hand, occupancy, open tasks, barcode present. Row checkboxes plus "select all in view"; selection feeds `BinLabelDialog`, so "Print 240 bin labels" is a real action. Column filters reuse the existing overview rollup — no new query.

### 4b. Label lifecycle hardening
- Deterministic reprint key `wms.bin-label:{id}:{n}` derived from prior print count, restoring the audit trail.
- "Unlabelled" filter chip + bulk "Assign barcodes from code" mutation for locations missing a barcode.
- Preview stays geometry-only (ADR 0085 keeps rasterisation server-side).

### 4c. Verify mode
A "Verify labels" toggle in the workspace: armed scanning switches from *navigate* to *verify*. Each scan resolves through `resolve_location_identity`, records pass / wrong-label / unknown in a session list with audio+haptic feedback via the existing `scanFeedbackBus`, and offers "reprint the failures" straight into the label dialog.

### 4d. Resolver guard test
`src/test/architecture/wms-location-resolver-single-seam.test.ts`: no file outside `useResolveLocationIdentity.ts` may query `stock_locations` filtered by `barcode`; mirrors the existing product-identity guard.

### 5. Operator surfaces onto the real resolver
`MobilePutaway`, `MobilePick`, `MobileCount` each: replace the string compare with `useResolveLocationIdentity`; accept code *or* barcode; block on `ambiguous` / `not_found` with the typed error toast; register the correct `wmsScanIntent` (`putaway.bin`, `pick.location`, `count.location`) so hardware/Bluetooth/camera/paired-phone scans feed them without focusing an input; keep the offline queue and scan feedback intact. `MobileCount` additionally routes the SKU through the existing product identity gate.

### 6. Cleanup and records
- Append a note to ADR 0064 that Phase 2 location stamping is unblocked.
- Extend ADR 0104 with the label lifecycle and verify contract.
- Rewrite the `.lovable/plan.md` status board to reflect reality (Phases 1–3 done, 4 partial, evidence per row).
- Green gate: full `wms-*` guard suite plus `tsgo --noEmit`, output recorded in the plan file.

## Technical notes
- No new dependencies: `@tanstack/react-virtual`, the print pipeline, `scanRouter`/`scanBus`, and `@zxing` are all present and sufficient.
- No Inventory-owned table or valuation logic is touched; Phase 5 only supplies the resolved `location_id` that existing writers already accept.
- All state colour encoding uses design-system tokens.
