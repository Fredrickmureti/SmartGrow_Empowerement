# Smart Grow Empowerment — Microfinance Platform, Plan of Record

Reworked 2026-09-04 (second rework). One institution, employee-operated,
ASA-style: branch → loan officer → group → client, individual obligors,
staff-only, no client portal. Backend: Supabase `xwxqunklduknceoryrha`
(connected — never redo).

## Locked decisions — do not re-litigate

REUSE as infrastructure, retargeted to microfinance: auth + PIN + invitation,
document engine, navigation / app shell / UI system, Chart of Accounts +
journals + GL + fiscal periods, banking + reconciliation, payment settlement &
allocation engine, statements engine, fixed assets, company settings, audit
logging, reporting engine, storage, SMS.

OUT permanently: sales, purchases, POS, inventory, warehouse, CRM, projects,
HR, payroll, recruitment, localization/tax packs, marketplace/entitlements,
multi-tenancy, client portal.

Rules: no second implementation where a mature engine exists; no
frontend-authoritative financial math; individual and group repayment share one
code path and one allocation policy; one migration = one purpose; never build
microfinance surfaces on legacy ERP rows; no exploratory audits, no standalone
reports, no cosmetic refactors.

## ERP strip is CLOSED

Schema is ~398 public tables (from 842). What remains of the old ERP is inert
(no nav, no hooks, no UI). **No further ERP-removal milestones**, except the
report-surface cleanup in M10 below (UI-only, no DB drops). Inherited linter
findings stay deferred.

## Verified state (2026-09-04, re-verified this session)

- Apps: `dashboard, finance, lending, platform, reports, studio`.
- Lending routes exist for clients, groups, products, applications, loans,
  repayments, collections, settings (accounting mappings + allocation policy)
  and nine report pages under `src/apps/lending/reports/`.
- `mf_post_event → mf_resolve_account → post_journal_entry_atomic` is the
  financial authority; balances, arrears, PAR, installment/penalty status and
  statements are DB views, all `security_invoker`, officer-scoped via
  `mf_officer_in_scope` / `mf_loan_in_scope`.
- Owner `fredrickmureti612@gmail.com` = `owner`, module `lending` granted.

### Completed milestones (M4–M9.5)
Collections & repayment (ASA group sheet + single-client, allocation policy,
client credit, receipts, cash handover → bank batch → reconciliation);
statements; arrears/PAR/delinquency; loan lifecycle events (top-up,
restructure, write-off, closure — events, never `UPDATE loans`); nine lending
reports through the existing engine (`src/hooks/useMfReports.ts`, server views
only); RBAC lending matrix in `src/lib/permissions.ts`; real penalties
(`mf_loan_charges`, `mf_loan_penalty_status`, `mf_accrue_penalties`, allocation
in policy order) and their surfacing on the loan schedule; disbursement and
repayment reversals with journal reversal; branding.

### Partially complete — loan fees (M9.7, DB done, UI open)
Verified in code: product versions publish `fees: []`
(`src/apps/lending/products/ProductVersionDialog.tsx:166`) so **no product can
yet carry a fee**. DB side is in place: fees configured per product version
(percent-of-principal or flat; deducted at disbursement or added to first
installment), frozen onto the loan at creation, `mf_compute_loan_fees` /
`mf_loan_fee_total` resolve amounts server-side, `mf_disburse_loan` stores
`fees_deducted`, `net_amount`, `fee_breakdown` and refuses fee ≥ principal.
Accounting is settled and correct: a 1,000 loan with a 200 fee posts
DR principal receivable 1,000 / CR fee income 200 / CR cash 800 — the client's
obligation stays 1,000; fee income resolves through the existing `fee_income`
mapping (Lending → Configuration → Accounting), no account UUIDs in code.

## Milestones remaining, in order

### M9.7 — Loan fees, UI completion (next)
1. Fee editor in the product version dialog: name, percent/flat, value,
   deducted-at-disbursement vs added-to-first-installment; publish real `fees`.
2. Disbursement dialog: gross principal, fee lines, net cash payable, before
   confirm.
3. Disbursement confirmation document + repayment receipt: show fee breakdown
   and net amount (existing document engine, no new renderer).
4. Types/hook updates for the new disbursement columns
   (`fees_deducted`, `net_amount`, `fee_breakdown`).
No new DB migration expected; no client-side fee math.

### M10 — Reporting catalogue is microfinance-only
Verified orphans in the shared registry/nav:
- **FX family is ERP forex, not microfinance.** `REPORT_FAMILIES` key `fx`
  (`src/services/reports/reportsNav.ts`) plus registry ids `fx-revaluation`,
  `fx-exposure`, `fx-realized`, their routes in `src/apps/finance/routes.tsx`,
  pages `src/pages/reports/FxRevaluationReport.tsx`,
  `FxExposureReport.tsx` and the `useFx*` report hooks → remove from the
  catalogue, nav and routes. Leave `fx_*` DB objects and the period-close
  reference in `ClosePeriodSheet.tsx` untouched (single-currency institution;
  do not touch accounting).
- **Dead classification surface.** `ReportCategory` still carries `inventory`;
  `ReportDomain` still carries `hr, sales, purchases, inventory, pos, projects,
  crm`; `DOMAIN_BY_CATEGORY` maps receivables→sales, payables→purchases,
  inventory→inventory; `DOMAIN_BY_PATH_PREFIX` still lists `/hr/reports`,
  `/pos/reports`, `/projects-app/reports`, `/crm/reports`; `paths.inventory`
  dual-mount and `REPORT_DOMAIN_LABELS` carry the same ERP names → reduce to
  `finance` + `lending` and delete the ERP entries and labels.
- **Four lending reports are unregistered** (invisible to the command palette,
  Report Center, favorites and access logging): `officer-collections`,
  `par-aging`, `product-performance`, `client-exposure` — routed in
  `src/apps/lending/nav.ts` but absent from `REPORT_REGISTRY`. Register them
  with `domain: "lending"`, `permission: "viewLendingReports"`.
- Add a `lending` report family (portfolio, arrears/PAR, collections,
  disbursements, client statement, officer & branch collections, PAR aging,
  product performance, client exposure) so `/reports` shows the microfinance
  catalogue, not a finance-only one.
- Re-point `aged-receivables` / `aged-payables`: keep only if they read
  retained finance data; otherwise drop from the catalogue in the same pass.
- Update the architecture tests that assert the old categories/domains
  (`src/test/architecture/reports-routing-parity.test.ts`,
  `reporting-isolation-matrix.test.ts`,
  `cash-banking-category-coherence.test.ts`).
UI/registry only — no DB migration, no page rewrites.

### M11 — Owner verification pass (preview only)
Authenticated checks cannot run from the sandbox (external Supabase). Sign in
as owner and confirm: a product with a 200 flat fee disburses 800 net with the
journal above; write off one loan and confirm the journal posts; reverse one
disbursement; `/lending` and children open; dashboard KPIs and PAR load; every
lending report renders and exports; one client statement, one repayment receipt
and one disbursement confirmation print (fee breakdown visible); a banked
collection matches in bank reconciliation; penalty accrual raises charges and
they show on the loan.

### M12 — Deferred inherited linter posture (last)
~2,021 pre-existing findings from the AccrualFlow history: SECURITY DEFINER
views, function `search_path`, anon EXECUTE revokes, leaked-password
protection. Nothing in the domain blocks on it; one fix per migration.

## Working rules
- Update this file after every milestone; factual and short.
- Every change must serve the microfinance domain or unblock it.
