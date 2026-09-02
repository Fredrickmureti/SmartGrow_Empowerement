# Smart Grow Empowerment — microfinance convergence plan (reworked 2026-09-02)

Single source of truth. One institution, employee-operated, ASA branch model.
Inherited from AccrualFlow, deliberately: **document engine, auth engine (PIN),
navigation/UI foundation**, plus Finance strictly as the posting target (chart of
accounts, journal entries, GL, fiscal periods, fixed assets). Everything else is
out of scope and gets unwired in one sweep — never investigated module by module.

Backend: Supabase project `xwxqunklduknceoryrha` — already connected, no second
project, no new connection.

## Verified state (files + live DB, 2026-09-02)

| Milestone | Status |
| --- | --- |
| C1 lending scaffold, `/lending/*`, layout, nav | Done |
| C2 roles, `mf_account_mappings`, mappings settings screen | Done |
| C3 clients + groups | Done |
| C4 loan products + immutable versioning | Done |
| C5 applications → assessment → decision | Done |
| C6 loan creation, schedule engine, disbursement | Done |
| C6b accounting hook `mf_post_event` (mapping-resolved, hard error on gap) | Code done, **never successfully posted** |
| C7 repayments, policy allocation, reversal, server-derived balances | Done |
| C7b arrears/DPD/PAR, collections, officer/branch RLS scope | Done |
| C8a write-off + closure | Done |
| C8b top-up / restructure (RPC + `reissueLoan` + lifecycle dialog + lineage) | Done |
| V1 live lifecycle proof | **Blocked — open defect below** |

### The one real blocker

`journal_status` in this database has exactly three values: `draft`, `posted`,
`void`. Microfinance accounting was written against an engine that also had
`voided` / `reversed`. Two functions were already corrected; the trigger
`enforce_journal_entry_immutability` still tests
`OLD.status NOT IN ('posted','void','reversed')` and fails every posting.

Until this is fixed, **no microfinance accounting has ever succeeded**, so C6b,
C7 postings and C8a treatments are unproven regardless of code completeness.

**Resume point: F1 below.**

## F1 — Fix the journal path (one pass, no discovery loop)

1. One migration per function, smallest possible edit:
   - `enforce_journal_entry_immutability` → valid enum literals only.
   - Sweep only the functions the microfinance path actually touches
     (`mf_post_event` chain, `void_journal_entry_atomic`, journal SoD guard) for
     invalid `journal_status` literals and fix in the same pass.
   - ERP functions carrying the same bug (POS, payroll, bills, invoices,
     landed cost, expenses…) are **not fixed** — they are being deleted in C10.
2. Verify: insert → post → void a journal entry directly; no trigger error.

## V1 — One live lifecycle proof (gates everything after it)

Single client, single loan: application → assessment → approval → loan +
schedule → disburse → repay (partial + full) → reverse one repayment → top-up →
successor disbursement → close.

Assertions, all server-side:
- every generated journal entry balances (Σ debit = Σ credit),
- GL movement on the mapped accounts equals `mf_loan_balances`,
- reversal produces a new contra entry, never an edit,
- predecessor closes only on successor disbursement.

Record the outcome in this file. No further feature work until V1 passes.

## C9 — Reports & documents on the inherited engines

Register microfinance definitions into the existing report/document engines with
institution settings injected. No new renderer, no new PDF path, no new export
mechanism.

- Reports: loan portfolio, outstanding principal/interest, daily/officer/branch
  collections, arrears aging + PAR, client statement/exposure,
  applications/approvals/disbursements.
- Documents: loan agreement, repayment schedule, loan statement, payment
  receipt, disbursement confirmation, collection receipt.

## C10 — Hardening, then one bulk ERP removal sweep

1. RLS/grants audit across `mf_*` only; reversal, duplicate and approval
   controls; security scan.
2. Institution settings page (name, legal, address, contact, logo, currency,
   financial settings) confirmed as the single source feeding reports and docs.
3. **Single grouped removal** — already decided, no per-module analysis:
   - Apps/routes/nav: retail/POS, inventory, warehouse, procurement,
     sales/order-to-cash, CRM, payroll, attendance, HR beyond user + role +
     branch assignment. Contacts survives only if lending clients depend on it.
   - Finance registry: keep chart of accounts, journal entries, fiscal periods,
     fixed assets, reports, settings. Drop receivables, payables, customer
     credits/statements, budgets, bank feeds, reconciliation, consolidation.
   - Their hooks, components, tests and schema go in the same sweep.

## Working rules

1. Financial state is derived server-side. React never owns balances, interest,
   arrears, allocations or journal amounts.
2. Every domain action is an append-only business event with an accounting hook.
   Account mappings are configuration — never a hardcoded account UUID.
3. Every new public object ships GRANTs + RLS in the same migration; one object
   per migration.
4. History is never edited. Top-up, restructure, write-off, closure create rows.
5. Permanently out of scope: SaaS/tenants/subscriptions, payroll, attendance,
   POS, inventory, warehouse, procurement, order-to-cash, CRM, client portal,
   public registration, hardware.
6. Never fix, document or explore an out-of-scope ERP surface. If it is on the
   C10 delete list, a bug in it is not a bug.
7. Verification per milestone: typecheck + exercise the flow against the live
   database. Update this file immediately after each step.

## Next action

F1 step 1 — migration correcting `enforce_journal_entry_immutability`, then the
narrow enum sweep of the microfinance journal path, then run V1.



=============THIS WAS THE LAST MESSAGE IT GAVE BEFORE ITS TIME RUN OUT======


I've reworked the plan and started executing it, but ran out of credits mid-way. Here's exactly where things stand.

Plan reworked and approved — now archived at `.lovable/plan/smart-grow-empowerment-microfinance-convergence-plan-reworke-2026-09-02.md`. Key change: the previous agent's "done" list is largely real (C1–C8b, including the top-up/restructure UI), but the accounting hook had never once posted successfully, so every "done" claim on the financial path was unproven. The plan now blocks all further feature work behind one live lifecycle proof.

Fixed this session (two real defects):
- `enforce_journal_entry_immutability` compared against a `journal_status` value (`reversed`) that doesn't exist in this database — it only has `draft`, `posted`, `void`. This trigger fired on every journal write, so every microfinance disbursement, repayment and write-off failed at the accounting step.
- `void_journal_entry_atomic` had the same invalid value in three places, which would have broken repayment reversal. Both now use `void` and keep their original protections and idempotency.

I deliberately did not fix the ~45 other ERP functions carrying the same bug (POS, payroll, bills, invoices, expenses) — they're on the C10 delete list.

Also done: confirmed Supabase is already connected (`xwxqunklduknceoryrha`, no second project needed), confirmed the owner account already satisfies `super_admin` checks, and seeded the missing repayment allocation policy (penalty → fee → interest → principal), without which no repayment could be recorded.

What remains — the exact next step:
1. A temporary routine `public.__v1_lifecycle_proof()` is now in the database. Run `SELECT public.__v1_lifecycle_proof();` — it drives one loan through application → approval → loan + schedule → disburse → two repayments → reversal → top-up → successor disbursement, and returns whether any journal entry is unbalanced, whether each business event actually posted, and the resulting balances. It returns an error object naming the failing step rather than throwing, so it's cheap to iterate on.
2. Fix whatever it names (expect one or two more enum/guard mismatches of the same family), re-run until `ok: true`.
3. Drop `__v1_lifecycle_proof` afterwards — it's scaffolding, not product code.
4. Record the outcome in `.lovable/plan.md`, then proceed to C9 (reports + documents on the inherited engines) and C10 (hardening + the single bulk ERP removal sweep).

The linter's 3,600+ warnings are inherited AccrualFlow posture, unchanged by my migrations, and belong to the C10 sweep — not worth credits now.

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
