# Consolidation — status re-audit (2026-08-28, 13:2x UTC) and the road to the end of the domain

This replaces the previous handover. Everything under "verified" below was checked
this session against the live database (`jkszmrroyjfdwokbkzis`) and the repository —
not taken from the previous agent's notes.

## Verified state of Brick 8 (persisted consolidation runs)

Landed and real:
- Four tables exist: `consolidation_runs`, `consolidation_run_lines`,
  `consolidation_run_members`, `consolidation_run_rates`, each with indexes,
  a unique "one final run per group and period" index, and privileges granted
  to `authenticated` and `service_role` only (no `anon` table grant).
- Three lifecycle functions exist and are SECURITY INVOKER:
  `consolidation_create_run`, `consolidation_finalize_run`,
  `consolidation_supersede_run`, plus the `_consolidation_run_guard` trigger.
- Surface exists: `src/hooks/finance/useConsolidationRuns.ts` and
  `src/components/reports/ConsolidationRunHistory.tsx`, mounted on
  Consolidated Statements; it reads stored run tables only.
- `supabase/tests/consolidation_runs_test.sql` exists (24 structural assertions).

Confirmed gaps — Brick 8 is **not** genuinely closed:
1. **No run has ever been created.** `consolidation_runs` and
   `consolidation_run_lines` are both empty. The lifecycle has never executed
   against a real group, so create → finalize → supersede is unproven behaviour,
   only unproven-by-structure.
2. **`anon` holds EXECUTE on all three lifecycle functions** (the PostgreSQL
   default PUBLIC grant was never revoked). The runs suite asserts the opposite,
   so that suite either was never executed or was executed and not read.
3. **No brick-log section for Brick 8.** The log still ends at Step 7.7 with
   "Brick 8 may now be started".
4. **A stored run cannot be exported.** Every other consolidation surface exports
   through `ReportExportButtons`/`ReportExportService`; the run viewer does not,
   which breaks the artifact-integrity contract in
   `docs/consolidation-traceability-lineage.md`.

## What the next agent must validate first (before any new brick)

Run these, one at a time, and record the actual output:
- Execute `supabase/tests/consolidation_runs_test.sql` and read all 24 results.
- Revoke `EXECUTE ... FROM PUBLIC, anon` on the three lifecycle functions (one
  small migration), then re-run the suite.
- Drive one real run on the existing two-member group in a self-rolling-back
  transaction: create, inspect frozen lines/members/rates, finalize, confirm the
  previous final run is superseded, confirm a closed member period refuses, and
  confirm an unmapped account refuses finalize.
- Confirm a finalized run's figures do not move after a member's FX rate is
  edited (the whole point of the freeze).

## Work order

### 8.6 — Close Brick 8 honestly
Revoke the `anon` EXECUTE grant; add a behaviour block to
`consolidation_scenarios_test.sql` (or a Block 5 in the runs suite) that seeds a
throwaway group and exercises the full lifecycle; add the stored-run export
through the shared pipeline; write the Brick 8 section of
`.lovable/consolidation-brick-log.md` in the established format (verified by
execution, defects found, deliberately absent).

### Brick 9 — Ownership and non-controlling interests
Partial ownership is currently ignored: every member consolidates at 100%.
- Investment-versus-equity elimination (parent's investment against the
  subsidiary's equity at acquisition), as a new elimination rule class.
- NCI share of equity and of the period result, presented as its own line on the
  group balance sheet and income statement.
- Ownership changes over time honoured from the existing ownership history.
- Equity-method members (associates) presented as a single equity-method line
  rather than line-by-line consolidation.
Each piece is one small migration plus one surface change, in the usual style:
all arithmetic in SQL, refusals carrying their own remedy, a scenario block, then
a brick-log section.

### Brick 10 — Consolidated statement of cash flows
Built on a finalized run, never on live recomputation: opening/closing group cash
by member, operating/investing/financing classification driven by group account
mapping, the effect of exchange-rate changes on cash shown as its own line
(reconciled against the run's frozen CTA), and intercompany cash movements
eliminated. Refuses when the group's cash-flow classification is incomplete,
naming the unclassified accounts.

### Brick 11 — Group reporting close (proposed; confirm scope)
The domain does not yet have a defined Brick 11. The candidate is the closing
layer that makes a group's reporting period final: statement of changes in group
equity, period-over-period run comparison, and a group-level lock so a finalized
run's period cannot be silently re-opened by member-level postings.

## Explicitly out of scope until their brick

No NCI, equity method, cash flow or scaffolding for them before Bricks 9–11 are
started. No placeholder tables, no disabled UI.

## Technical notes

- One small single-purpose migration per object; grants to `authenticated` and
  `service_role` only; every new public table gets its GRANTs in the same
  migration.
- Verification is `npx tsgo --noEmit -p tsconfig.app.json` (the solution-style
  `tsconfig.json` checks nothing) plus the consolidation SQL suites run one file
  at a time, never batched.
- External Supabase project: the sandbox cannot mint a signed-in session, so
  anything needing a logged-in click is reported as such, never claimed green.
- Standards carried forward unchanged: realistic test fixtures that roll
  themselves back, no shallow implementations, accounting accuracy over
  convenience, idempotent business events, resource-aware migrations.

## Open question for the user

Brick 11 above is a proposal. If the intended eleventh brick was something else
(segment reporting, group disclosure notes, IFRS-style consolidated pack export),
say so and it replaces that section.

=============================================================


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
