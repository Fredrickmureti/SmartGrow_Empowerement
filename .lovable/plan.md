# Business Reversal & Compensation Convergence — Status

Authoritative status file. Update it after every implementation step.

## Active phase

**Phase 4 — Warehouse tasks & bank reconciliation participation: implemented (server complete, UI mostly complete).**

## Completed and verified

- **Phase 0 — Reversal capability restored.** `organization_id` stamping fixed; invoice void works.
- **Phase 1 — Reversal intent policy.** `resolve_reversal_intent` is the single authority (settlement, bank reconciliation, period state, blockers, recommended operation). No client-side legality derivation.
- **Phase 2 — Consequence preview.** `preview_reversal_consequences` + `useReversalConsequences` (fetch) + `ReversalConsequencePreview` (pure projection), mounted in the invoice void sheet and the payment reversal wizard. Guarded by `src/test/architecture/reversal-consequence-preview.test.ts`.
- **Phase 3 — Purchases / AP / GRN.** `void_bill_atomic` canonical writer (GL reversal, three-way-match unwind, void metadata, blockers for draft/settled/closed period); intent + preview branches for `bill`, `bill_payment`, `goods_receipt`; `VoidBillDialog`; reversal preview in `BillPaymentHistoryDialog`; client sagas removed; posting-monopoly guard extended.
- **Phase 4 — Warehouse & bank participation.**
  - `wms_open_tasks_for_document` (read) and `wms_cancel_tasks_for_document` (canonical writer, cancels open tasks with a reason).
  - `void_invoice_atomic` now cancels the invoice's open warehouse tasks in the same transaction and reports `cancelled_warehouse_task_count`.
  - `reversal_bank_lines` lists the reconciled statement lines matched to a document's payments (AR and AP).
  - `unreconcile_bank_transaction` extended: releases AR payments matched as `reconciled_type='payment'` and reverses AP (`bill_payment`) reconciliation matches, so the `bank_reconciled` blocker can actually be cleared for purchases.
  - `resolve_reversal_bank_block` — guided, permission-gated resolution that un-matches exactly the blocking lines.
  - `preview_reversal_consequences` split into `_core` + wrapper; wrapper adds `warehouse` and `bank` sections plus `warehouse_tasks_cancelled` / `bank_lines_matched` warnings.
  - Frontend: `ReversalWarehouseTask` / `ReversalBankLine` types, `unmatchBankLinesForReversal` hook wrapper, warehouse + bank sections in `ReversalConsequencePreview`, `refetch` in `useReversalConsequences`, and the guided un-match action wired into `VoidInvoiceDialog` and `VoidBillDialog`.
  - Verified: `tsgo` clean; `reversal-consequence-preview` and `journal-posting-monopoly` guards green.

## Pending

1. **Phase 4 finish (small):** wire `onUnmatchBankLines` into `ReversePaymentWizard` (document type `payment`) and `BillPaymentHistoryDialog` (document type `bill_payment`) — both already render the bank section but not the action. Add an architecture guard asserting (a) no application code writes `wms_tasks.state = 'cancelled'` outside `wms_cancel_tasks_for_document`, and (b) no client code writes `bank_transactions` / `bank_reconciliation_matches` to unblock a reversal.
2. **Phase 4 remainder:** `void_goods_receipt_atomic` canonical writer (stock `return_out`, GL reversal, blocker when a bill exists) + a GRN reversal surface. Intent and preview branches already exist, so the GRN path is currently read-only.
3. **Phase 5 — Governance:** reversal audit trail / approval thresholds, reason-code taxonomy, reporting of reversals per period.
4. **Phase 6 — Payroll & POS convergence:** payroll run reversal and POS sale/shift void onto `resolve_reversal_intent` + `preview_reversal_consequences` + a canonical atomic writer per domain.

## Next milestone

Finish Phase 4 item 1 (two surfaces + guard test), then Phase 4 item 2 (`void_goods_receipt_atomic` and its surface). Do not start Phase 5 or 6 before the goods-receipt path is production-ready.

## Instructions for the next agent

1. **Verify before extending.** Confirm in the database that `wms_cancel_tasks_for_document`, `reversal_bank_lines`, `resolve_reversal_bank_block`, `preview_reversal_consequences_core` and the updated `void_invoice_atomic` / `unreconcile_bank_transaction` exist and behave as described. Run `bunx vitest run src/test/architecture` and `bunx tsgo --noEmit`.
2. **Then resume at the next milestone above** — no unrelated work, no partially implemented features, no orphaned RPCs without a surface.
3. **Rules that must hold:** one canonical server-side writer per reversal; the client never derives legality or writes ledger/stock/task/reconciliation state; every reversal surface renders the consequence preview; `ReversalConsequencePreview` stays purely presentational.
4. **Update this file** as each item lands.
