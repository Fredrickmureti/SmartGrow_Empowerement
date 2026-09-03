# Smart Grow Empowerment — Microfinance Platform, Plan of Record

Reworked 2026-09-03 (second pass, after live database verification). One
institution, employee-operated microfinance platform on the ASA-style branch /
loan-officer / group model, built on the existing platform engines. Supabase
project `xwxqunklduknceoryrha` (Smart Grow Empowerment) is already connected —
no reconnection work needed.

## Locked decisions — do not re-litigate

REUSE as infrastructure, adapt data and wording only, never rebuild: auth/PIN +
invitation engine, document generation engine, navigation / app shell / UI
system, Chart of Accounts + journals + GL + fiscal periods, banking + bank
reconciliation, payment settlement + allocation engine, fixed assets, company &
general settings, audit logging, reporting engine, storage/files.

ALREADY ADAPTED to microfinance: settlement receipts → loan repayment receipts
and disbursement confirmations; customer statement → client + loan statement;
receivables ageing → arrears / PAR; deposits → officer banking of daily cash and
mobile money.

OUT permanently: sales, purchases, POS, inventory/products, warehouse, CRM,
projects, HR, payroll, recruitment, attendance, timesheets, marketplace /
entitlements, multi-tenancy, client portal.

## Verified state (checked against code and the live database, 2026-09-03)

- `src/apps` = dashboard, finance, lending, platform, reports, studio. `src/pages`
  holds only auth, platform, finance (accounts, journals, fiscal periods, fixed
  assets, banking, feeds, reconciliation), reports, settings, team, studio. No
  ERP sales/purchase/inventory/HR/payroll surface remains.
- 25 `mf_*` objects live (20 tables + 5 derived views). Financial authority is
  server-side: `mf_post_event` → `mf_resolve_account` →
  `post_journal_entry_atomic`; balances, arrears, PAR, installment status and
  client statement are database views.
- Lending frontend complete: clients, groups, products + versions, applications
  (form → assessment → decision), loans (create, disburse, schedule, lifecycle),
  repayments (individual and group-meeting batch on one allocation policy),
  collections, 5 reports, accounting mappings, documents via the shared engine.
- RBAC gating, accounting integration, cash & settlement retarget, ERP surface
  strip and dashboard retarget: DONE.
- Baseline data now exists and one individual lifecycle has run end to end:
  12 account mappings, 1 allocation policy, 1 product + version, 1 client,
  1 application + assessment, 2 loans, 2 disbursements, 8 loan events,
  10 schedule rows, 2 repayments, 3 allocations, 6 event postings.
- Not yet exercised anywhere: groups (0), group members (0), repayment batches
  (0), collection activities (0), collection bankings (0). The group and cash
  banking legs are therefore unverified, not unbuilt.

## M1 — Close the unverified legs (NEXT, only remaining functional work)

1. Group leg: create one group with a leader and 3 members under a branch loan
   officer; run one group-loan application → approval → disbursement.
2. Group-meeting repayment batch: collect from several members in one batch,
   confirm each member's allocation follows the single allocation policy and that
   group membership creates no joint liability on individual balances; close the
   batch (closed batch must stay immutable — already enforced server-side).
3. Cash leg: record a collection activity, bank the day's cash/mobile money via
   collection banking, then match it in bank reconciliation; confirm the journal
   postings land on the mapped accounts.
4. Verify against this data: dashboard KPIs, arrears / PAR (`mf_par_summary`
   must return amount and percentage and match the KPI label), one report
   render, one client statement, one repayment receipt, one disbursement
   confirmation.
5. Fix the shell hydration mismatch logged on load.

Exit: every step observed working in the running app; discrepancies fixed in
code, not written up.

## M2 — Dead-code strip and hardening (LAST)

- Confirm by import graph, then remove `useDashboardStats`,
  `useDashboardAnalytics` (ERP revenue/expense math, reachable only from
  `AIInsightsWidget` and `useDashboardComposition`) and the module/entitlement
  gating they carry.
- Prune `src/parked-modules.d.ts` stubs no retained file needs.
- Close out: typecheck, build, permission/RLS pass.

## Rules

- No payroll, HR product, multi-tenancy, client portal, or ERP workflow revival.
- Never a second implementation where a mature engine exists — adapt it.
- No frontend-authoritative financial math; balances, interest, arrears and
  allocations come from the database.
- Individual and group repayment share one code path and one allocation policy.
- Do not investigate, document, or polish anything outside microfinance scope;
  no standalone audit reports.
