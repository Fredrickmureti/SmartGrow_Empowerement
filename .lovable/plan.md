# Payment & Reconciliation Convergence — Remaining Work (D6.2, D6.3, D7)

## Where things stand

D6.1 is complete and closed. Supplier advances are now operator-reachable:

- `vendor_unapplied_advances` view is the single source of truth for supplier cash paid but not yet applied.
- `apply_vendor_advance_atomic` applies an advance to bills as a reclassification (Dr Accounts Payable / Cr Vendor Credits) — it never re-credits the bank, so cash cannot be double-counted.
- `record_multi_bill_payment` now honours the request key properly, so a double submit cannot mint a second payment or overwrite an operator's reference.
- New surfaces: Vendor Credits page, Record Vendor Advance dialog, Apply Vendor Advance dialog, plus route and sidebar entry.

Three items from the original plan are still open, and they are wider than a cleanup pass, so the plan stays open with them as the remaining scope.

## D6.2 — One customer-payment dialog

Two competing dialogs are live and Accounts Receivable imports both:

- `src/components/invoices/RecordPaymentDialog.tsx`
- `src/components/sales/RecordPaymentDialog.tsx`

Work:

- Compare both field by field and keep the superset behaviour — multi-invoice allocation, overpayment-to-credit, FX rate capture, request key — as one component under `src/components/payments/`.
- Repoint Invoices, Customer Payments, Accounts Receivable and Collections at the survivor, one page at a time.
- Delete the losing implementation and update the two architecture tests that reference the old paths so the guard follows the survivor rather than being weakened.

## D6.3 — Documentation truth

- Amend ADRs 0027 and 0028: the legacy FK drops and the writer migration are done, not pending.
- New ADR: unreconciliation is a reclassification, not a reversal — void the settlement entry, re-post Dr Bank / Cr Customer Deposits, with the fiscal-period guard and per-payment idempotency spelled out.
- New ADR (or an 0028 extension): supplier advances — `vendor_id` on the header, Vendor Credits as the holding account, the allocate-later contract, the single-supplier allocation rule, and the no-bank-re-credit rule proven out in D6.1.
- Refresh the customer and vendor allocation memory entries so nothing still reads as "pending".

## D7 — Ratchets

- Request-key ratchet: every money-in RPC must expose a request key, and no client call site may invoke a settlement RPC without passing one.
- AP writer monopoly ratchet: only `record_multi_bill_payment`, `record_vendor_advance_payment` and `apply_vendor_advance_atomic` may touch `bill_payments`; anything else fails CI, mirroring the journal-posting monopoly test.
- Single payment dialog ratchet: fail the build if a second customer-payment recording component reappears.

## Technical notes

- No further database work is expected. Everything remaining is client consolidation, documentation and CI guards.
- Regression risk concentrates in D6.2, where four pages change their payment entry point. Mitigation: keep the surviving component's props a superset, migrate call sites one page at a time, and lean on the existing payability and print-preview architecture tests as the safety net.
- Posting, allocation, void and reversal semantics stay untouched.
