# Receiving Subsystem — Verification Result & Remaining Phases

Independent re-audit of the previous engineer's handoff, checked against the
codebase and the live database (not against their notes).

## Verification of claimed-complete phases

| Phase | Claim | Verdict |
| --- | --- | --- |
| 1 | Typed source binding + appointment/dock/supervisor | **Real.** Session create picks appointment, derives `dock_id`, stamps `supervisor_id`; `wms_materialize_expected_lines` exists and is called. Residual: no `wms_trailer_visits` link (zero references in `src/`), and the create-form reset drops `appointment_id`. |
| 2 | Line capture via `wms_capture_receiving_line` | **Real but incomplete.** All 15 params (lot, serial, expiry, damage, hold, `client_scan_id`) are wired. Gap: `p_lpn_id` is hard-coded `null` on both desktop and mobile — license plates are never captured during receiving. Also a stale 12-arg overload of the RPC still exists in the database alongside the 15-arg one. |
| 3 | Variance + exceptions | **Real.** `wms_flag_receiving_variances` and the `wms_receiving_session_progress` rollup exist and are consumed. |
| 4a | Single posting path | **Partially correct.** `wms_post_receiving_session` does create the goods receipt, stage to WMS, flag variances and transition. Two defects: it hard-rejects any session whose source is not a purchase order (ASN / inbound shipment sessions can never post), and it posts every line with `received_qty > 0` including `qc_hold` and damaged lines, so held goods land in available stock instead of quarantine. |
| 5a | Session workspace | **Partial.** Expected/received/variance grid, capture panel and `ScanStatusChip` are present. No exception strip, no activity timeline, no label actions in the workspace. |
| 6 | Mobile loop | **Real.** `/wm/receiving/:id` runs scan → qty → lot → expiry → confirm through the offline queue only. No LPN step (see Phase 2 gap). |
| 7 | Canonical labels | **Real.** `PUTAWAY` / `QUALITY_HOLD` / `QUARANTINE` keys exist and route through the WMS seam. |
| 8 | Architecture guards | **Real** for what they assert; they do not yet pin the new invariants below. |

Conclusion: the previous engineer's log is broadly honest. The genuine last
completed milestone is Phase 8, but Phase 4a must be reopened.

## Remaining work, in order

**Phase 4a-fix — make posting correct (reopened).**
Rework `wms_post_receiving_session` so it excludes `qc_hold` and damaged
quantity from the goods receipt and routes those lines to a quarantine/hold
location instead, and so non-PO sessions (ASN, inbound shipment, blind) post
through the appropriate receipt path rather than raising. Drop the stale 12-arg
`wms_capture_receiving_line` overload.

**Phase 4b — retire the after-the-fact staging path.**
`ReceiveToWMSDialog` (used only by `PutawayQueue.tsx`) calls
`receive_goods_to_wms` outside any receiving session. Remove that entry point;
staging becomes a consequence of posting a session. Update
`src/test/architecture/wms-phase2.test.ts`, which currently pins the dialog's
existing behaviour.

**Phase 4c — capture the license plate.**
Add an LPN scan step to the desktop capture panel and the mobile loop, passing
`p_lpn_id` through to the RPC, so pallet identity survives into putaway.

**Phase 5b — session board and activity timeline.**
Replace the eight-column table with a lane-per-state board: card per session
showing carrier/trailer, dock, appointment window, supervisor, progress bar and
shortage/overage/damage/hold chips. Add a per-session event timeline and an
exception strip to the workspace, plus putaway/hold/quarantine label actions.
Built on existing design-system and shadcn primitives.

**Phase 1-residual — trailer visits.**
Bind `wms_trailer_visits` to the session so seal, arrival and dwell are visible
on the receiving surfaces. Fix the create-form reset that drops `appointment_id`.

**Phase 9 — GRN wizard convergence.**
`src/features/purchases/goods-receipt/GoodsReceiptWizardPage.tsx` remains a
second capture UI. Reframe it as the *document* produced by receiving: it
renders and prints the receipt, it does not re-capture quantities.

**Phase 10 — guards for the new invariants.**
Extend `src/__tests__/architecture.receiving-line-grain.test.ts`: no
`receive_goods_to_wms` outside the posting RPC, every capture site passes an
LPN argument, held/damaged quantity never reaches the goods receipt.

## Technical notes

- Receiving ledger `wms_receiving_lines`; rollup view
  `wms_receiving_session_progress`; FSM `wms_transition_receiving`
  (`row_version` guarded).
- SQL changes are confined to the receiving RPCs. Inventory stays the only
  writer of quants, movements and cost layers; no changes to valuation, lots,
  POS, Finance or Localization.
- Each phase ships on its own and this file is updated as each lands.
