# Receiving Subsystem — Architecture Audit & Target Design

## 1. What receiving is (first principles)

Receiving is not a form. It is a chain of business events that converts a
supplier's *promise* into *owned, located, allocatable stock*:

```text
PO → shipment → ASN → appointment → trailer arrival → yard → dock
  → receiving session (unit of work, supervised, time-boxed)
    → per-handling-unit capture loop:
        scan LPN → scan item → resolve identity → qty (base units)
        → lot / serial / expiry → damage → accept | short | over | hold
    → discrepancy recording (line grain, against expected)
    → QC hold / quarantine routing
    → post to inventory (ledger writes: quants, movements, cost layers)
    → putaway task fan-out → confirm → available for allocation
    → GRN document, labels, 3-way match, finance & audit events
```

Two invariants: **expected vs received exists at line grain from the first
scan**, and **capture is separable from posting** (you can unload without
committing the ledger).

## 2. What exists today

Strengths (real, keep):

- Clean domain boundary per ADR 0079/0080/0101 — Inventory owns quantity and
  cost, WMS owns execution. Events go through `business_event_outbox` with
  `wms.{aggregate}:{id}:{transition}` idempotency keys.
- FSM discipline: `wms_transition_receiving`, `row_version` optimistic
  concurrency, no client-side `state` writes.
- A strong scanning substrate: `scanRouter` intents, GS1 pre-parse,
  `scanFeedbackBus` (audio + haptic), single identity resolver
  (`resolve_product_identity` via `useWmsIdentityGate`), base-unit conversion,
  ambiguity blocking.
- Backend receiving engine already built: `wms_receiving_lines` (product, lpn,
  lot, serial, expected_qty, received_qty, uom, staging bin, discrepancy
  reason) and `wms_capture_receiving_line(...)` with `client_scan_id` +
  `device_id` idempotency, plus `_wms_emit_receiving_line_captured`,
  `evaluate_crossdock_on_receiving_line`, `_wms_auto_open_qc_on_grn`,
  `suggest_putaway_locations`, `receive_goods_to_wms`.

Weaknesses (the actual problem):

1. **The receiving line engine is dead code.** No application file references
   `wms_receiving_lines` or `wms_capture_receiving_line` — only the generated
   types file does. The whole capture layer is unused.
2. **Wrong grain in the UI.** In `ReceivingSessions.tsx` an *item* scan
   transitions the entire session to `captured`. Quantity, lot and expiry are
   resolved by the identity gate and then thrown away into a toast string. No
   row is persisted. One scan "completes" a truck.
3. **No expected vs received.** Sessions bind to a source document via two
   free-text inputs (`source_doc_type` placeholder `asn / po / goods_receipt`,
   `source_doc_id` a hand-typed UUID). No PO/ASN line expansion, so shortage,
   overage and unexpected-item are structurally uncomputable.
4. **The truck is invisible.** `appointment_id`, `dock_id`, `supervisor_id`
   exist on the table; the create dialog sets none of them. No link to
   `wms_trailer_visits`. An operator cannot answer "which trailer am I on?".
5. **Two competing receiving paths.** The Purchases GRN wizard (1.1k lines) is
   the only real line capture and the only path that reaches inventory;
   `ReceiveToWMSDialog` / `MobileReceive` merely call `receive_goods_to_wms`
   *after the fact*. WMS receiving has no inventory effect at all — it is
   decorative. Discrepancies live in `goods_receipt_discrepancies` (Purchases)
   and are never shown in the WMS.
6. **Mobile is not a receiving workflow.** `MobileReceive.tsx` is a staging-bin
   dropdown plus a "Stage to WMS" button — no walk/scan/qty/lot loop.
7. **No operational awareness.** Session list is a 6-column table: no progress
   (x of y lines, % qty), no shortage/overage/damage/hold counts, no line
   drill-down, no activity stream. A new hire cannot learn the job from it.
8. **Labels partly bypass the seam.** `WMS_LABEL_KEY` covers LPN, BIN, CARTON,
   SHIPPING, PACKING_SLIP — no putaway, quality-hold or quarantine label; and
   `MobileReceive` prints an ad-hoc `receiving_label` templateKey directly
   instead of going through `printWmsLabel`.
9. **No device presence feedback** on receiving surfaces: connected /
   listening / disconnected is never displayed, only per-scan results.
10. **Exceptions never raised from receiving.** `wms_exceptions` exists and the
    Inbound tower counts them, but no receiving code path inserts one.

## 3. Target architecture

Grain and ownership:

- `wms_receiving_sessions` = supervised unit of work, bound to appointment /
  trailer visit / dock / source document (typed, picked — never typed by hand).
- `wms_receiving_lines` = the receiving ledger of record for *execution*. Every
  scan writes exactly one line via `wms_capture_receiving_line`, idempotent on
  `client_scan_id`, quantity always in base units via `scanToBaseUnits`.
- Expected lines are materialised from PO / ASN / inbound-shipment items when
  the session opens; unexpected scans create lines with `expected_qty = 0`.
- Posting stays a distinct, guarded transition. Inventory remains the only
  writer of quants/movements/cost layers; WMS posts by delegating to the
  sanctioned GRN/inventory RPCs and emits `warehouse.receiving.*`.
- Shortage / overage / damage / hold are derived from line data, not typed
  states; each raises a `wms_exceptions` row with a typed resolution.
- One receiving path. Purchases GRN becomes the *document* produced by
  receiving, not a second capture UI.

UX target (workspace, not a table):

- Session board: lane per state, each card showing carrier/trailer, dock,
  appointment window, supervisor, progress bar, and shortage/overage/hold chips.
- Session detail: header rail (truck, dock, timer, operator), line grid with
  expected vs received vs variance, live scan capture panel, exception strip,
  activity/event timeline, label actions.
- Persistent scanner status chip (connected / listening / last scan / failure).
- Mobile: purpose-built loop — scan LPN → scan item → qty → lot → expiry →
  confirm → next, offline-queued, one thumb, large targets.

## 4. Migration strategy (phased, each phase shippable)

1. **Bind reality**: typed source-document picker (PO / ASN / inbound shipment)
   + appointment/trailer/dock/supervisor selection on session create; expected
   lines materialised from the chosen document.
2. **Line capture**: replace the session-level scan handlers with per-line
   capture through `wms_capture_receiving_line` (qty in base units, lot, serial,
   expiry, LPN, staging bin, `client_scan_id` idempotency). Session state becomes
   derived from line progress, not from a single scan.
3. **Variance & exceptions**: derived shortage/overage/unexpected/damage;
   `wms_exceptions` raised on each; QC hold / quarantine routing wired.
4. **Post once**: session posting delegates to the sanctioned GRN/inventory
   RPCs, produces the GRN document, fans out putaway tasks; retire the
   after-the-fact `ReceiveToWMSDialog` path.
5. **Workspace UI**: session board + session detail workspace with progress,
   variance, timeline, scanner status chip — built on existing design-system
   primitives and shadcn, plus a proven charting/timeline library where it
   materially helps rather than hand-rolled layout.
6. **Mobile receiving loop**: dedicated scan-first flow, offline queue.
7. **Labels**: add putaway / quality-hold / quarantine keys to `WMS_LABEL_KEY`,
   route every receiving print through `printWmsLabel`, remove the ad-hoc
   `receiving_label` call.
8. **Guards**: architecture tests pinning "no session-level scan transitions",
   "capture only via RPC", "no direct `product_identifiers` reads", "labels only
   via the WMS seam".

## 5. Technical notes

No new receiving tables or RPCs are needed for phases 1–4 — the schema and
`SECURITY DEFINER` functions already exist and are unused. Expected work is
frontend wiring plus small SQL additions for expected-line materialisation and
exception raising. No changes to `stock_movements`, `stock_quants`, valuation,
lots, POS, Finance or Localization.
