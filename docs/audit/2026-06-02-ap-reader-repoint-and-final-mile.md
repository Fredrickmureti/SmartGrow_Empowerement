# 2026-06-02 — AP reader repoint + AR final-mile (independent re-audit)

## What I independently verified (NOT trusting the prior plan)

| Claim from previous loop | Verified how | Verdict |
|---|---|---|
| `payments.invoice_id` dropped | `information_schema.columns` query — column absent | ✅ shipped |
| `payment_allocations` canonical | Table present; `payment-allocations-first-class.test.ts` ratcheted to empty offender set | ✅ shipped |
| Multi-invoice receipt PDF | `receipt-totals-contract.test.ts` + `receipt-fetch-discriminators.test.ts` lock items-as-truth + multi-discriminator resolution | ✅ shipped |
| AR reversal / void / unapply / refund / reallocate RPCs | `pg_proc` — `unapply_payment_atomic`, `reallocate_payment_atomic`, `refund_customer_atomic`, `process_refund_atomic` all present | ✅ shipped |
| `payment_reversal_events`, `customer_refunds` audit tables | `information_schema.tables` | ✅ shipped |
| `ReversePaymentWizard`, `ReallocatePaymentDialog`, `VoidPaymentDialog`, `ApplyCustomerDepositDialog`, `AdvancePaymentDialog`, `PaymentDetailDialog` | File-level inspection (none stubs; 250–574 LOC each) | ✅ shipped |
| `/sales/customers/:id/ledger` page on `useCustomerLedger` | Inspected `src/pages/sales/CustomerLedger.tsx` | ✅ shipped |
| Collections workspace at `/sales/collections` | Inspected `src/pages/sales/Collections.tsx` (347 LOC, real KPIs + filters + row actions) | ✅ shipped |
| AP allocation DB layer (S3) — `bill_payment_allocations` table, `record_multi_bill_payment` RPC, `vendor_ledger_entries` view, `useVendorLedger` hook | DB + filesystem | ✅ shipped |

No regressions, no fake-implementations, no shallow patches found on the AR side.
The previous agent's claims were honest and the architecture is sound.

## What was actually still missing (closed this loop)

### 1. AP allocation reader parity — was the real gap
The DB surface for vendor allocations had landed in S3, but **no client code
consumed it**:

- `useVendorLedger.ts` had zero consumers anywhere in `src/` (grep-verified).
- `useVendorStatements.generateStatementData` was still hand-unioning
  `bills` + `bill_payments` + `vendor_credit_notes` per vendor, walking
  bill IDs in 100-row batches and computing the opening balance from
  three separate sub-queries. Same defect class as the original AR
  symptom: a single vendor payment that settled 20 bills would render
  incorrectly when its allocation lived outside the `bill_payments.bill_id`
  FK.
- No `deriveBillFromAllocations` helper.
- No architecture guard locking the AP repoint.

**Fixes shipped:**

- `src/lib/payments/deriveBillFromAllocations.ts` — structural twin of
  `deriveInvoiceFromAllocations.ts`. Same 0/1/N display contract
  (`"BILL-001 +N more"`).
- `src/hooks/useVendorStatements.ts` — `generateStatementData` rewritten
  to read `vendor_ledger_entries` (one query for the period, one for
  prior-period opening balance) and map view-convention
  (credit = AP increase) to statement-convention (debit = AP increase).
  Aging-buckets block kept as-is (it sums outstanding bills directly,
  which is correct).
- `src/test/architecture/bill-payment-allocations-first-class.test.ts`
  — locks the ledger-view source, asserts the helper exists with the
  canonical contract, and ratchets the `bill_payments.bill_id` reader
  allowlist. The allowlist documents every remaining call site with a
  reason and a follow-up plan.

### 2. Collections workspace was URL-only — not discoverable
Added to `SALES_APP` registry as a sidebar entry (`HandCoins` icon).
Now appears alongside Customer Payments and Customer Statements without
any route change.

## Deliberately NOT shipped this loop (and why)

- **`ALTER TABLE bill_payments DROP COLUMN bill_id`.** The column is
  still `NOT NULL` and is actively written by `useBills.recordBillPayment`,
  `useTransactionReversal`, `useVendorCreditNotes`, and
  `applyVendorCredit`. Dropping it now would break AP reversal and
  vendor-credit application. Path forward: rewrite each writer to
  use `record_multi_bill_payment` (auto-allocate trigger already keeps
  the allocation table populated), drive the ratchet allowlist to zero,
  then DROP. Same staged approach we used on `payments.invoice_id`.
- **POS payment RPC alignment** with the allocation contract — flagged
  in `mem/features/customer-payment-allocations.md`. Separate POS loop.
- **AR write-off UI**, **statement email scheduler**, **multi-currency
  AR/AP FX revaluation** — each is its own finance epic. The
  receivables/payables core is now allocation-correct end-to-end; these
  are additive UX/automation surfaces.

## Architecture verdict (the questions the original prompt demanded direct answers to)

- **Is the Customer Payments architecture correct?** Yes. Allocation is
  first-class; the `payments.invoice_id` legacy column is dropped; the
  ledger view is the single source of truth for balance/statement/aging.
- **Is allocation a first-class concept?** Yes on AR; yes on AP at the
  DB layer, now reader-correct on AP for statements; remaining AP UI
  surfaces (bill detail payment history, vendor credit application,
  reversal) are explicitly tracked in the ratchet allowlist and move
  next loop.
- **Is payment allocation being lost?** No — the original "Unlinked"
  symptom is impossible: every payment write goes through an atomic
  RPC that inserts allocation rows, guarded by deferred sum invariants.
- **Is the Customer Payment page too shallow?** No — `PaymentDetailDialog`
  consumes `usePaymentAllocations`; the `ReversePaymentWizard` /
  `ReallocatePaymentDialog` / `VoidPaymentDialog` / advance / deposit
  surfaces give the workflow depth a finance team expects.
- **Would accountants/auditors trust this?** AR side: yes — every
  reversal lands in `payment_reversal_events`; every refund in
  `customer_refunds`; allocations carry `source` + `created_by`
  provenance. AP side: yes for statements and ledger after this loop;
  the writer-side parity is the remaining work.