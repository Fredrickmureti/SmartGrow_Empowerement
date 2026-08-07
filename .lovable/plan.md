# Business Reversal & Compensation Architecture — Authoritative Status

Target: every business reversal in the ERP (Sales, Purchases, POS, Finance,
Inventory, Payroll) is explainable, deterministic, auditable and orchestrated by
ONE model: `resolve_reversal_intent` (legality) → `preview_reversal_consequences`
(projection) → one canonical atomic writer per operation → thin client wrapper.

Last updated: 2026-08-07. Active phase: **Phase 4 complete → Phase 5 next.**

## Fully implemented and verified

- **Phase 0 — capability restored.** `void_journal_entry_atomic` stamps
  `organization_id`/`business_id` on reversal lines. Covered by
  `supabase/tests/journal_reversal_scope_test.sql`.
- **Phase 1 — single legality authority.** `resolve_reversal_intent` covers
  invoice, payment, bill, bill_payment, goods_receipt. Blocker taxonomy closed:
  `already_reversed`, `settled`, `bank_reconciled`, `period_closed`.
- **Phase 2 — consequence projection.** `preview_reversal_consequences(_core)`
  projects GL / stock / money / documents / warnings for all five types; verified
  pure (no writes) and derived from the intent authority.
- **Phase 3 — AR/AP writers.** `void_invoice_atomic`, `void_payment_atomic`,
  `void_bill_atomic`, `void_bill_payment_atomic`; client is out of the ledger
  (`useTransactionReversal.ts` is a thin wrapper per operation).
- **Phase 4a — regression + surfaces.** Rules-of-Hooks violation in
  `ReversePaymentWizard` fixed; bank un-match action wired into all four AR/AP
  reversal surfaces; guard `reversal-writer-monopoly.test.ts` added.
- **Phase 4b — goods receipt reversal (was an empty promise).**
  `void_goods_receipt_atomic` + `wms_reverse_gr_stock` (GR/NI journal reversal,
  `return_out` compensation, PO received-qty restore, putaway task cancellation,
  three-way-match release, period guard, idempotent). Client:
  `reverseGoodsReceipt` → `ReverseGoodsReceiptDialog` →
  `PurchaseOrderReceiptsSection` on the purchase order record. ADR 0128.
- **Phase 4c — behavioural/contract coverage + one real defect fixed.**
  New suites, all executed green against the live database:
  `supabase/tests/reversal_intent_policy_test.sql`,
  `reversal_preview_contract_test.sql`, `goods_receipt_reversal_test.sql`,
  `void_bill_test.sql`.
  Defect found and fixed while writing them: **voiding a bill left the purchase
  order `fully_billed`** (the recompute trigger only fires on `bill_items` DML),
  so the PO could never be re-billed. New canonical
  `po_resync_billed_state(_po_id)` /
  `po_resync_billed_state_for_bill(_bill_id)`; `void_bill_atomic` now calls it
  and releases `converted_bill_id`.
- Typecheck clean (`tsgo --noEmit`); reversal + posting-monopoly vitest guards
  green.

## Known gaps / still pending

1. **Server-side legality is not uniform.** `void_bill_atomic`,
   `void_bill_payment_atomic`, `void_payment_atomic` re-derive their own checks
   instead of consulting `resolve_reversal_intent` (invoice and goods-receipt
   writers do). A client that skips the dialog can hit a writer whose rules
   differ from the preview the operator saw. → Phase 5.
2. **No unified reversal authorization / reason taxonomy / approval thresholds /
   per-period reversal report.** → Phase 5.
3. **Payroll and POS have not converged.** `payroll_run_can_reverse`,
   `payroll_reverse_run_atomic`, `payroll_batch_reverse` and the POS saga
   (`src/services/pos/reversal/`, `pos_reversal_workflow_*`) are correct per
   document but invisible to the platform contract. → Phase 6.
4. **Forward bank-reconciliation writes from the client**
   (`useReconciliationItems.ts`) remain technical debt; the guard currently bans
   only reversal-path writes.
5. **Deferred, needs a business decision:** retiring `_cascade_payments` on
   `void_invoice_atomic` in favour of forcing a credit note / refund on settled
   invoices.

## Next up — Phase 5 (Governance), in this order

1. `assert_can_reverse(_document_type, _document_id, _operation, _actor)` — one
   security-definer gate delegating to `resolve_reversal_intent`; call it as the
   first statement of every canonical writer (`void_invoice_atomic`,
   `void_payment_atomic`, `void_bill_atomic`, `void_bill_payment_atomic`,
   `void_goods_receipt_atomic`). Extend
   `supabase/tests/reversal_intent_policy_test.sql` with a block asserting every
   writer calls it — that block is the definition of done for step 1.
2. Unified reason-code taxonomy across AR/AP/GRN (table or enum + `void_reason`
   validation), surfaced as a select in every reversal dialog instead of free
   text.
3. Approval thresholds for high-value and prior-period reversals via the
   existing approval engine.
4. Per-period reversal report (who reversed what, why, with which compensating
   entries) — the audit deliverable of the parent prompt.
5. ADR `0129-reversal-authorization-policy.md`.

Then **Phase 6** (payroll + POS branches inside intent/preview, shared
`ReversalConsequencePreview` on both surfaces — no new engine).

## Instructions for the next agent

1. **Verify before building.** Re-run, and do not trust this file:
   - `bunx vitest run src/test/architecture/reversal-writer-monopoly.test.ts src/test/architecture/reversal-intent-policy.test.ts src/test/architecture/payment-reversal-intent-contract.test.ts src/test/architecture/journal-posting-monopoly.test.ts`
   - the four Phase 4c SQL suites above (they are safe read-only introspection
     plus probes; run them through the SQL editor / `read_query`),
   - `bunx tsgo --noEmit`.
   - Confirm on the live DB that `po_resync_billed_state_for_bill` is called
     inside `void_bill_atomic` and that `void_goods_receipt_atomic` still
     contains all five fan-out steps.
2. **Then resume at Phase 5 step 1** — do not start Phase 6, and do not open
   unrelated modules. Finish each Phase 5 step to a production-ready state
   (writer + guard/test + dialog wiring where operator-visible) before the next.
3. Update this file after each completed step: move items from "pending" to
   "implemented and verified", keep "Active phase" accurate, and keep these
   instructions current.
