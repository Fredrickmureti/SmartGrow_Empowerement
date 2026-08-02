## Verification result (checked in code + live DB, not against the notes)

I re-audited every claim in `.lovable/plan.md` and the receiving handoff file.

**Confirmed genuinely complete**
- Phases 1–3: typed source binding (`appointment_id`/`dock_id`/`supervisor_id` all bound on create), `wms_materialize_expected_lines`, line-grain capture, variance rollups.
- Phase 4a/4c/4d: `wms_post_receiving_session` exists and (verified in the live function body) excludes `qc_hold` lines, deducts `damaged_qty`, routes held/damaged lines to a `quarantine` location, and supports `inbound_shipment`/`asn` sources. LPN is stamped on desktop (`lpnId: activeLpn?.id`) and mobile (`p_lpn_id`). No `GoodsReceiptWizardPage` remains.
- Phase 4b: no client file calls `receive_goods_to_wms`; mobile reaches the DB only through the offline queue.
- Phase 5b/5c: lane-per-state board, `OutboxTimeline`, `ReceivingExceptionStrip` mounted on the session, resolution only via `wms_resolve_exception` with `p_row_version`, live dwell ticker, `postBlockers` disabling Post.
- Phase 6/6b, Phase 7: mobile scan-first loop with offline capture; put-away / quality-hold / quarantine labels on both mobile and the desktop grid through `PrintLabelButton` + `WMS_LABEL_KEY`, with no hand-built template keys.
- Trailer visits resolved read-only through the shared dock appointment.

**Not complete, contrary to the status file**
1. **Phase 8 is further along than claimed but still incomplete.** `architecture.receiving-line-grain.test.ts` already pins scan/transition separation, RPC-only capture and posting, label keys, LPN stamping, exception FSM, board/timeline and trailer-read-only. Missing: the base-unit invariant, and the "no direct `wms_receiving_lines` write from a component" invariant.
2. **Step 4 was never started.** Nothing in `src/` or in any RPC writes `goods_receipt_discrepancies`. The wizard was the only writer and it is gone, so discrepancies are now recorded *nowhere* on the Purchases side — the plan's intended backfill from `wms_exceptions` at post time does not exist.
3. **New defect — unit of measure is a free-text label, not a conversion.** `wms_capture_receiving_line` stores `p_uom` verbatim and adds `p_received_qty` straight onto `received_qty`; posting passes that number to `create_goods_receipt` untouched. An operator receiving 5 cases of 12 books 5 base units. The capture panels expose no packaging selector even though the packaging/multi-unit modules exist. This is a valuation-correctness bug, not cosmetics.
4. **New defect — quarantined stock is invisible to Inventory.** Posting excludes held/damaged quantity from the receipt and only stamps `staging_location_id` on the receiving line. No movement is emitted into the quarantine location, so physically-present held goods exist in no inventory ledger. Enterprise WMS receive quarantined units into a non-available location rather than not receiving them.

## Remaining work, in order

### Phase 8 — close the guard suite
Extend `src/__tests__/architecture.receiving-line-grain.test.ts` with: capture quantity is converted to base units before the RPC; no receiving component writes `wms_receiving_lines` directly (insert/update/upsert); posting is the only staging path (re-assert across the offline replay allow-list).

### Phase 11 — packaging-aware capture (base units)
- Desktop capture panel and mobile loop gain a packaging/unit selector sourced from the existing packaging catalogue for the scanned product, defaulting to the product's base unit and to the packaging encoded in a GS1/product-identifier scan when present.
- Quantity is converted to base units in one shared helper before it reaches `wms_capture_receiving_line`; the captured packaging and factor are recorded on the line for audit, and the grid shows both "3 cases" and the base-unit equivalent.
- `wms_capture_receiving_line` validates that the supplied unit resolves for the product and rejects an unknown one instead of silently storing text.

### Phase 12 — quarantine becomes real inventory
Posting emits the held/damaged quantity into the warehouse quarantine location through the existing Inventory writer (Inventory stays the only writer of quants/movements/cost layers), so quarantined units are on the books but not available for allocation. Release/scrap continues through the existing exception resolutions. Quarantine label already exists and is reused.

### Phase 13 — retire `goods_receipt_discrepancies` as a write target
At post time, backfill it from the session's `wms_exceptions` for historical continuity. No UI writes it; add a guard asserting that.

### Phase 14 — status refresh
Rewrite `.lovable/plan.md` to the state above so the next engineer inherits accurate claims.

## Technical notes
- No new tables. Changes are: two receiving RPC revisions (unit validation, quarantine movement, discrepancy backfill), one shared unit-conversion helper, capture-panel wiring on two surfaces, and guard tests.
- Domain boundaries unchanged: Inventory owns quantity/valuation, Warehouse owns execution and posts by delegation while emitting `warehouse.receiving.*` events.
- Verification after each phase: `tsgo --noEmit` plus `architecture.receiving-line-grain`, `wms-phase2`, `wms-phase4-ux`, `grn-convergence`, `label-coverage`.
