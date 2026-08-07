# ADR 0128 — Goods receipt reversal is a single server-side operation

Status: accepted
Date: 2026-08-07
Related: ADR 0123 (posting monopoly), ADR 0126 (AP payment reversal), ADR 0127 (invoice void), ADR on reversal intent resolution

## Context

`resolve_reversal_intent` has advertised a `goods_return` operation for goods
receipts since the intent engine was introduced: "Takes the received quantities
back out of stock and reverses the receipt posting." No writer implemented it.
The operation was reachable in the intent matrix, blocked-reason text and
consequence preview, but nothing could execute it — the only way to unwind a
completed receipt was manual stock adjustment plus a manual journal, i.e. two
uncorrelated documents and no audit link back to the receipt.

Completion is already a fan-out: `complete_goods_receipt_atomic` calls
`wms_apply_gr_stock` (movements, purchase-order quantities, PO status) and
`finance_post_gr_journal` (the Inventory / GR-NI accrual) in one transaction.
Reversal needs the mirror of that fan-out, not a partial undo.

## Decision

`public.void_goods_receipt_atomic(_gr_id, _reason, _void_date, _actor,
_client_request_id)` owns the whole reversal in one transaction:

1. Locks the receipt; returns `already_reversed` on repeat (idempotent).
2. Refuses a receipt that was never completed (nothing was posted — edit the
   draft) and refuses a void date inside a closed fiscal period.
3. Refuses while a non-void supplier bill covers the receipt. This is the same
   `billed` blocker the intent engine reports, so guard and advice cannot drift.
4. Reverses every live journal entry sourced from the receipt through
   `void_journal_entry_atomic` — matching on both `source_type`/`source_id` and
   the legacy `reference_type`/`reference_id` linkage.
5. Delegates the warehouse leg to `public.wms_reverse_gr_stock`, which mirrors
   each original `receipt` movement as a `return_out` under
   `reference_type = 'goods_receipt_void'` and restores purchase-order received
   quantities, re-deriving PO status from the corrected rows.
6. Cancels open warehouse tasks for the document via
   `wms_cancel_tasks_for_document`, so no operator can claim put-away work for a
   receipt that is no longer in the books.
7. Clears `bill_grn_matches` (three-way-match state describing a receipt that no
   longer exists) and flips the receipt to `reversed`.
8. Emits `procurement.gr.reversed` on the business event outbox, keyed
   idempotently, so downstream subscribers see the reversal the same way they
   saw the posting.

Stock is compensated, never deleted: the `goods_receipt_void` movements are both
the correction and the idempotency probe.

`useTransactionReversal().reverseGoodsReceipt` is a thin client wrapper — reason,
audit label, error surfacing, nothing else.

## Consequences

- The `goods_return` operation the intent engine recommends is now executable;
  the matrix no longer promises an action the platform cannot perform.
- Stock, purchase order, ledger, warehouse queue and match state move together
  or not at all.
- A new ratchet in `src/test/architecture/reversal-writer-monopoly.test.ts`
  bans client-side warehouse task cancellation and client-side bank
  reconciliation release, the two legs most likely to be re-implemented in the
  browser.
- Known remaining drift, deliberately not covered by the ratchet:
  `useReconciliationItems.markAllReconciled` still writes `is_reconciled` from
  the client on the *forward* reconciliation path. That needs its own canonical
  RPC before the bank ratchet is widened.
