# ADR 0029 — Single AR balance engine (GL-anchored subledger)

## Status
Accepted — 2026-06-02

## Context
Two reports computed customer balance from different substrates:

1. **Sales Customer Ledger** (`/sales/customers/:id/ledger`) read the
   `customer_ledger_entries` view, defined as a `UNION ALL` over five
   source-document tables (invoices, payment_allocations, unapplied
   payments, credit_notes, customer_refunds). ADR 0027 named this the
   "single source of truth".
2. **Finance Partner Ledger** (`/reports/partner-ledger`) re-aggregated
   `journal_entry_lines` filtered by `status='posted'` and
   `contact_id IS NOT NULL`, with **no** filter on `account_id`. It
   summed Dr/Cr across every GL line that happened to carry a
   `contact_id` — Sales, Discount, Tax, Customer-Deposits, etc.

Result: two engines on two substrates with no tie-out. Per-invoice
Engine B inflated balances by up to Nx depending on how many non-AR
legs the posting RPCs stamped with `contact_id`. Reversal model (ADR
0012) and unapplied-deposit representation widened the gap further.

This violates the universal ERP pattern (SAP, NetSuite, D365 BC, Odoo,
ERPNext, QuickBooks): the partner subledger is **a filtered view of
the GL on the control account(s)**, not an independent re-aggregation
of source documents. There is exactly one balance engine.

## Decision

### Canonical AR truth
- New helper `public.is_ar_control_account(account_id) RETURNS boolean`
  identifies AR control accounts via `accounts.system_role =
  'accounts_receivable'`.
- New view `public.ar_subledger_entries` is the single physical truth
  for customer balance — posted `journal_entry_lines` whose `account_id`
  is an AR control account. Columns: `contact_id`, `branch_id`,
  `entry_date`, `entry_number`, `debit`, `credit`, `source_type`,
  `source_id`, `currency`, `journal_entry_id`.
- `public.customer_ledger_entries` is rewritten as a **thin display
  projection** over `ar_subledger_entries`, joining back to invoices /
  payments / credit_notes only for `doc_type` and `doc_ref` labels.
  The legacy 5-way UNION over source documents is removed.

### Read contract
- Sales Customer Ledger continues to call `useCustomerLedger`. The hook
  is unchanged on the surface; its data now originates from the GL.
- Finance Partner Ledger (`src/pages/reports/PartnerLedger.tsx`)
  reads `customer_ledger_entries` (customers) and
  `vendor_ledger_entries` (suppliers). The
  `journal_entry_lines + contact_id` aggregation path is **removed**.
- Statements, aging, collections, dashboard AR KPIs, and
  `finance_ar_open_items` continue to read the same view; no caller
  changes required since the view contract is preserved.

### Invariants
1. Customer balance = Σ(`debit − credit`) over `ar_subledger_entries`
   for a contact. This is, by construction, identical to the GL balance
   of the AR control account scoped to that contact.
2. The Sales Customer Ledger and Finance Partner Ledger now consume the
   same view; divergence is structurally impossible.

## Out of scope (follow-ups)
- **B1.** `ap_subledger_entries` mirror over AP control accounts; AP
  parity with this ADR. Currently the supplier side of Partner Ledger
  reads `vendor_ledger_entries` (ADR 0028), which is still a source-
  doc UNION. Risk class is identical; fix is the same shape.
- **B1.** Invariant trigger on `journal_entry_lines`: AR control legs
  MUST have `contact_id`; non-AR legs SHOULD NOT (with a known
  allow-list for Customer Deposits / Bad Debt). Shipped first as
  telemetry, promoted to hard reject after measurement.
- **B3.** `ar_control_tieout` view + scheduled alert comparing GL
  balance of AR control vs Σ subledger open items per contact.
- **B3.** Drop `payments.invoice_id` permanently (deprecated per ADR
  0027; UI readers already repointed).
- Multi-currency FX revaluation of AR.
- Historical data fix for any JE that stamped `contact_id` on non-AR
  legs (the new view filters them out, so no double-count from this
  point forward, but legacy reports that re-aggregated GL by contact
  may need a one-time restatement).

## Architectural test (follow-up)
`src/test/architecture/single-customer-balance-engine.test.ts` should:
- Ban `journal_entry_lines` reads with `.not("contact_id", "is", null)`
  outside the `ar_subledger_entries` / `vendor_ledger_entries` view
  definitions.
- Require `PartnerLedger.tsx` to read `customer_ledger_entries` /
  `vendor_ledger_entries`, never `journal_entry_lines` directly.
- Pin a single running-balance helper module as the only allowed
  client-side balance calculator.

## References
- ADR 0012 — Payment reversal intent model.
- ADR 0027 — Allocation-first customer payments (now amended: the
  subledger is GL-derived, not source-doc-derived).
- ADR 0028 — Allocation-first vendor payments.
- Migration: `..._single_ar_balance_engine.sql`
- View: `public.ar_subledger_entries`
- Audit: this turn's plan in `.lovable/plan.md`.
