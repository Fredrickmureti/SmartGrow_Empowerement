# Microfinance Convergence — Authoritative Plan (reworked 2026-09-03, 12:2x UTC)

One institution, employee-operated microfinance platform built on the existing
codebase. Reuse proven engines; carry no ERP domain logic forward.

## Reuse decisions (final — do not re-litigate)

KEEP as infrastructure: auth/PIN + invite engine, document generation engine,
navigation/app shell + UI system, Chart of Accounts / journals / GL / fiscal
periods, banking + bank reconciliation, the payment/settlement + allocation
engine, fixed assets, audit logging, reporting engine, storage/file handling.

ADAPT (microfinance wording and data, same engine): receipts and settlement →
loan repayment receipts and disbursement confirmations; customer statement →
client statement and loan statement; receivables ageing → arrears / PAR;
deposits → officer collection banking of daily cash and mobile-money.

OUT (removed or left inactive): sales, purchases, POS, inventory/products,
warehouse, CRM, projects, HR, payroll, recruitment, attendance, timesheets,
marketplace/entitlements, multi-tenancy, client portal.

## Verified state (checked this session)

- `src/apps` = dashboard, finance, lending, platform, reports, studio only.
  Sales/purchases/POS/inventory/HR/payroll app trees are gone.
- `src/pages` and `src/features` hold only platform + finance + auth surfaces;
  no ERP sales/purchase/inventory pages remain.
- Backend microfinance domain live: 23 `mf_*` tables (clients, groups +
  members, loan products + versions, applications, assessments, loans,
  schedule, disbursements, events, repayments, allocations, batches,
  collection activities, account mappings, allocation policy, event postings)
  plus derived views (`mf_loan_balances`, `mf_loan_arrears`,
  `mf_loan_installment_status`, `mf_par_summary`, `mf_client_statement`).
  Financial authority is in the database, not the browser.
- Lending frontend complete for: clients, groups, products/versions,
  applications (form → assessment → decision), loans (create, disburse,
  schedule, lifecycle), repayments, collections, 5 reports, accounting
  mappings, documents through the shared engine.
- C12 RBAC gating and C13 accounting integration (`mf_post_event` →
  `mf_resolve_account` → `post_journal_entry_atomic`) verified DONE.
- C15a ERP surface strip DONE: permission modules trimmed to
  contacts/financials/lending/settings/team; app catalogue exposes Lending as a
  core app, all ERP/HR apps unavailable and hidden.

## Milestones — one at a time, verify before advancing

### C14 — Cash & settlement retarget (NEXT, in execution order)

Operating model reference: ASA-style group lending with a field officer who
banks daily collections, while individual client payments remain fully
supported. Both paths must post through the same authoritative engine.

1. Cash receipt path: record repayment at branch cashier, officer field
   collection, or mobile money; every receipt lands as a `mf_repayment` and
   posts via `mf_post_event` with the configured cash/bank/mobile-money account.
2. Officer collection sheet + batch banking: reuse `mf_repayment_batches` and
   the existing bank deposit surface so a batch of receipts settles into one
   bank/branch account movement, reconcilable against the bank statement.
3. Group vs individual: group batches allocate to each member's own loan; a
   single client payment uses the identical allocation policy. No parallel code
   path, no frontend allocation math.
4. Statements: retarget the statement surfaces to client statement and loan
   statement (from `mf_client_statement` + schedule/repayment data), rendered
   through the document engine with company settings injected.
5. Reconciliation: microfinance receipts and disbursements appear as matchable
   items in the existing bank reconciliation, with no ERP invoice/bill terms in
   the UI.

Scope guard: adapt existing banking/settlement services and screens only. No
new engine, no schema duplication, no savings product (out of scope until the
SRD requires it).

### C15b — Dead-code strip & hardening (LAST)

- Remove ERP-only pages/services/features not reachable from dashboard,
  finance, lending, platform, reports, studio — confirm by import graph first.
- Prune `src/parked-modules.d.ts` stubs no retained file needs.
- Close-out: typecheck, build, permission/RLS pass, one full loan lifecycle
  (apply → approve → disburse → repay → arrears → close/write-off), one report
  render, one document render.

## Rules

- No payroll, HR product, multi-tenancy, client portal, or ERP workflow revival.
- Never a second implementation where a mature engine exists — adapt it.
- No frontend-authoritative financial math; balances, interest, arrears and
  allocations come from the database.
- Do not investigate, document, or polish anything outside microfinance scope.
