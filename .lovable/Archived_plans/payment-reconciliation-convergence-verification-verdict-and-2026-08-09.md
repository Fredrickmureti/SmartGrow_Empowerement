# Payment & Reconciliation Convergence — Verification Verdict and D6/D7

## Phase 1 verdict: the previous engineer's claims check out

I re-verified every "shipped" claim directly against the live database and the
codebase rather than trusting the status file.

Confirmed true:

- **Money-in idempotency (D1/D2).** `payments.client_request_id` and
  `bill_payments.client_request_id` both exist. `record_multi_invoice_payment`
  and `record_payment_atomic` both carry a `_request_id` argument;
  `record_multi_bill_payment` carries `_request_id` plus withholding-tax args.
- **Unreconcile accounting (D3).** `unreconcile_payment_atomic(_payment_id,
  _reason, _actor)` is a single definition and its body does post the
  `payment_unreconcile` reclassification entry, so cash is reclassified rather
  than destroyed.
- **Bank reconciliation hardening (D5).** `reconcile_bank_transaction_atomic`
  has exactly **one** signature and it ends in `_client_request_id` — the old
  7-argument overload really was dropped, so there is no ambiguity.
- **Supplier advances (D4).** `bill_payments.vendor_id`,
  `vendor_advance_account(business_id)` and `record_vendor_advance_payment(...,
  _request_id)` all exist. The backfill is clean: zero supplier payments have
  allocations but a null vendor.
- **Legacy columns retired.** `payments.invoice_id` and `bill_payments.bill_id`
  are both gone from the schema — allocation-first is now structural, not
  aspirational.

Confirmed still open (matches the status file, no hidden regressions found):

- `recordVendorAdvance` exists in `src/hooks/useBills.ts` but **has no caller**.
  The supplier-advance business event is reachable from code only, never from
  an operator's screen. AR has the mirror surfaces (Customer Credits, Apply
  Customer Deposit, Reallocate Payment); AP has none of them.
- Two competing customer-payment dialogs are live:
  `src/components/invoices/RecordPaymentDialog.tsx` (556 lines) and
  `src/components/sales/RecordPaymentDialog.tsx` (451 lines). Accounts
  Receivable imports **both** in the same page — the clearest evidence of drift.
- ADR 0028 still documents `bill_payments.bill_id` as a pending drop and lists
  writer migration as deferred, both of which are now done. ADR 0027 has the
  same staleness. No ADR records the unreconcile reclassification rule or the
  supplier-advance model, so both can be silently regressed.
- No ratchet enforces request keys on money-in RPCs, and nothing stops a second
  writer inserting into `bill_payments`.

Nothing the previous engineer claimed was found to be superficial or wrong, so
work resumes at **D6** as they intended — but with the vendor-advance operator
surface treated as the first item, since a business event with no way to
trigger it is an incomplete feature, not a UI nicety.

## D6 — Operator surfaces, dialog consolidation, documentation

### D6.1 Supplier advances become operator-reachable (AP/AR parity)

Business event: *business pays a supplier before any bill exists.* Today it
posts correctly (Dr Vendor Credits / Cr Bank) but only from code.

- Add a **Vendor Credits** page mirroring the existing Customer Credits page:
  lists supplier payments with unallocated cash, computed from
  `bill_payments.amount` minus the sum of its live allocations.
- Add a **Record Vendor Advance** dialog calling `recordVendorAdvance`, with a
  deterministic request key so a double submit cannot mint two advances.
- Add an **Apply Vendor Credit** dialog that allocates an existing advance to
  open bills through the canonical `record_multi_bill_payment` — no second AP
  writer is introduced.
- Surface unapplied vendor cash on Accounts Payable and the vendor ledger so
  the AP balance an operator sees accounts for cash already paid out.

### D6.2 One customer-payment dialog

- Compare the two dialogs field by field and keep the superset behaviour
  (multi-invoice allocation, overpayment-to-credit, FX rate capture, request
  key) in a single component under `src/components/payments/`.
- Repoint Invoices, Customer Payments, Accounts Receivable and Collections at
  it; delete the losing implementation.
- Update the two architecture tests that reference the old paths so the guard
  follows the surviving file rather than being weakened.

### D6.3 Documentation truth

- Amend ADRs 0027 and 0028: mark the legacy FK drops and writer migration as
  completed, so no future engineer plans work that is already done.
- New ADR: **unreconciliation is a reclassification, not a reversal** — voiding
  the settlement entry and re-posting Dr Bank / Cr Customer Deposits, with the
  fiscal-period guard and per-payment idempotency spelled out.
- New ADR (or an 0028 extension): **supplier advances** — `vendor_id` on the
  header, Vendor Credits as the holding account, allocate-later contract, and
  the single-supplier allocation rule.
- Refresh the project memory entries for customer and vendor allocations so the
  "pending" sections reflect reality.

## D7 — Ratchets

- **Request-key ratchet.** Assert every money-in RPC exposes a request key and
  that no client call site invokes a settlement RPC without passing one.
- **AP writer monopoly ratchet.** Only `record_multi_bill_payment` and
  `record_vendor_advance_payment` may insert into `bill_payments`; anything
  else fails CI, mirroring the existing journal-posting monopoly test.
- **Single payment dialog ratchet.** Fail the build if a second
  customer-payment recording component reappears.

## Technical notes

- All new AP behaviour reuses existing RPCs; the only possible database work is
  a read-side view for unapplied vendor cash if the client-side computation
  proves too heavy on large ledgers.
- Regression risk concentrates in D6.2: four pages change their payment entry
  point at once. Mitigation is to keep the surviving component's props a
  superset and migrate call sites one page at a time, with the existing
  payability and print-preview architecture tests as the safety net.
- No changes to posting, allocation, void or reversal semantics are proposed —
  the audit found those layers sound and they stay untouched.
