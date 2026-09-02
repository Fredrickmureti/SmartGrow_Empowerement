

# Smart Grow Empowerment — convergence plan (re-verified 2026-09-02)

Single source of truth. Reuse exactly three inherited things: document engine,
auth engine (PIN), navigation/UI foundation. Finance is reused only as the
posting target (chart of accounts, journal, GL, fiscal periods, fixed assets).
Everything else ERP is unwired and dropped in one sweep at the end.

Backend: Supabase project `xwxqunklduknceoryrha` (already connected; no
further connection step needed).

## Verified state (checked directly against files and the live database)

| Milestone | Previous claim | Verified reality |
| --- | --- | --- |
| C1 scaffold, `/lending/*` | Done | Confirmed |
| C2 roles + `mf_account_mappings` + settings screen | Done | Confirmed — but **no RPC reads the mappings** |
| C3 clients + groups | Done | Confirmed (tables, hooks, pages) |
| C4 loan products | "ProductsPage missing" | **Stale** — `ProductsPage.tsx` exists and is routed. C4 complete |
| C5 applications → assessment → decision | Not started | **Already built** — `mf_loan_applications`, `mf_application_assessments`, hooks, 4 UI files |
| C6 loan + schedule + disbursement | Not started | **Built, unposted** — `mf_loans`, `mf_loan_schedule`, `mf_loan_disbursements`, `mf_loan_events` (append-only), `mf_generate_schedule`, `mf_create_loan_from_application`, `mf_disburse_loan`. Zero journal posting |
| C7 repayments / allocation / arrears / collections | Not started | **Half built** — `mf_repayments`, `mf_repayment_batches`, `mf_repayment_allocations`, `mf_allocation_policy`, `mf_record_repayment` (reads policy), `mf_reverse_repayment`; balances + installment status are server views. **Missing:** GL posting, arrears/DPD/PAR, collections activity (visits, promises, outcomes), officer-portfolio scoping |

Typecheck is clean. All 18 `mf_*` tables have RLS enabled.

**Genuine resume point: C6b — accounting hook.** Disbursement and repayment
are business events with no accounting effect today; that violates rule 2 and
must be fixed before any more lifecycle work lands on top of it.

## C6b — Accounting hook (next)

1. One migration per object (rule: small, single-purpose):
   - `mf_post_event(loan_event_id)` — resolves debit/credit accounts from
     `mf_account_mappings` by event kind, writes a balanced journal entry via the
     existing journal path, stamps `journal_entry_id` on `mf_loan_events`.
     Missing mapping = hard error, never a fallback account.
   - `mf_disburse_loan` → calls `mf_post_event` (principal receivable DR /
     cash-bank-mobile CR by disbursement method).
   - `mf_record_repayment` → posts per allocation bucket (principal, interest,
     fee, penalty) from the policy-driven allocation rows.
   - `mf_reverse_repayment` → reversing journal, linked to the original.
2. Idempotency: unique `(loan_event_id)` on the posting link; re-running posts
   nothing.
3. Verify: disburse + repay + reverse one loan; journal balances, GL matches
   `mf_loan_balances`.

## C7b — Arrears, collections, portfolio scope

- Server views: `mf_loan_arrears` (due vs paid per installment → DPD, arrears
  amount), `mf_par_summary` (PAR 1/30/90 by branch/officer).
- Tables: `mf_collection_activities` (visit, call, promise-to-pay, outcome;
  attributable to officer; append-only).
- RLS: loan officers see only their own portfolio; branch managers their
  branch; finance/audit roles read all. Apply the same scope to `mf_clients`,
  `mf_loans`, `mf_repayments` (currently institution-wide).
- Collections page becomes arrears worklist + activity log, not a balance list.

## C8 — Lifecycle exceptions

Top-up, restructuring, write-off, closure as `mf_loan_events` with approval and
`mf_post_event` treatment. New schedule versions, never edits to history.

Status (2026-09-02):
- DONE — write-off: `mf_post_event` gained the `loan_written_off` treatment
  (DR write-off expense / CR principal + interest receivable, amounts taken
  from `mf_loan_balances`, mappings resolved, missing mapping = hard error),
  `mf_write_off_loan` (role-guarded, single-shot, reason required).
- DONE — closure: `mf_close_loan` (refused while anything is outstanding,
  records a `loan_closed` event, no posting needed).
- UI: `LoanLifecycleDialog` + Close / Write off actions on active loans.
- PENDING — top-up and restructuring (new schedule version, approval,
  settle-and-reissue accounting).


## C9 — Reports & documents on the existing engines

Reports: portfolio, outstanding principal/interest, daily/officer/branch
collections, arrears aging + PAR, client statement/exposure, applications/
approvals/disbursements. Documents: loan agreement, repayment schedule, loan
statement, payment receipt, disbursement confirmation, collection receipt.
Register into the existing engines with institution data injected; no new
renderers.

## C10 — Hardening + one bulk sweep

RLS/grants audit on every `mf_*` object, reversal/duplicate/approval controls,
security scan. Then the single grouped removal of confirmed-dead ERP surfaces:

- Finance registry entries: receivables, payables, customer credits, customer
  statements, budgets, bank feeds, reconciliation (keep: chart of accounts,
  journal entries, fiscal periods, fixed assets, banking, reports, settings).
- Contacts app (customers/suppliers/companies) — clients live in `mf_clients`.
- Employees app sub-surfaces: departments, job positions, work locations, org
  chart, HR reports (keep: user list, role, branch assignment).
- Dead schema: retail/WMS, payroll, attendance, procurement, POS, CRM, and
  their tests.

## Working rules

1. Financial state is derived server-side; React never owns balances,
   interest, arrears, allocations or journal amounts.
2. Every domain action is a business event with an accounting hook. Account
   mappings are configuration — never a hardcoded account UUID.
3. Every new public object ships GRANTs + RLS in the same migration; one
   object per migration.
4. Inherited ERP rows are not this institution's data.
5. Permanently out of scope: SaaS/tenants/subscriptions, payroll, attendance,
   POS, inventory, warehouse, procurement, order-to-cash, client portal,
   public registration, hardware.
6. Per-milestone verification: typecheck + exercise the affected flow against
   the live database. Full suite green is a C10 goal.
7. No exploratory audits of code or tables already known to be out of scope.
8. Update this file after every completed step; never trust a prior claim
   without checking the file or table it names.

## Next action

C8 continued: top-up and restructuring as settle-and-reissue events — new
schedule version on the same loan lineage, approval-guarded, with the
`mf_post_event` treatment. Then C9 (reports + documents on the existing
engines).



=============THIS WAS THE LAST MESSAGE IT GAVE BEFORE ITS TIME RUN OUT======


Stopping here. Where things stand:

Verified (not taken on trust)
- C1–C5 complete; C6/C7 built; `mf_post_event`, `mf_resolve_account`, `mf_disburse_loan`, `mf_record_repayment`, `mf_reverse_repayment` all exist and post — the previous engineer's C6b claims held up.
- Only genuine gap in C6b was the UI config: `client_advance` existed in the DB constraint but not in the app's mapping list.

Completed this session
- C6b closed: added `client_advance` to `MfMappingKey` and `MF_MAPPING_SPECS`, so the overpayment liability account is configurable under Lending → Configuration → Accounting.
- C7b backend (migration applied): `mf_loan_arrears` (per-installment due vs paid, arrears, DPD), `mf_par_summary` (PAR 1/30/90 by branch and officer), `mf_collection_activities` (append-only, officer-attributed, manager-only cancellation via trigger + RLS), and portfolio scoping — loan officers and collections officers now see only their own clients, loans and repayments; managers/accountants/auditors/admins keep full institution visibility.
- C7b frontend: `src/hooks/useMfCollections.ts`, `LogActivityDialog.tsx`, and Collections rebuilt as worklist / overdue installments / activity log, with PAR read from the server view instead of computed in React.

Remaining, in order
1. Verify: configure the account mappings, then run one disburse → repay → reverse cycle and confirm the journal balances against `mf_loan_balances`; also confirm the new Collections tabs render (build check not yet read this turn).
2. Update `.lovable/plan.md` — C6b done, C7b implemented pending live verification.
3. C8 lifecycle exceptions (top-up, restructure, write-off, closure as events), C9 reports/documents on the existing engines, C10 hardening + the single bulk ERP removal sweep.

The linter's 3,670 findings are inherited AccrualFlow surface already scheduled for the C10 sweep, not new.


NOTE
=============
And kindly note: **there is absolutely no room for unnecessary work or credit wastage here.** We need to be highly deliberate about scope.

The objective is to **strip away everything the microfinance system does not need** and immediately create a clean foundation for its business logic. Do not preserve unnecessary ERP complexity simply because it already exists.

What we want to **reuse** from the existing system is specifically:

* **Document generation engine**
* **Authentication/auth engine**
* **Navigation and UI foundation**

Everything else should be evaluated critically. If a component, module, workflow, table, dependency, or business rule is not required by the microfinance system, **remove it, disable it, or leave it out of the new scaffold** rather than carrying unnecessary complexity forward.

The client does **not** need another complicated ERP. We are building a focused microfinance platform, so the architecture should be lean, intentional, and optimized around the actual business requirements.

**Do not waste credits exploring or rebuilding things we already know we will not use.** Make the necessary architectural decisions quickly, clear the unnecessary ERP scaffolding, preserve only the reusable foundation, and open the way for us to start implementing the **actual microfinance business logic immediately.**

**Optimize for speed, relevance, and credit efficiency. No unnecessary work.**
