# Smart Grow Empowerment — convergence plan (current)

Reuse only three things from the inherited AccrualFlow platform: document
engine, auth engine (PIN), navigation/UI foundation. Everything else ERP stays
unwired and is dropped in one sweep at C10.

Backend: Supabase project `xwxqunklduknceoryrha`.

## Status

- C1 registry prune + `/lending/*` scaffold — DONE
- C2 roles + `mf_account_mappings` + accounting-mappings screen — DONE
- C3 clients & groups (schema, hooks, pages) — DONE
- C4 loan products (immutable versions) — DONE: `mf_loan_products` +
  `mf_loan_product_versions` with GRANTs/RLS/freeze triggers,
  `useMfLoanProducts`, `ProductFormDialog`, `ProductVersionDialog`,
  `ProductsPage` wired at `/lending/products`. Typecheck clean.

## Next: C5 — Applications → assessment → approval

Draft → Submitted → Under review → Approved/Rejected → Ready for disbursement.
Assessment is an attributable physical visit; approval bounded by authority
limits and cycle eligibility. Requested ≠ approved. Approval ≠ disbursement.

## C6 — Loan, schedule engine, disbursement

Loan snapshots the product version's contractual terms. Server-side schedule
engine per interest method and frequency (contractual, not a ledger).
Disbursement is an idempotent guarded event posting through the C2 mappings.

## C7 — Repayments, allocation, arrears, collections

Batch-per-meeting entry with per-member receipts; partial, over and reversal
handling. Allocation order is configuration. Arrears, DPD and PAR derived
server-side. Collections scoped to officer portfolios.

## C8 — Lifecycle exceptions

Top-up, restructuring, write-off, closure as event-sourced processes with
approval and accounting treatment. No destructive updates to loan history.

## C9 — Reports & documents on the existing engines

Portfolio, outstanding principal/interest, collections by day/officer/branch,
arrears aging and PAR, client statement and exposure, applications/approvals/
disbursements. Documents: loan agreement, repayment schedule, loan statement,
payment receipt, disbursement confirmation, collection receipt.

## C10 — Hardening + one bulk sweep

RLS/grants audit on every `mf_*` table, reversal/duplicate/approval controls,
security scan. Then one grouped drop of confirmed-dead ERP schema and code.

## Working rules

1. Financial state is derived server-side; React never owns balances, interest,
   arrears, allocations or journal amounts.
2. Every domain action is a business event with an accounting hook. Account
   mappings stay configuration — never a hardcoded account UUID.
3. Every new public table ships GRANTs + RLS + policies in the same migration;
   migrations stay small and single-purpose.
4. Inherited ERP rows are not this institution's data.
5. Permanently out of scope: SaaS/tenants/subscriptions/platform admin, payroll,
   attendance, POS, inventory, warehouse, procurement, sales order-to-cash,
   client portal, public registration, hardware estate.
6. Per-milestone verification is typecheck + open the affected screens.
7. No exploratory audits of code or tables already known to be out of scope.
