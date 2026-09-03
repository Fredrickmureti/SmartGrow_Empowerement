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


======================THIS WAS THE LAST MESSAG FROM THE AGENT BEFORE IT RUN OUT OF TIME=================



I fixed the two real blockers and verified the group + cash legs end to end.

Fixed (migrations applied)
- Dropped the obsolete `_tg_stamp_bank_transaction_currency` trigger/function (referenced `original_currency`/`exchange_rate` columns that no longer exist) — this was the error blocking collection banking. Also dropped the leftover payroll matching trigger on `bank_transactions`.
- Rewrote `mf_bank_collection_batch` to supply `external_transaction_id` on the bank transaction it creates (second, previously undiscovered bug: NOT NULL violation).

Verified live (as the authenticated officer)
- Group leg: `GRP-001 Umoja Women Group` with a leader + 2 members, three applications through submitted → under_review → assessment → approved (guards correctly refused approval without an assessment), loan creation, and disbursement of all three.
- Group-meeting batch `BATCH-001`: 2 cash repayments (2,500 each) + 1 mobile-money part payment (1,200), each allocated against its own member's loan — no joint liability leaked into individual balances; batch closed.
- Cash leg: batch banked — journal balanced (Dr 1112 Bank 6,200 / Cr 1111 Cash 5,000 / Cr 1030 Mobile Money 1,200), bank transaction and `mf_collection_bankings` row created.
- Balances/arrears views recompute correctly per loan.

Remaining (not done, credits ran out)
1. `mf_par_summary` returns NULL for `par_1/30/90` when nothing is overdue — should coalesce to 0 and expose the ratio, not just the amount.
2. Loan `LN-000001` sits at `status='closed'` with 44,920 outstanding — legacy test artifact from the earlier lifecycle; `mf_close_loan` itself guards correctly, so the row just needs correcting.
3. Bank-reconciliation match of the banked transaction; dashboard KPI, one report render, client statement, repayment receipt and disbursement confirmation against this data.
4. Replace stale AccrualFlow branding on the login page and root metadata; fix the shell hydration mismatch.
5. M2 strip: `useDashboardStats`, `useDashboardAnalytics`, entitlement gating, `parked-modules.d.ts` stubs, then typecheck/build.

The plan file still reflects this order; items 1–2 are new findings to add at the top of M1.


ALSO in the settings, if the governance can be used use it but its not applicable delete it  in the settings we still have references to previous erp achirecture such as tax, notifications still shows previous erp work, like basically the settings needs to be scrutnized besides the fact that I am an admin but when I attempt to access lending app I get access denied,  

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
