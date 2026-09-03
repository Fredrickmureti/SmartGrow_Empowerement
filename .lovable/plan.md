
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


======================THIS WAS THE LAST MESSAG FROM THE AGENT BEFORE IT RUN OUT OF TIME=================

I added the group collection sheet to Lending → Repayments: an officer picks a group and meeting date, sees every active member with their next installment, arrears and days past due (all server-derived), enters what each paid, and one submission opens a meeting batch and posts each line as its own receipt through the same `mf_record_repayment` allocation call the single-client path uses — no pooled group balance, no frontend money maths.

Remaining to finish M4 (next session):
- Import the `Users` icon in `RepaymentsPage.tsx` (I added the button but hadn't updated the lucide import line) and run typecheck/build — this is the one loose end that will break the build.
- Confirm the allocation order is read from configured policy rather than defaulted server-side, and define overpayment/advance handling as client credit.
- Receipt document per payment from the group sheet via the document engine.
- Update `.lovable/plan.md` with M4 progress.

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
