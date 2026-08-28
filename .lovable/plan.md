
# Consolidation — verified state and the remaining repair order

Note on the first request: this project is already connected to the Supabase
project `jkszmrroyjfdwokbkzis`. No new connection step is needed; all work below
runs against that backend.

## Verification of the previous engineer's claims (done this session)

Everything below was re-checked directly against the code and the live database.

| Claim | Verdict | Evidence |
| --- | --- | --- |
| R1 — TB proves on closing balances | Verified | `proveTrialBalanceOnClosingBalances` in `useConsolidatedTrialBalance.ts`, consumed by the TB page; movement columns kept and labelled as not the proof; architecture test asserts it |
| R1 — BS totals/verdict read the eliminated projection | Verified | `get_consolidated_statement_totals_eliminated` migration + `useEliminatedStatementTotals`, wired into `ConsolidatedStatements.tsx` |
| R2 — group masthead identity | Verified | both pages export `reportingEntityBusinessId: parent_business_id`, `branchId: null` |
| R2 — account code/name preserved in exports | Verified | contribution rows now export real code and name |
| R2 — "Run" label truthful | **Not done** | the PDF footer still prints a generic per-render hash (`computeRunHash`) for every report; nothing links to `consolidation_runs` and nothing labels it an export reference |
| R3 — consolidation reports registered with pinned profiles | Verified | four keys in `_shared/reports/columnSpecs.ts`; the registry coverage test iterates `REPORT_SPECS` so they are covered generically |
| R4–R7 | Open | live DB confirms: both elimination rules still carry the fitted tolerances 41,500.00 and 1,500.00 with `difference_policy = refuse`; the group CTA account is still `3050 Foreign Currency Translation Reserve` owned by the member *Joshua Holdings*, not a group account; `consolidation_runs` and `consolidation_run_lines` are both empty; `anon` still holds EXECUTE on `consolidation_create_run`, `consolidation_finalize_run`, `consolidation_supersede_run` and several other consolidation RPCs |

No claimed-complete item was found to be superficial except the R2 run-label
sub-item, which is now folded into the work below as R2b.

## Remaining work, in dependency order

Each step lands complete — SQL, guard, surface, artifact, scenario test, brick
log entry — before the next begins. Each ends with an artifact checkpoint: an
actual regenerated PDF/Excel inspected page by page, not inferred from template
code.

**R2b — Artifact identity truthfulness.** Consolidation artifacts stop printing
a per-render hash under the word "Run". When the report is generated from a
persisted consolidation run, print that run's id and version; otherwise print
`Export reference`. Test asserts a consolidated artifact can never label an
export hash as a run.

**R4 — Make the residual policy honest.** `difference_policy` is consulted
inside tolerance as well as outside, so a `refuse` group actually refuses.
Trading-class residuals are forbidden from reaching the translation reserve —
an intragroup trading mismatch is unrecorded, unrealised profit, or a cut-off
difference, never a translation difference. Any surviving residual is disclosed
as a named reconciling line on the face of the consolidated statements instead
of being buried in equity. Tolerances get an upper bound plus a recorded
changed-by/reason, and this tenant's fitted 41,500 / 1,500 are reset to a
defensible policy value.

**R5 — Remove the cause, not the symptom.** Member-level period-end revaluation
of foreign-currency intragroup monetary balances. The parent's KES 2,630,000
receivable against the subsidiary's USD 20,000 payable diverges by KES 40,000
between the trade rate 131.5 and the closing rate 129.5; under IAS 21.45 that
belongs in the parent's profit or loss, not in a consolidation plug. Once
recognised at source, the residual disappears legitimately.

**R6 — Make the reserve articulate.** Opening + movement = closing for the
translation reserve (today all three are independent plugs), and move the group
reserve off the parent's account 3050 onto a group-chart account, with a
migration for the existing group and a default for new groups.

**R7 — Close Brick 8 for real.** Revoke the `anon` EXECUTE grants on the run
lifecycle RPCs, then drive one genuine create → finalize → supersede run against
this group and prove the finalized figures are immune to a later member rate
edit.

**Final artifact acceptance gate.** Full inventory of every consolidation
surface (Cross-Company Comparative, Consolidated TB, Consolidated Statements,
Intercompany, Eliminations) across screen / PDF / Excel: data source, screen-to
-artifact parity, totals reconciliation, identity, traceability, run-label
truthfulness, typography, and access isolation for a user who can see only some
members. Evidence listed per artifact.

## Deliberately not in this plan

No NCI, no equity method, no consolidated cash flow, and no scaffolding for
them — Brick 9 starts only after the gate above passes.

## Technical notes

- New tables: only what R4 needs for tolerance bounding and change attribution
  (either columns on `consolidation_elimination_rules` plus an audit row, or an
  extension of the existing `consolidation_group_change_log`).
- No second accounting engine: R5 reuses the existing FX revaluation path rather
  than adding a consolidation-only revaluation.
- PDF work stays inside the shared report registry and `render-report`; the PDF
  cache version is bumped whenever typography or disclosure text changes.

================================================
IMPLEMENTATION PROGRESS
=========================================


I've stopped here — the R5 migration ran successfully before the pause.

What landed:
- One shared definition of a company's open foreign-currency monetary positions (`fx_open_monetary_positions`), with the existing period-end FX revaluation now reading from it, so the posting engine and any diagnosis can't disagree.
- A read-only diagnosis (`fx_unrecognised_exchange_difference`) that reports unrecognised exchange difference per currency as of a date, restricted to owners/admins of that company's organisation.
- The elimination engine's refusals now name the remedy: which company, how much foreign currency, carried rate vs closing rate, the unrecognised amount, and the instruction to run that company's period-end FX revaluation. A gap the members haven't recognised can no longer be carried to the group translation reserve at all.

What remains for R5:
1. Post the actual revaluation for Joshua Holdings as of 2026-08-31 — this needs `fx_unrealized_gain`/`fx_unrealized_loss` mapped in the parent's Default Accounts (currently only the realized keys are set); `resolve_fx_unrealized_account` will otherwise fail the run.
2. Regenerate the group's eliminations and confirm the KES 40,000 residual is gone and the stale 41,500 fitted plug is cleared.
3. Surface the diagnosis in the consolidation UI so the user sees the blocker before hitting the refusal.
4. Add architecture/regression tests for the remedy text and the "unrecognised FX can't reach CTA" rule, and log R5 in the brick log.

Then R6 (translation reserve articulation + group-chart CTA assignment) and R7 (run lifecycle hardening, revoke `anon`) are still open. Note the linter output above is the project's pre-existing baseline, not new findings from this migration — the three functions added were explicitly revoked from `anon` and search-path pinned.


# Implementation & Validation Standards

## 1. Test Data Is Allowed When Necessary

You are explicitly allowed to **seed controlled test data** whenever it is required to properly validate a business flow, accounting behavior, integration, migration, or edge case.

* If the test tenant already contains suitable data, use it.
* If the required data does not exist, create the minimum realistic test data necessary to exercise the scenario.
* Test data should represent realistic business events and accounting conditions rather than arbitrary placeholder records.
* Clearly distinguish seeded test data from existing tenant data and avoid polluting the environment unnecessarily.

**Do not skip validation simply because the tenant lacks suitable test data.**

---

## 2. No Shallow Implementations

There is **zero tolerance for superficial or cosmetic implementations**.

Do not implement a feature merely because the UI appears to work or because the immediate error disappears.

For every brick/domain you touch:

* Understand the underlying business event.
* Identify the authoritative source of truth.
* Trace the complete lifecycle of the transaction.
* Understand its accounting implications.
* Verify relationships and dependencies across domains.
* Consider downstream reporting, reconciliation, auditability, reversals, corrections, and edge cases.
* Validate both the normal path and failure/exception paths.
* Ensure the implementation is consistent with the broader architecture.

If the existing architecture is incorrect, incomplete, or inconsistent, identify and address the underlying problem rather than layering another workaround on top of it.

---

## 3. Accounting Accuracy Is Non-Negotiable

This is accounting software. **Correctness takes priority over implementation speed.**

Every accounting-related domain and business event must follow sound accounting principles and modern ERP practices.

Use established enterprise ERP patterns as reference points, including systems such as:

* Oracle Financials / FCCS
* Oracle NetSuite
* Microsoft Dynamics 365 Finance
* SAP S/4HANA
* Other mature modern ERP/accounting platforms where relevant

Do not blindly copy another system. **Research and reason about the underlying accounting principle and business requirement first**, then determine the appropriate implementation for this system.

Every accounting brick should be designed with:

* Correct debit/credit behavior
* Proper account ownership and control accounts
* Appropriate posting dates and accounting periods
* Clear transaction states and posting states
* Immutable posted accounting where appropriate
* Controlled corrections, reversals, and adjustments
* Proper treatment of source documents versus accounting entries
* Reconciliation capability
* Audit trails
* Complete traceability
* Correct aggregation into financial statements and reports

If there is uncertainty about an accounting treatment, **stop and investigate rather than guessing**.

---

## 4. Complete Traceability Is a Core System Principle

Every financial transaction and journal entry must be traceable back to its origin.

The system should make it possible to answer questions such as:

> **Why does this accounting entry exist?**
> **What business event created it?**
> **What source document triggered that event?**
> **Which user/system action caused it?**
> **What downstream records were created from it?**

Where applicable, maintain a clear chain such as:

**Business Event → Source Transaction → Accounting Event → Journal → Journal Lines → Ledger → Financial Report**

The user should be able to **drill down and navigate back through this chain** using appropriate drill-downs and deep links.

Do not create accounting entries that become orphaned from their source transaction or whose origin cannot be reconstructed.

---

## 5. The System Must Be Context-Aware

Do not treat each page or module as an isolated CRUD interface.

The system should understand the **business context and state** of the work the user is performing.

For example, when an accountant attempts an action that cannot proceed because a prerequisite is missing, the system should ideally:

1. Understand what is blocking the business event.
2. Identify the actual prerequisite.
3. Explain why the process is blocked.
4. Determine whether the issue can be safely resolved from the current workspace.
5. Provide an appropriate remediation action where possible.
6. Otherwise, provide a deep link to the dedicated workspace where the prerequisite can be completed.
7. Return the user to the original workflow without requiring duplicate or unnecessary actions.

The objective is not merely to display an error such as:

> "Account mapping missing."

The system should understand the business situation and help the user resolve it.

**No dead ends. No unnecessary duplicate actions. No forcing users to rediscover where a prerequisite must be configured.**

---

## 6. Business Events Must Be the Primary Reasoning Model

When implementing or auditing a domain, reason from the **business event first**, not from the UI or database table.

Determine:

* What actually happened in the business?
* Which domain owns that event?
* What record is authoritative?
* What state transition occurred?
* What accounting consequence, if any, should follow?
* Which downstream records should be generated?
* Which records should remain references rather than duplicates?
* What happens if the event is cancelled, reversed, corrected, or partially completed?
* What should happen if a prerequisite is missing?
* How should the user discover and resolve the issue?

This should prevent duplicated logic, conflicting sources of truth, double posting, and disconnected workflows.

---

## 7. Prevent Double Actions and Duplicate Effects

The architecture must account for the possibility that the same business event may be triggered more than once.

Where applicable, ensure operations are:

* Idempotent
* Uniquely constrained
* State-aware
* Transactionally safe
* Protected against duplicate posting
* Protected against duplicate downstream document creation

A retry, refresh, repeated button click, background job retry, or API replay must not accidentally create duplicate accounting consequences.

**One business event should produce one authoritative accounting consequence unless the accounting model explicitly requires otherwise.**

---

## 8. SQL Migrations and Test Execution Must Be Resource-Aware

When using SQL migrations, seed scripts, or business-event simulations for testing, **do not overwhelm the Supabase database**.

Previous implementations have caused instability by executing very large migrations or test workloads in a single operation. Avoid repeating this pattern.

For large migrations or test scenarios:

* Break the work into logical, manageable batches.
* Execute migrations incrementally where practical.
* Avoid unnecessarily large transactions.
* Avoid repeatedly recreating or reseeding large datasets.
* Use targeted test fixtures instead of generating excessive data.
* Run focused business-event simulations rather than unnecessarily executing the entire test suite after every small change.
* Verify database health between particularly heavy operations.
* Prefer efficient SQL and set-based operations over unnecessarily expensive row-by-row processing.
* Avoid concurrent workloads that provide little additional validation but significantly increase database load.

The objective is to **validate thoroughly without destabilizing the shared test environment**.

If a migration is large, reason about how it should be safely executed before running it. Do not simply send the entire workload to Supabase in one massive operation.

---

## 9. Verify Before Declaring Completion

Never consider a brick complete merely because the implementation compiles or the happy path works.

Before moving forward, verify:

* The intended business behavior works.
* The accounting treatment is correct.
* The database state is correct.
* Related domains behave correctly.
* Existing functionality has not regressed.
* Transactions are traceable to their origin.
* Drill-downs/deep links work where required.
* Failure and remediation paths behave correctly.
* Duplicate execution does not create duplicate effects.
* Relevant reports and balances remain accurate.
* The implementation fits the existing architecture.

Only after the current brick has been properly validated should you proceed to the next chronological item.

---

## 10. General Principle

Treat every implementation as if it will eventually be used in a **serious production accounting environment**.

Prioritize, in order:

**Accounting correctness → Data integrity → Business-event integrity → Traceability → Architectural consistency → Resilience → User experience → Implementation speed**

Do not optimize for merely "making the test pass."

The goal is to build a **modern, context-aware, auditable, deeply traceable ERP/accounting system** where the accounting truth is reliable, every important business event has a clear lifecycle, and users can understand not only **what happened**, but also **why it happened, where it came from, what it affected, and how to resolve anything preventing the next business event.**
