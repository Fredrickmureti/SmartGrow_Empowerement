# Business Reversal Convergence — Verification Verdict and Remaining Phases

## Phase 1 — Independent verification (done this turn, against the live database and code)

### Claims confirmed true

- **Phase 0/1/2 exist.** `resolve_reversal_intent` (single legality authority),
  `preview_reversal_consequences` + `preview_reversal_consequences_core`, and
  `resolve_reversal_bank_block` are all present in the database, with the GRN
  branch already in the intent policy.
- **Phase 3 (Purchases/AP) is real.** `void_bill_atomic` and
  `void_bill_payment_atomic` exist; `useBills.voidBill` is now a thin call to
  `void_bill_atomic` with only permission, optimistic update and audit label —
  no client-side saga.
- **Phase 4 server side is real.** `wms_open_tasks_for_document`,
  `wms_cancel_tasks_for_document`, `reversal_bank_lines` exist;
  `void_invoice_atomic` does call `wms_cancel_tasks_for_document`;
  `unreconcile_bank_transaction` does handle the AP (`bill_payment`) side;
  `preview_reversal_consequences` does compose the bank section.
- **Client is out of the ledger.** Every AR/AP reversal path in
  `src/hooks/useTransactionReversal.ts` delegates to one atomic RPC. The 14
  ratchets in `journal-posting-monopoly.test.ts` pass.

### Defects and gaps found

1. **Regression shipped in Phase 2 — Rules-of-Hooks violation.**
   `src/components/payments/ReversePaymentWizard.tsx` calls
   `useReversalConsequences(...)` at line 258, **below** the
   `if (!payment) return null` guard at line 228. The existing ratchet
   `src/test/architecture/payment-reversal-intent-contract.test.ts` **is failing**
   on this, and the file's own comment at line 199 warns against exactly this.
   This re-introduces the previously fixed conditional-hooks crash on
   `/sales/payments`. Highest-priority fix.
2. **Phase 4 item 1 is genuinely unfinished** (as claimed): the guided
   bank un-match action is wired only into `VoidInvoiceDialog` and
   `VoidBillDialog`; `ReversePaymentWizard` and `BillPaymentHistoryDialog`
   render the bank section without the action, so the `bank_reconciled`
   blocker cannot be cleared from those surfaces.
3. **No architecture guard for the Phase 4 writers.** Nothing bans client
   writes to `wms_tasks.state = 'cancelled'` or to `bank_transactions` /
   `bank_reconciliation_matches` for reversal purposes, so the new canonical
   writers can be bypassed silently.
4. **`void_goods_receipt_atomic` does not exist.** Intent and preview both have
   a `goods_receipt` branch, so the GRN reversal path is a read-only promise the
   platform cannot keep — an operator is told the operation is legal with no
   writer behind it.
5. **No behavioural coverage for Phase 1–4.** `supabase/tests/` has no
   `reversal_intent_*`, `reversal_preview_*`, `void_bill_*` or
   `warehouse task cancellation` test. Only `payment_reversal_test.sql`,
   `bill_payment_reversal_test.sql` and `journal_reversal_scope_test.sql` exist.
6. **Payroll and POS have not converged** (as claimed). Payroll runs its own
   stack (`payroll_run_can_reverse`, `payroll_run_reversal_preview`,
   `payroll_reverse_run_atomic`, `payroll_batch_reverse`) and POS its own saga
   (`pos_reversal_workflow_*`), neither routed through `resolve_reversal_intent`
   or `preview_reversal_consequences`.

Verdict: the previous engineer's status file is broadly honest, but it omits a
shipped regression and understates that a whole advertised operation (GRN void)
has no writer.

## Phase 2 — Plan (revised)

### Phase 4a — Fix the regression and finish the surfaces
- Move the `useReversalConsequences` call in `ReversePaymentWizard` above the
  `if (!payment) return null` guard (pass `payment?.id`), restoring the failing
  ratchet to green.
- Wire `onUnmatchBankLines` into `ReversePaymentWizard` (`payment`) and
  `BillPaymentHistoryDialog` (`bill_payment`), refetching intent + preview after
  a successful un-match, matching the invoice/bill dialogs.
- New guard `src/test/architecture/reversal-writer-monopoly.test.ts`: no client
  write of `wms_tasks.state = 'cancelled'`, no client write to
  `bank_transactions` / `bank_reconciliation_matches` on a reversal path, and
  every surface rendering `ReversalConsequencePreview` passes an un-match
  handler when it can be blocked by reconciliation.

### Phase 4b — Goods receipt reversal writer
`public.void_goods_receipt_atomic(_grn_id, _reason, _void_date, _actor,
_client_request_id)` in one transaction: refuse when a supplier bill exists,
when the period is closed, or when already voided (idempotent
`already_voided`); reverse the GRNI posting through `void_journal_entry_atomic`;
emit `return_out` stock movements through the existing canonical stock writer
(never raw movement inserts); release the three-way match rows; cancel open
putaway tasks via `wms_cancel_tasks_for_document`; stamp void metadata.
Surface: a `VoidGoodsReceiptDialog` mirroring `VoidBillDialog` (intent →
consequence preview → reason → execute). Extend the posting-monopoly ratchet to
ban client-side GRN status/void writes.

### Phase 4c — Behavioural coverage
pgTAP under `supabase/tests/`: `reversal_intent_policy_test.sql` (blockers for
settled / reconciled / closed period / already reversed per document type),
`reversal_preview_test.sql` (sections and warning codes are stable contracts),
`void_bill_test.sql`, `goods_receipt_reversal_test.sql`, and a warehouse-task
cancellation assertion inside the invoice void test.

### Phase 5 — Governance
One reversal authorization policy instead of per-RPC gates:
`assert_can_reverse(_document_type, _document_id, _operation, _actor)` used by
every canonical writer; reason-code taxonomy unified across AR/AP/GRN/POS;
approval thresholds for high-value or prior-period reversals through the
existing approval engine; a per-period reversal report.

### Phase 6 — Payroll and POS convergence
Keep both domain sagas (they are correct per-document orchestrators) but make
them speak the platform contract: `resolve_reversal_intent` gains `payroll_run`
and `pos_sale` branches delegating to `payroll_run_can_reverse` and the POS
eligibility matrix; `preview_reversal_consequences` gains payroll and POS
sections; the payroll and POS reversal surfaces render the shared
`ReversalConsequencePreview`. No new engine, no duplicated legality logic.

### Deferred, needs a business decision
Retiring `_cascade_payments` on `void_invoice_atomic` in favour of forcing a
credit note / refund on settled invoices (the mature-ERP behaviour recorded in
memory). This changes operator-visible policy and should be agreed, not
silently switched.

## Technical notes
- Verification method: `pg_proc` inspection for existence, overload counts and
  body markers (`wms_cancel_tasks_for_document` inside `void_invoice_atomic`,
  `bill_payment` inside `unreconcile_bank_transaction`); `vitest run` on the
  four reversal architecture guards (3 passed, `payment-reversal-intent-contract`
  failed); source reads of `useTransactionReversal.ts`, `useBills.ts`,
  `ReversePaymentWizard.tsx` and the reversal component barrel.
- Each phase ends with `bunx tsgo --noEmit`, the reversal + posting-monopoly
  guards green, and an ADR (`0128-goods-receipt-reversal.md`,
  `0129-reversal-authorization-policy.md`).
- No source files were modified during verification.
