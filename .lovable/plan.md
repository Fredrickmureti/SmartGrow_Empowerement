## Verification result (what I actually confirmed in the code)

Claims in `.lovable/plan.md` were checked against the codebase, not taken at face value.

**Genuinely done (verified):**
- Phase 1–3: typed source-doc binding, expected-line materialisation, line-grain capture through `wms_capture_receiving_line`, variance rollups (`useReceivingLines.ts`, `ReceivingSessionWorkspace.tsx`).
- Phase 4a/4c: posting via `wms_post_receiving_session`, LPN stamped on capture (`useReceivingLpn.ts`).
- Phase 4d GRN convergence: `GoodsReceiptWizardPage` and `complete_goods_receipt_atomic` are absent from `src/`; guard `grn-convergence.test.ts` exists.
- Phase 5b: lane board + `OutboxTimeline`.
- Phase 6 base **and 6b**: `MobileReceiveSession.tsx` already routes capture through `enqueue("wms_capture_receiving_line", …)` — the offline queue the plan lists as pending is in fact implemented. Plan status is stale here.
- Scanner presence: `ScanStatusChip` is rendered on both the session list and the workspace.

**Claimed but NOT true — Phase 4b is leaking:**
`src/pages/warehouse-mobile/MobileReceive.tsx` still stages a receipt after the fact via `enqueue("receive_goods_to_wms", …)`, and it is still routed at `/wm/receive/:id`. The guard in `wms-phase2.test.ts` only matches `supabase.rpc("receive_goods_to_wms")`, so the offline-queue call slips past it. This is a live second staging path that violates invariant 3.

**Genuinely pending:**
- Phase 5c entirely — no exception strip, no live unload timer, no pre-post blocking explanation in the workspace (`wms_exceptions` is not referenced by any receiving file).
- Phase 7 partial — `WMS_LABEL_KEY` gained `PUTAWAY`/`QUALITY_HOLD`/`QUARANTINE`, and `MobileReceive` prints a put-away label, but the desktop workspace prints nothing and no receiving surface calls `printWmsLabel` (only `lpnLabels.ts` does).
- Phase 8 guards not written.

---

## Plan

### Step 0 — Close the Phase 4b leak (correctness first)
- Delete `MobileReceive.tsx` and its `/wm/receive/:id` route; redirect any inbound link to the session loop (`/wm/receiving/:id`), reached from the receipt's session.
- Move its put-away label action into the surviving mobile session loop.
- Strengthen the guard: `wms-phase2.test.ts` must reject `receive_goods_to_wms` reached through **any** call shape, including `enqueue(...)` and the offline replay allow-list.
- Confirm the offline queue's server-side replay allow-list no longer accepts that RPC name from clients.

### Step 1 — Phase 5c: session detail rail hardening
- **Header rail** (always visible in `ReceivingSessionWorkspace`): trailer/carrier, dock, appointment window, supervisor, operator, and a live unload timer derived from the session start / trailer-visit arrival (read-only from yard data — receiving never writes it).
- **Exception strip**: query open `wms_exceptions` for the session, grouped by type, with typed resolution actions through the existing `wms_resolve_exception` RPC (accept overage, short-close, damage claim, QC-hold release). Row-version optimistic concurrency preserved; no direct `state` writes.
- **Pre-post blocking clarity**: compute and display why posting is unavailable (unmatched/unresolved lines, all quantity held, open blocking exceptions) *before* the operator clicks Post; disable Post with the reason attached rather than failing in a toast.

### Step 2 — Phase 7: finish the label seam
- Route every receiving print through `printWmsLabel`: put-away label on staged lines, quality-hold label when a line is flagged held, quarantine label when posting routes units to quarantine.
- Add label actions to the desktop workspace line grid and the mobile session loop; reprints flagged `isReprint`.
- Ensure no receiving surface constructs a `templateKey` directly.

### Step 3 — Phase 8: guards
Architecture tests pinning:
- no session-level scan transition (`wms_transition_receiving` never called from a scan handler);
- capture only via the RPC, in base units;
- labels on receiving surfaces only via `printWmsLabel`/`WMS_LABEL_KEY`;
- one staging path (Step 0's strengthened check);
- exception resolution only via `wms_resolve_exception`.

### Step 4 — Scheduled follow-ups (previously "unscheduled")
- **Discrepancy duplication**: `goods_receipt_discrepancies` and `wms_exceptions` model the same fact. Since the wizard was the only writer, retire the Purchases table as a write target — posting backfills it from `wms_exceptions` for historical continuity, and no UI writes it.
- **`source_doc_type` typing**: add a DB check/enum limiting it to `purchase_order` and `inbound_shipment`, the only reachable values.

### Step 5 — Refresh `.lovable/plan.md`
Correct the stale entries (6b already shipped, 4b was not complete), and record each milestone as it lands.

## Technical notes
- No new tables. `wms_exceptions`, `wms_resolve_exception`, `wms_post_receiving_session` and the label templates all exist; work is frontend wiring plus one small migration for the `source_doc_type` constraint and the discrepancy backfill.
- Inventory remains the only writer of quants/movements/cost layers; WMS continues to post by delegation and emit `warehouse.receiving.*` events.
- Verification after each step: `tsgo --noEmit` plus the receiving architecture test suite.
