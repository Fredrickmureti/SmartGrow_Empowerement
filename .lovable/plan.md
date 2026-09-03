# Smart Grow Empowerment — Microfinance Platform, Plan of Record

Reworked 2026-09-03 (seventh pass). One institution, employee-operated,
ASA-style model: branch → loan officer → group → client, individual obligors,
staff-only, no client portal. Backend: Supabase `xwxqunklduknceoryrha`, already
connected — never redo connection work.

## Locked decisions — do not re-litigate

REUSE as infrastructure, retargeted to microfinance wording and data: auth +
PIN + invitation, document generation engine, navigation / app shell / UI
system, Chart of Accounts + journals + GL + fiscal periods, banking + bank
reconciliation, the payment settlement & allocation engine, receivables /
payables engines (loan receivables, institution payables), statements engine,
fixed assets, company & general settings, audit logging, reporting engine,
storage, SMS.

OUT permanently: sales, purchases, POS, inventory/products, warehouse, CRM,
projects, HR, payroll, recruitment, attendance, localization/tax packs,
marketplace/entitlements, multi-tenancy, client portal.

Rules: no second implementation where a mature engine exists; no
frontend-authoritative financial math; individual and group repayment share one
code path and one allocation policy; one migration = one purpose; never build
microfinance surfaces over legacy ERP rows.

## STOP: ERP strip is closed

The schema is already down from 842 to ~398 public tables. POS, inventory,
warehouse, purchasing, payroll, localization packs, loyalty, physical counts,
eTIMS core and the sales pricing engine are gone. What remains of the old ERP
(delivery notes, sales orders, recurring invoices, sales returns, backorders,
carriers, remaining fiscal residue) is **inert**: no navigation, no hooks, no
UI. Its identifiers are woven through the document, outbox, audit and studio
metadata we are keeping, so further scrubbing costs credits and buys nothing.

Decision: **no more ERP-removal milestones.** Do not open new drop migrations
unless a specific ERP object actively blocks a microfinance change. Inherited
linter findings (~2,021, all pre-existing AccrualFlow surface) stay deferred
until the domain work is complete.

## Verified state (2026-09-03)

- Build OK, typecheck clean.
- Apps: `dashboard, finance, lending, platform, reports, studio`.
- `src/apps/lending` has real routed pages for clients, groups, products,
  applications, loans, repayments, collections, settings (accounting mappings)
  and five reports (portfolio, arrears, collections, disbursements, client
  statement). Only one placeholder surface remains in `routes.tsx`.
- 19 `mf_*` tables live with RLS. `mf_post_event → mf_resolve_account →
  post_journal_entry_atomic` is the financial authority; balances, arrears,
  PAR, installment status and statements are database views.
- Permissions: `user_has_module_permission` grants module `lending`;
  owner `fredrickmureti612@gmail.com` = `owner`, active.
- Document engine has lending snapshots (`services/documents/snapshots/lending.ts`).

## Active milestone — M4: Collections & repayment reality (ASA model)

Purpose: make daily field collection work end to end for both group meetings
and single-client payments, through the retained settlement engine.

1. Group collection sheet: officer opens a group meeting, sees every member's
   due installment, enters amounts per member in one submission. Each member's
   payment posts as its own `mf_` repayment event — no group-level pooled
   balance.
2. Single-client payment path shares the same server-side allocation call.
   Allocation order comes from configured policy, never hardcoded in React.
3. Overpayment / partial / advance handling defined in the backend; surplus
   held as client credit against future installments.
4. Cash handover: officer collections → branch cash → bank deposit, matched in
   the retained bank reconciliation.
5. Receipt document per payment through the document engine.

Done when: a group meeting and a walk-in payment both post journals, update the
schedule views, and produce receipts; the day's cash reconciles.

## Next milestones (one at a time, verify before moving on)

- **M5 — Statements & receivables retargeting.** Client and loan statements
  worded for microfinance (principal, interest, fees, penalties, arrears),
  driven by loan receivables rather than sales invoices.
- **M6 — Arrears, PAR and delinquency workflow.** Aging buckets, days past due,
  officer/branch portfolio views, promises to pay, visits, outcomes.
- **M7 — Loan lifecycle events.** Top-up and restructuring as distinct events
  (never `UPDATE loans`), write-off with approval + accounting treatment,
  controlled closure with full history preserved.
- **M8 — Reporting completion.** Officer collections, branch collections,
  product performance, client exposure, PAR aging — through the existing
  reporting engine, no new renderer.
- **M9 — Hardening.** RBAC and data-scope tests (officer sees only their
  portfolio), reversal/duplicate-prevention checks, then the deferred linter
  posture.

## Owner verification (open, preview only)

Authenticated checks cannot run from the sandbox (external Supabase). Sign in as
owner and confirm: `/lending` and children open; dashboard KPIs and PAR load;
one report, one client statement, one repayment receipt and one disbursement
confirmation render; a banked collection matches in bank reconciliation.

## Working rules

- Update this file after every milestone; factual and short.
- No exploratory audits, no standalone reports, no cosmetic refactors.
- Every change must serve the microfinance domain or unblock it.
