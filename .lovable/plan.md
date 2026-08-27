# Consolidation — close the real enterprise gaps before Brick 8

## Verification of the previous engineer's claims (done this session, against the live `AccrualFlowCorporation` database and the repo)

Confirmed true:

- The engine exists and is server-side: `consolidation_generate_eliminations`,
  `consolidation_diagnose_eliminations`, `consolidation_intercompany_flows`,
  `get_consolidated_statement_lines_eliminated` / `_totals_eliminated`,
  `consolidation_cta_reconciliation`, all SECURITY INVOKER, all behind an
  owner/admin/super-admin org-role check.
- The surface exists: `ConsolidationEliminations`, three-column
  `ConsolidatedStatements`, `ConsolidationEliminationRules` in settings,
  `EliminationRefusalPanel` with server-produced remedy codes, registered in
  the finance routes, report registry, reports nav, app registry and sidebar.
- 147 account mappings, 7 group accounts, 1 group with 2 members exist, and
  eliminations were actually generated for 2026-08 by a real user id.

Confirmed **false or incomplete**:

1. **Eliminations do not balance.** The live period's set is
   debit 2,590,000 vs credit 2,630,000 — **out of balance by 40,000 KES**. The
   generator deliberately leaves a within-tolerance gap "unrecorded"
   (lines 113-117 of the function). An elimination set is a journal entry; a
   one-sided 40,000 injects a 40,000 hole into the consolidated balance sheet.
2. **The live configuration hides the residual rather than accounting for it.**
   The only rule row sets `tolerance_amount = 40000` with policy `refuse` on
   the balance class — a materiality tolerance sized exactly to swallow a
   structural translation residual.
3. **No drill-down from an elimination leg.** `source_evidence` stores
   `source_account_ids` and `entry_count`, and nothing in
   `ConsolidationEliminations.tsx` renders them; there is no leg → intercompany
   position → journal entry path. The log claims this exists.
4. **No default rule templates.** A new group starts with zero rules, so the
   engine falls back to tolerance 0 / `refuse` and the first run always fails.
   This contradicts the product's own default-chart-of-accounts principle.
5. **No period control.** Nothing consults the fiscal-period/close machinery
   that already exists elsewhere in finance; a closed period's eliminations can
   be silently deleted and regenerated.
6. **No audit trail and no reversal.** Regeneration deletes prior rows; only
   `generated_by`/`generated_at` on surviving rows remain. Nothing records who
   ran what, the before/after totals, or a reversal.
7. **The remedy loop is still unproved end-to-end** as a signed-in user.

## How mature systems handle these points

Oracle FCCS/NetSuite, Dynamics 365, SAP S/4 group reporting and Odoo's
consolidation module all agree on four things this system currently misses:
eliminations are posted as **balanced journals** (a rounding tolerance decides
whether the plug is auto-posted, never whether the plug is skipped); the
residual from IAS 21 / ASC 830 retranslation belongs in the **translation
reserve (CTA)**, not in a tolerance; groups ship with **pre-built elimination
rule templates** (IC AR/AP, IC revenue/COGS, investment vs equity); and every
run is **audited, period-controlled and reversible**. That is the gap list
below, in dependency order.

## Execution order

### Step 7.2 — Balanced eliminations invariant (blocking; do first)
- Rewrite the tolerance branch: a difference is **always posted**. Tolerance
  only chooses the destination — at or below tolerance the plug goes to the
  configured rounding destination automatically (CTA for cross-currency,
  difference account otherwise); above tolerance the current refuse/CTA/
  difference policy applies unchanged.
- Add a server-side invariant: per group/period/class, `sum(debit) = sum(credit)`,
  enforced by a verification function the generator calls before it returns, so
  an unbalanced set can never be committed.
- Expose the invariant in `ConsolidatedStatements` from the server's
  `is_balanced`, and correct the live tenant: reset the 40,000 tolerance to a
  rounding-scale figure, set the balance class to carry translation residual to
  the reserve, regenerate 2026-08, and prove the 40,000 lands in the reserve.
- Extend `supabase/tests/consolidation_eliminations_test.sql` with a
  balanced-set assertion for same-currency, cross-currency, within-tolerance
  and above-tolerance pairs.

### Step 7.3 — Default rule templates
- Seed the standard classes for every new group (intercompany balance,
  intercompany trading) with sane defaults — cross-currency residual to the
  translation reserve, rounding-scale tolerance — created at group creation and
  backfilled for existing groups, fully overridable in settings.
- Settings shows which values are system defaults versus user overrides.

### Step 7.4 — Drill-down and deep linking
- Leg → the translated intercompany positions consumed → the source accounts
  and journal entries behind them, using existing GL/account-register routes.
- Statement line → the eliminations that moved it; eliminations report → group
  and period preselected from the statement's context.
- Difference legs explain themselves: policy, tolerance, both currencies, rate
  class used.

### Step 7.5 — Audit trail
- Append-only `consolidation_elimination_events`: who, when, group, period,
  class, action (generate / regenerate / rule change / reversal), row counts and
  debit/credit totals before and after, refusal cause when it failed.
  Insert-only from the engine and the rule triggers, readable by the same roles.
- Surfaced as a run history panel on the eliminations report.

### Step 7.6 — Period control and reversal
- Refuse generation and regeneration for a closed accounting period, reusing
  the existing period-status primitive rather than a new one.
- An explicit reversal action requiring a reason, which clears the set for the
  period and records the reversal in the audit log; no silent overwrite.

### Step 7.7 — Realistic scenario proof
Seed, in a dedicated test organization (never the live group), the scenarios the
parent prompt names: independent companies, differing charts of accounts,
cross-currency parent KES / subsidiary USD, an intercompany sale, a reciprocal
AR/AP pair, translation with CTA, closed-period refusal, double-run
idempotence, and a member of another organization receiving nothing. Each
assertion runs in SQL so it is executed evidence, not narration.

### Then Brick 8
Persisted, versioned consolidation runs — built on 7.5's audit log and 7.6's
period control, not before them. Ownership/NCI and consolidated cash flow stay
out of scope, with no placeholders.

## Checkpoint discipline

Each step ends with its own section in `.lovable/consolidation-brick-log.md`:
what was verified by execution, what changed, the accounting rule now enforced,
the security boundary, and what remains intentionally absent. The log's earlier
Brick 7 claims about drill-down get corrected rather than left standing.

## Technical notes

- No second FX resolver and no second accounting engine: everything continues to
  consume `consolidation_member_translation_rates` and the authoritative finance
  primitives.
- All arithmetic stays in SQL; the architecture tests in
  `src/test/architecture/` are extended to guard the new surfaces.
- Live-session limitation: this project uses an external Supabase project, so
  the sandbox cannot mint a preview session. UI paths are proved by architecture
  tests plus SQL behaviour suites, and any step needing a signed-in click is
  reported as such instead of claimed green.




===========PROGRESS STATUS============
Step 7.3 is in — every consolidation group now ships with an elimination policy instead of failing its first run:

- Seeded template per class: produced, tolerance 1.00 of the presentation currency (rounding scale, not a residual-swallowing materiality figure), cross-currency residual carried to the translation reserve; a same-currency disagreement is still refused by the engine.
- Created at group creation by trigger, backfilled for existing groups, and reseeding only ever fills a missing class — the live group's customised 41,500 / 1,500 tolerances were left untouched.
- Default vs override is now recorded: any human edit flips the row out of system-default state, and settings labels each class System default / Customised for this group / Not configured.
- Verified: new `supabase/tests/consolidation_elimination_defaults_test.sql` (wiring, grants, backfill invariant, non-destructive reseed, flag flip), architecture suite 13/13, typecheck clean, live rows re-read. Checkpoint written to the brick log. Linter counts fell by 2 — the new helpers are invoker or revoked from `anon`/`authenticated`.

Next in sequence is Step 7.4 — drill-down from an elimination leg to the intercompany positions and journal entries behind it. Want me to proceed?

==============================================
# Execution Instructions

1. **Verify Previous Implementation**

   * Before making any new changes, carefully verify that the previous implementation has been fully completed, correctly integrated, and actually landed in the codebase and database where applicable.
   * Do not assume that a previous task was completed merely because the relevant code appears to exist. Validate the actual behavior, dependencies, and business flow.

2. **Proceed Chronologically**

   * Once the previous step has been verified, identify the **next logical step, brick, or item in the sequence**.
   * Follow the established implementation order rather than jumping ahead or working on unrelated areas.

3. **Work Professionally and Analytically**

   * Approach each step systematically and from first principles.
   * Understand the existing architecture, business logic, dependencies, and intended behavior before making changes.
   * Avoid rushed, speculative, or superficial implementations.

4. **Maintain Stability**

   * Preserve existing functionality and architectural integrity while progressing to the next step.
   * Ensure each completed brick leaves the system in a stable, coherent state before proceeding further.

5. **Keep the Process Organized**

   * Clearly establish what has already been completed, what remains, and what the current step is intended to accomplish.
   * Work through the sequence incrementally and methodically rather than attempting to implement everything at once.



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
