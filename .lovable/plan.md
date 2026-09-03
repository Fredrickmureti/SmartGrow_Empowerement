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


======================THIS WAS THE LAST MESSAG FROM THE AGENT BEFORE IT RUN OUT OF TIME=================

Work landed this session (all typechecked clean, build unaffected):

M9 — Hardening, continued
1. RBAC read-through — completed the lending role matrix in `src/lib/permissions.ts`: `cashier` (teller: clients, loans, record repayments — deliberately no approval, no disbursement, no portfolio reports) and `accountant` (read-only portfolio + lending reports). `manageLendingConfig` stays admin/owner-only. Client-side gates remain a rail; RLS is the boundary.
2. Penalties are now real (closing the hardcoded-`0` gap):
   - `mf_loan_charges` — penalty/manual charge per installment, reversible, with an idempotent accrual key; RLS-scoped to the caller's portfolio, no client writes.
   - `mf_loan_penalty_status` (security-invoker view) — penalty charged vs paid vs outstanding per installment.
   - `mf_record_repayment` rewritten to allocate penalty from real outstanding charges in the configured `mf_allocation_policy` order, to reach installments that carry only a penalty, and to auto-close a loan only when schedule and penalties are clear.
   - `mf_accrue_penalties(business, as_of)` — one charge per overdue installment from the loan's own `penalty_rate` / `penalty_basis`, safely re-runnable; execute revoked from anon.
   - Penalty income keeps posting through the existing `penalty_income` mapping on receipt — no second accounting path.
   - Operated from Lending → Collections via a "Run penalty accrual" action gated by `manageCollections`, backed by `useMfAccruePenalties`.

Remaining (next session, in this order)
1. Update `.lovable/plan.md` and `roadmap.md` with the above — I ran out of credits before writing them; the plan still shows penalties as an open M9 item.
2. Surface penalties on the loan detail and loan/client statement (charges list + penalty outstanding line).
3. Deferred inherited linter posture (~2,020 findings, all pre-existing AccrualFlow surface plus the one new gated function).
4. Your signed-in preview verification pass listed in `.lovable/plan.md`.
and remviing the accrualflow branded loader

==============================NOTE===============================

NOTE
=============
And kindly note: **there is absolutely no room for unnecessary work or credit wastage here.** We need to be highly deliberate about scope.

The objective is to **strip away everything the microfinance system does not need** and immediately create a clean foundation for its business logic. Do not preserve unnecessary ERP complexity simply because it already exists.

What we want to **reuse** from the existing system is specifically:

* **Document generation engine**
* **Authentication/auth engine**
* **Navigation and UI foundation**
* *Banking and reconciliation , payables receivables but now tailored for microfinance**
TO BE PRECISE, WHAT IS REUSABLE, KINDLY REUSE IT INCLUDING PAYMENT SETTLEMENT ENGINE FOR PAYABELES/RECEIVABLES, basically accross the Finance what is reusable use it as long as its microfuiannce tailored because we are building mciro fianance  if its statements instead of customer staments lest it be  talowred towards microfinance not the current sales oriented that was used by the old erp so dont just delete what is reusable and has solid engine that will be painful to rebuild from scratch, reason like a mircofiannce system developer not like a blind bot,  and  if its payment being receuived,  and on the payment reception we need to reason critically here because this sytem is almost operating almost like ASA international kenya which uses the typical old microfinance tradition because this is an upcoming microfiannce startapp  where we have something loan officer overseeign a group but still that does not mean tje system should not allow single customer payment so this means I need you to help me reason here, dont ask me question, just know you are dealign with a microfiannce system  and such not the old erp which dealth with the typical procurement and sales kind of flow no room for an error, be anaytical and critical executioner, like basically for fiannce what can be reusable let it be reused and now be tailpored to the microfiannce from  fixed assets, to generaal settings to fiscal periods and such (its up to you to analyze what and what nots that needs  to be retained because you are the engineer)

Everything else should be evaluated critically. If a component, module, workflow, table, dependency, or business rule is not required by the microfinance system, **remove it, disable it, or leave it out of the new scaffold** rather than carrying unnecessary complexity forward.

The client does **not** need another complicated ERP. We are building a focused microfinance platform, so the architecture should be lean, intentional, and optimized around the actual business requirements.

**Do not waste credits exploring or rebuilding things we already know we will not use.** Make the necessary architectural decisions quickly, clear the unnecessary ERP scaffolding, preserve only the reusable foundation, and open the way for us to start implementing the **actual microfinance business logic immediately.**

**Optimize for speed, relevance, and credit efficiency. No unnecessary work.**

## Status update (M3, pricing group)

Done: removed the sales pricing engine — line-pricing triggers on invoice /
estimate / credit-note / proforma / sales-order items, `_pricing_normalize_line`,
`resolve_line_unit_price`, `pos_resolve_line`, the `contacts.customer_group_id`
and `contacts.price_list_id` columns, and the `customer_groups`, `price_lists`,
`price_list_items` tables. Code side (`fetchContactDefaults`, `useContacts`)
cleaned; typecheck green. Linter count 2025 -> 2021, all inherited, none new.

Scope decision (deliberate, to avoid credit burn): delivery notes, sales orders,
recurring invoices, sales returns and the eTIMS group are NOT worth a deep
schema scrub — their identifiers are woven through the shared document engine,
outbox, audit and studio metadata that we are keeping. They are left inert
(no navigation, no hooks, no UI). Next work goes to microfinance business logic:
retargeting receivables/payables and the payment settlement engine to loans,
group/individual collections, and microfinance-tailored statements.
