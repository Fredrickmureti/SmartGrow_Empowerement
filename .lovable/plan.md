# Payments & Reconciliation — Verification Verdict, then D6.2 / D6.3 / D7

## Phase 1 verdict on the previous engineer's claims

I re-checked each "done" claim directly in the code, not the status file.

Confirmed genuinely complete (D6.1, supplier advances):

- `vendor_unapplied_advances` and `apply_vendor_advance_atomic` exist in the migration applied on 9 Aug and in the generated types.
- Operator surfaces exist and are wired: Vendor Credits page (`src/pages/finance/VendorCredits.tsx`), a route entry in the finance app, `RecordVendorAdvanceDialog`, `ApplyVendorAdvanceDialog`, and the `useVendorUnappliedAdvances` read hook.

Confirmed still open, exactly as the plan said — plus one defect the plan did not record:

- Two customer-payment dialogs are still live. `src/pages/finance/AccountsReceivable.tsx` imports **both** (lines 62–63) and renders both. Invoices uses the invoices one; Customer Payments and Collections use the sales one.
- ADRs 0027 and 0028 still describe the legacy `invoice_id` / `bill_id` columns and the writer migration as pending/deferred, although both are done.
- No ratchet exists for request keys or for an AP writer monopoly. The only guard is a "max 2 RecordPaymentDialog files" ratchet in `payment-reversal-intent-contract.test.ts`.
- **New defect (evidence-backed):** `usePayments.recordPayment` accepts `requestId` and forwards it as `_request_id`, but **no call site passes one**. Both dialogs submit without a key, so the database idempotency added in D1/D2 is unreachable from the UI. A double submit on Receive Payment can mint two payments today. This is the highest-severity item remaining and moves to the front of D6.2.

Work resumes at D6.2 with idempotency wiring pulled forward.

## D6.2 — One customer-payment dialog, with a working request key

1. **Idempotency first.** Derive a deterministic request key from the payment intent (contact, allocation set, cents, payment date, deposit account) — the same pattern already proven in `ReversePaymentWizard` (`makeDeterministicRequestId`) and `ApplyCustomerDepositDialog`. Pass it through `recordPayment` and `recordMultiInvoicePayment`. No `crypto.randomUUID()`.
2. **Choose the survivor.** The sales dialog owns the superior model: customer-first, multi-invoice allocation, and residual sourced from `fetchOpenCustomerInvoices` (the GL-gated AR projection) rather than a status list. The invoices dialog owns behaviour the sales one lacks: single-invoice context with payment history, available credit-note application, overpayment→customer-credit preview, and the server-side receipt preview.
3. **Build the survivor** at `src/components/payments/RecordCustomerPaymentDialog.tsx` as the union: customer-first with an optional `invoice` pre-selection that renders the single-invoice affordances (history, credits, overpayment preview, receipt preview). Props are a superset of both current interfaces so call sites migrate without behaviour loss.
4. **Migrate call sites one page at a time** — Invoices, Customer Payments, Collections, then Accounts Receivable (which drops one of its two dialogs and its duplicated state).
5. **Delete both old files** and retarget the tests that read them by path (`invoice-payability-single-source.test.ts`, `print-preview-communication.test.ts`, and the count ratchet), tightening the ratchet from 2 files to 1 rather than weakening it.

## D6.3 — Documentation truth

- Amend ADR 0027 and ADR 0028: the legacy FK drops and writer migration are complete, not pending.
- New ADR: unreconciliation is a reclassification, not a reversal — void the settlement entry, re-post Dr Bank / Cr Customer Deposits, with the fiscal-period guard and per-payment idempotency stated.
- New ADR (or 0028 extension): supplier advances — `vendor_id` on the header, Vendor Credits as the holding account, allocate-later contract, single-supplier allocation rule, and the no-bank-re-credit rule.
- Refresh `mem/features/customer-payment-allocations.md` and `mem/features/vendor-payment-allocations.md` so nothing still reads as pending, and record the single-dialog rule.

## D7 — Ratchets

- **Request-key ratchet:** every money-in RPC exposes a request key, and no client call site invokes a settlement RPC without passing one. This is the test that would have caught the defect above.
- **AP writer monopoly ratchet:** only `record_multi_bill_payment`, `record_vendor_advance_payment` and `apply_vendor_advance_atomic` may write `bill_payments`, mirroring `journal-posting-monopoly.test.ts`.
- **Single payment dialog ratchet:** exactly one customer-payment recording component may exist.

## Technical notes

- No database work is expected. Everything remaining is client consolidation, documentation and CI guards.
- Posting, allocation, void, unreconcile and reversal semantics stay untouched — the audit found those layers sound.
- Regression risk concentrates in D6.2 (four pages change entry point). Mitigation: superset props, page-by-page migration, and the existing payability / print-preview architecture tests as the safety net.
- Verification: `bunx vitest run src/test/architecture src/test/payments`, plus a manual double-submit check on Receive Payment confirming a single payment row.
