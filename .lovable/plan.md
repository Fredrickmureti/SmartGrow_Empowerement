# Smart Grow Empowerment — Microfinance Platform, Plan of Record

Reworked 2026-09-04. One institution, employee-operated, ASA-style: branch →
loan officer → group → client, individual obligors, staff-only, no client
portal. Backend: Supabase `xwxqunklduknceoryrha` (connected — never redo).

## Locked decisions — do not re-litigate

REUSE as infrastructure, retargeted to microfinance: auth + PIN + invitation,
document engine, navigation / app shell / UI system, Chart of Accounts +
journals + GL + fiscal periods, banking + reconciliation, payment settlement &
allocation engine, receivables/payables engines, statements engine, fixed
assets, company settings, audit logging, reporting engine, storage, SMS.

OUT permanently: sales, purchases, POS, inventory, warehouse, CRM, projects,
HR, payroll, recruitment, localization/tax packs, marketplace/entitlements,
multi-tenancy, client portal.

Rules: no second implementation where a mature engine exists; no
frontend-authoritative financial math; individual and group repayment share one
code path and one allocation policy; one migration = one purpose; never build
microfinance surfaces on legacy ERP rows.

## ERP strip is CLOSED

Schema is down from 842 to ~398 public tables. What remains of the old ERP is
inert (no nav, no hooks, no UI) and its identifiers are woven through document,
outbox and audit metadata we keep. **No further ERP-removal milestones.** Open a
drop migration only when a specific ERP object blocks a microfinance change.
Inherited linter findings stay deferred until the domain work is complete.

## Verified state (2026-09-04)

- Build OK, typecheck clean.
- Apps: `dashboard, finance, lending, platform, reports, studio`.
- Lending has routed pages for clients, groups, products, applications, loans,
  repayments, collections, settings (accounting mappings + allocation policy).
- 19 `mf_*` tables with RLS. `mf_post_event → mf_resolve_account →
  post_journal_entry_atomic` is the financial authority; balances, arrears,
  PAR, installment status and statements are DB views.
- Owner `fredrickmureti612@gmail.com` = `owner`, active;
  `user_has_module_permission` grants module `lending`.

### Completed milestones
- **M4 — Collections & repayment (ASA).** Group collection sheet posting one
  receipt per member, single-client payments on the same RPC, allocation order
  from `mf_allocation_policy` (editable in Lending → Settings), overpayment held
  as client credit and auto-consumed, per-payment receipt document, cash
  handover → bank batch → bank reconciliation.
- **M5 — Statements & receivables retargeting** (loan/client statements driven
  by loan receivables, microfinance wording).
- **M6 — Arrears, PAR, delinquency workflow** (aging, DPD, promises to pay,
  visits, outcomes).
- **M7 — Loan lifecycle events** (top-up, restructuring, write-off, closure as
  events, never `UPDATE loans`).
- **M8 — Reporting completion (2026-09-04).** Nine lending reports live through
  the existing engine, no new renderer: portfolio, arrears & PAR, collections,
  disbursements, client statement, officer & branch collections, PAR aging,
  product performance, client exposure. Hooks in `src/hooks/useMfReports.ts`
  read server views only; all routed under `viewLendingReports` and listed in
  the lending nav "Insights" group.

## Next milestone

**M9 — Hardening.** In this order, one at a time, verify before moving on:
1. Data scope: an officer sees only their own portfolio across clients, loans,
   repayments, collections and every report (RLS + hook filters).
2. Financial integrity: reversal and duplicate-prevention checks on
   disbursement and repayment; no path mutates posted journals.
3. RBAC: each role reaches only its permitted lending surfaces.
4. Then the deferred linter posture.

## Owner verification (open, preview only)

Authenticated checks cannot run from the sandbox (external Supabase). Sign in as
owner and confirm: `/lending` and children open; dashboard KPIs and PAR load;
the four new reports render and export; one client statement, one repayment
receipt and one disbursement confirmation print; a banked collection matches in
bank reconciliation.

## Working rules

- Update this file after every milestone; factual and short.
- No exploratory audits, no standalone reports, no cosmetic refactors.
- Every change must serve the microfinance domain or unblock it.
