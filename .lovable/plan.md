
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

## M4 — Collections & repayment reality (ASA model) — COMPLETE (2026-09-03)

Verified in code/DB, not claimed:
1. Group collection sheet in Lending → Repayments: officer picks group +
   meeting date, sees every active member's next installment, arrears and DPD
   (server-derived), enters amounts, one submission posts each line as its own
   receipt via `mf_record_repayment`. No pooled group balance.
2. Single-client payment uses the same RPC and allocation path.
3. Allocation order reads `mf_allocation_policy` (no server-side hardcode) and
   is now editable at Lending → Settings (Payment allocation policy card).
4. Overpayment is held as client credit (`advance` allocation → `client_advance`
   liability) and is now automatically consumed by the next receipt; the
   journal debits `client_advance` when credit is spent.
5. Receipt document per payment from the repayments list via the document
   engine (`loan_payment_receipt`), which covers group-sheet lines too.
6. Cash handover path: officer collections → branch cash → bank batch
   (`BankBatchDialog`) → retained bank reconciliation.

Owner still to confirm in preview (authenticated checks cannot run from the
sandbox): a group meeting and a walk-in payment both post journals, update the
schedule, and print receipts.


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

## Next milestone

**M5 — Statements & receivables retargeting.** Client and loan statements
worded for microfinance (principal, interest, fees, penalties, arrears, client
credit), driven by loan receivables rather than sales invoices. Then M6-M9 as
listed above.
