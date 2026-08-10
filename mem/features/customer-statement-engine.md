---
name: Customer statement single engine
description: Customer statements project ONE dataset folded from customer_ledger_entries; no path may re-derive from invoices/payments/credit_notes
type: feature
---
The customer statement has exactly one engine.

- Source of truth: `customer_ledger_entries` (posted AR subledger), read via
  `src/services/finance/customerStatementLedger.ts` (`fetchCustomerLedgerRows`)
  with org + business + branch isolation.
- Fold: `src/services/finance/customerStatementDataset.ts`
  (`buildStatementDataset`) — pure, dependency-free, deterministic (no clock).
  Mirrored byte-identically at
  `supabase/functions/_shared/reports/customerStatementDataset.ts`.
  opening = Σ(debit−credit) for entry_date < period_start; closing = opening +
  in-period movement. Other-currency activity is disclosed, never summed.
- Consumers: `useCustomerStatements` (screen), `salesCustomerStatement.ts`
  (PDF/CSV/XLSX snapshot), `generate-document` edge fetcher (emailed PDF).
- Aging: GL-anchored open items (`finance_ar_open_items`), aged **as of the
  period end**, never the server clock. Bucket labels/boundaries come from
  `src/services/finance/aging.ts`.
- Never re-derive a statement from `invoices` / `payments` / `credit_notes`.
  `credit_note_status` has no `partially_applied` value — filtering on it
  caused HTTP 400.
- Guard: `src/test/architecture/customer-statement-dataset-parity.test.ts`.

Retired (do not reintroduce): the raw-table snapshot query, the second edge
statement derivation, and `send-document-email`'s "statement id not found →
email the customer's latest statement" fallback (it emailed the wrong period).

The **vendor** (AP) statement is converged the same way:
`vendor_ledger_entries` → `fetchVendorLedgerRows` →
`buildVendorStatementDataset` (sign-swaps GL→statement, then reuses the AR
accumulator; mirrored to `_shared/reports/vendorStatementDataset.ts`) →
screen hook, `purchasesVendorStatement.ts` snapshot, and the
`fetchVendorStatement` edge fetcher. Aging from `finance_ap_open_items` as of
the period end. Never re-derive from bills / bill_payments /
vendor_credit_notes.
