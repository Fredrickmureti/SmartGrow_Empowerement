# Receiving Subsystem — Enterprise Roadmap Status

Authoritative status of the Warehouse Receiving subsystem rebuild.
Source design: `.lovable/plan/receiving-subsystem-architecture-audit-target-design-2026-08-02.md`
Verification record: `.lovable/plan/receiving-subsystem-verification-result-remaining-phases-2026-08-02.md`

Architectural invariants (must never regress):

1. One capture path — the WMS receiving session. No second receiving UI.
2. One line of record — `wms_receiving_lines`, written only through
   `wms_capture_receiving_line` (base units, idempotent on `client_scan_id`).
3. One posting path — `wms_post_receiving_session`, which delegates to the
   sanctioned GRN/inventory RPCs, quarantines held/damaged units, stages the
   rest, then advances the session.
4. Receiving never writes yard/appointment data; it reads it.
5. Every invariant above is pinned by an architecture test.

---

## Completed and verified

| Phase | Scope | Evidence |
| --- | --- | --- |
| 1 | Typed source-document binding, appointment/dock/supervisor on create, expected lines materialised | `ReceivingSessions.tsx`, `wms_materialize_expected_lines` |
| 1 (remainder) | Trailer-visit context (carrier, trailer, driver, seals, dwell) read-only via appointment | `useReceivingTrailerVisits.ts`, board + workspace strips |
| 2 | Line-grain capture via `wms_capture_receiving_line` (qty, lot, serial, expiry); session state derived from line progress | `useReceivingLines.ts`, workspace grid |
| 3 | Derived shortage/overage/unexpected/damage + `wms_exceptions` raising | variance rollup views, `wms_flag_receiving_variances` |
| 4a | Posting hardened: held/damaged excluded from the ledger and routed to a `quarantine` location; ASN (`inbound_shipment`) posting supported; stale 12-arg capture overload dropped | migration 2026-08-02 |
| 4b | Single sanctioned staging path — `ReceiveToWMSDialog` deleted, no client calls `receive_goods_to_wms` | `wms-phase2.test.ts` |
| 4c | License-plate binding on desktop and mobile capture (`p_lpn_id` stamped) | `useReceivingLpn.ts`, `MobileReceiveSession.tsx` |
| 4d | **GRN convergence (this milestone)** — see below | `grn-convergence.test.ts` |
| 5b | Lane-per-state dock board (dock, window, supervisor, progress, variance chips) + per-session activity timeline | `ReceivingSessionBoard.tsx`, `OutboxTimeline` |
| 6 (base) | Mobile scan-first receiving loop with pallet step | `MobileReceiveSession.tsx` |

### Phase 4d — GRN convergence (landed 2026-08-02)

- `GoodsReceiptWizardPage.tsx` (1.1k lines, second capture UI) **deleted**.
  `/purchases/goods-receipt/new?po=<id>` now resolves to
  `GoodsReceiptRedirect.tsx`, which forwards to
  `/warehouse-app/receiving?source_doc_type=…&source_doc_id=…`.
- "Receive goods" on a purchase order and "Start goods receipt" on an inbound
  shipment both open the receiving workspace with the document pre-bound;
  `ReceivingSessions.tsx` reads those params, prefills and opens the create
  dialog, then strips them from the URL.
- Inbound shipments (ASN) are now bindable as a source document in the create
  dialog, matching what posting already supports.
- The GRN document is produced by posting: `usePostReceivingSession` fires
  `dispatchGoodsReceipt` (best-effort) so the receipt is snapshotted and
  archived through the document engine exactly as before.
- Serial parity preserved on the surviving path: serial-tracked products
  capture one unit per scan/entry with a mandatory serial (UI gate matching the
  `enforce_serial_on_movement` trigger, ADR-0067).
- Guards: `src/test/architecture/grn-convergence.test.ts` (wizard gone, no
  client call to `complete_goods_receipt_atomic`, redirect contract, document
  dispatch, PO+ASN binding, serial rule). Retired wizard-only guards
  (`grn-asn-prefill`, `grn-serial-capture`) removed; `gs1-parsing`,
  `identity-resolver-single-seam` and `inbound-shipments-ui` re-pointed at the
  receiving workspace.
- Verified: `tsgo --noEmit` clean; 56 architecture tests green.

---

## Pending work (in roadmap order)

**Phase 5c — session detail rail hardening (NEXT)**
- Header rail: truck / dock / live unload timer / operator, always visible.
- Exception strip in the workspace: open `wms_exceptions` for the session with
  typed resolution actions (accept overage, short-close, damage claim, QC hold
  release) instead of the current read-only variance chips.
- Blocking-state clarity: why a session cannot post (unmatched lines, all
  quantity held) surfaced before the operator clicks Post.

**Phase 6b — offline queue for the mobile loop**
- Queue captures locally when the device drops connectivity and replay them
  keyed by `client_scan_id` (the RPC is already idempotent).

**Phase 7 — label seam**
- Add putaway / quality-hold / quarantine keys to `WMS_LABEL_KEY`, route all
  receiving prints through `printWmsLabel`, remove the ad-hoc `receiving_label`
  call.

**Phase 8 — remaining guards**
- Pin "no session-level scan transitions" and "labels only via the WMS seam".

**Known follow-ups (not yet scheduled)**
- `goods_receipt_discrepancies` (Purchases) and `wms_exceptions` (WMS) still
  model the same fact in two tables; the wizard was the only writer of the
  former, so it is now effectively read-only history. Decide: backfill from
  `wms_exceptions` on post, or retire the table.
- `source_doc_type` remains a free-text column; consider a DB enum/check now
  that only `purchase_order` and `inbound_shipment` are reachable from the UI.

---

## Instructions for the next agent

1. **Verify before building.** Confirm Phase 4d actually holds:
   run `npx tsgo --noEmit` and
   `npx vitest run src/test/architecture/grn-convergence.test.ts src/test/architecture/wms-phase2.test.ts src/__tests__/architecture.receiving-line-grain.test.ts`;
   grep for `complete_goods_receipt_atomic` and `GoodsReceiptWizardPage`
   (both must be absent from `src/`); confirm posting a session still yields a
   `goods_receipts` row plus a `purchases.grn` document record.
2. **Then continue chronologically** with Phase 5c above — do not start Phase 7
   or unrelated WMS areas first.
3. **Finish each phase completely** (data access → UI → guard test → this file
   updated) before moving to the next. No partial surfaces, no orphaned RPCs.
4. **Update this file** as the last step of every milestone so it remains the
   authoritative status.
