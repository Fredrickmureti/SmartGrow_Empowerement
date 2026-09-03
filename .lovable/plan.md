# Smart Grow Empowerment — microfinance platform (plan of record)

One institution, staff-only lending operations. Backend: Supabase `xwxqunklduknceoryrha`.
No SaaS, no multi-tenancy, no client portal, no payroll/HR/sales/inventory/POS/CRM.

## Scope contract (binding)

- Reuse, tailored to microfinance: auth/RBAC/PIN + invitations, app shell + nav + design system,
  document engine (kinds + template AST + PDF renderer), report engine, and the Finance core
  (chart of accounts, journals/GL, fiscal periods, fixed assets, banking, bank feeds,
  reconciliation, settlement engine, accounting events, reversal register).
- Remove/leave out: everything else inherited from the ERP.
- Financial state is derived server-side; React never owns balances, interest, arrears,
  allocations or journal amounts.
- Append-only business events with mapping-resolved postings. `UPDATE loans SET ...` is not a
  business process.
- One object per migration; GRANTs + RLS in the same migration.
- A bug in a removed ERP surface is not a bug. No re-auditing verified milestones.
- Each milestone ends with: `tsgo` clean, build OK, affected screens rendered, this file updated.

## Verified state (2026-09-03, re-checked against the codebase)

- Shell contains only `dashboard`, `lending`, `finance`, `reports`, `studio`, `platform`.
- Lending domain live under `src/apps/lending/*` (clients, groups, products, applications, loans,
  repayments, collections, documents, reports, settings) on the `mf_*` schema via `useMf*` hooks.
- Finance retained as accounting infrastructure with microfinance vocabulary in `FINANCE_NAV`
  (loan receivables, institution payables, journal entries, cash & bank, reconciliation,
  bank feeds, accounting events).
- `mf_post_event` posts disbursement, settlement-by-successor (top-up/restructure), repayment
  per allocation component, repayment reversal, and write-off through `mf_resolve_account` +
  `post_journal_entry_atomic`, idempotent via `mf_event_postings`. No account ids in app code.
- Documents: only `journal_entry` + the four lending kinds are registered; institution identity
  (name, legal name, address, phone, email, registration, tax id) is injected from `businesses`.
- Client statement reads the server-owned `mf_client_statement` view.
- **Closed this pass:** the inherited `customerStatementDataset/Ledger` and
  `vendorStatementDataset/Ledger` services were verified unreferenced and deleted. `tsgo` clean.

Milestones C1–C11 are complete. Do not re-open them.

## C12 — hardening (current milestone)

1. **DONE — `mf_*` data security.** Every `mf_*` table has RLS enabled with GRANTs to
   authenticated + service_role. Linter sweep done: dropped `storage_orphan_inventory`
   (ERP view exposing `auth.users`) and the three ERP scratch log tables
   (`_pret_sim_log`, `_e2e_milk_log`, `__ts_wave5_results`). Zero ERROR-level findings remain
   outside inherited ERP `SECURITY DEFINER` views/functions (see debt below).
2. **DONE — loan-officer data scope.** `mf_clients`, `mf_loans`, `mf_repayments` and
   `mf_collection_activities` already scoped; this pass added `mf_officer_in_scope` /
   `mf_loan_in_scope` to the SELECT policies of `mf_loan_applications`, `mf_groups`,
   `mf_loan_schedule`, `mf_loan_disbursements`, `mf_loan_events`, `mf_repayment_allocations`.
3. RBAC roles wired end to end: Super Admin, Branch Manager, Loan Officer, Credit Officer,
   Cashier, Accountant, Collections Officer, Auditor, Reporting User — server-side enforcement
   is authoritative, nav hiding is cosmetic.
   `app_role` already carries super_admin, admin, branch_manager, loan_officer, credit_officer,
   cashier, accountant, collections_officer, auditor, viewer (= Reporting User).
4. Audit + immutability proof: every lending business event attributable to a user; reversals,
   not edits; no destructive deletion of financial history.
5. Live signed-in render of each lending document (agreement, schedule, statement, receipt) and
   each lending report through the retained engines.

Exit gate: linter clean on `mf_*`, role matrix demonstrated, portfolio scoping demonstrated,
four PDFs rendered signed-in, `tsgo` clean, build OK.

## C13 — remaining lending gaps (only after C12)

- Fee-charged and penalty-accrued events + their mappings in `mf_post_event`.
- Configurable repayment allocation order (policy-driven, not hardcoded).
- Arrears/PAR derivation verified against schedule-vs-payments on real data.

## Known inherited debt (fix only when it blocks a retained surface)

Legacy SQL-migration guards (`je-description-no-uuid`, `pgcrypto-extension-prefix`,
`single-audit-trigger-per-table`, `sql-businesses-currency-column`, `currency-ratchet`) and
inherited ERP `SECURITY DEFINER` views (30) and functions (~3.5k linter warnings), plus content-drift guards (banking gating ×2, finance-settings permissions, radix overlay,
tanstack-router-in-spa, aged-receivables related-reports). Pre-existing.


======================THIS WAS THE LAST MESSAG FROM THE AGENT BEFORE IT RUN OUT OF TIME=================
C12 step 3 (RBAC) is verified as far as the database layer goes:

- Every `mf_*` write path is role-gated server-side via `has_role(...)` plus `user_has_business_access(...)` — client/group/application writes limited to admin, branch manager, loan officer, credit officer; loan creation to admin/branch manager/credit officer; repayments to cashier/collections/loan officer; mappings and allocation policy to admin/accountant only.
- Financial history tables (`mf_loan_events`, `mf_event_postings`, `mf_loan_schedule`, `mf_loan_disbursements`, `mf_repayment_allocations`) have SELECT-only policies — they can only be written through `mf_post_event`, so the frontend cannot own balances or postings.

Remaining in C12:
1. Confirm the UI nav/action gating matches the role matrix (cosmetic layer only) and that no public registration path is reachable — `/signup` still exists in the shell and should become invite-only.
2. Audit/immutability proof: attribution on each lending event, reversal-not-edit behaviour.
3. Signed-in render of the four lending documents and the lending reports.
4. Fix the hydration mismatch surfacing on the auth screens.


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
TO BE PRECISE, WHAT IS REUSABLE, KINDLY REUSE IT INCLUDING PAYMENT SETTLEMENT ENGINE FOR PAYABELES/RECEIVABLES, basically accross the Finance what is reusable use it as long as its microfuiannce tailored because we are building mciro fianance  if its statements instead of customer staments lest it be  talowred towards microfinance not the current sales oriented that was used by the old erp so dont just delete what is reusable and has solid engine that will be painful to rebuild from scratch, reason like a mircofiannce system developer not like a blind bot,  and  if its payment being receuived,  and on the payment reception we need to reason critically here because this sytem is almost operating almost like ASA international kenya which uses the typical old microfinance tradition because this is an upcoming microfiannce startapp  where we have something loan officer overseeign a group but still that does not mean tje system should not allow single customer payment so this means I need you to help me reason here, dont ask me question, just know you are dealign with a microfiannce system  and such not the old erp which dealth with the typical procurement and sales kind of flow no room for an error, be anaytical and critical executioner, 

Everything else should be evaluated critically. If a component, module, workflow, table, dependency, or business rule is not required by the microfinance system, **remove it, disable it, or leave it out of the new scaffold** rather than carrying unnecessary complexity forward.

The client does **not** need another complicated ERP. We are building a focused microfinance platform, so the architecture should be lean, intentional, and optimized around the actual business requirements.

**Do not waste credits exploring or rebuilding things we already know we will not use.** Make the necessary architectural decisions quickly, clear the unnecessary ERP scaffolding, preserve only the reusable foundation, and open the way for us to start implementing the **actual microfinance business logic immediately.**

**Optimize for speed, relevance, and credit efficiency. No unnecessary work.**
