# Consolidation — verified handover (2026-08-27 late) and Step 7.4: drill-down

## Phase 1 — Independent verification of the previous engineer's claims

Checked directly against the live `AccrualFlowCorporation` database and the repo,
not against the log.

Confirmed **true**:

- **Step 7.2 (balanced eliminations) is real.** `consolidation_eliminations_balance`
  exists as a server function, and the live 2026-08 set now balances exactly:
  intercompany balance 2,631,740 debit = 2,631,740 credit (5 legs, 1 difference
  leg), intercompany trading 1,500 = 1,500 (2 legs, 1 difference leg). The
  previously reported 40,000 one-sided hole is gone; the residual is carried as
  an explicit difference leg rather than being dropped.
- **Step 7.3 (default policy templates) is real.** `consolidation_elimination_rules`
  carries `is_system_default` and `seeded_at`; `_consolidation_seed_default_rules`,
  the group-creation trigger, the human-edit flag trigger and the caller-facing
  reseed function all exist in the database. The live group's two customised
  policies (tolerance 41,500 and 1,500, policy `refuse`) are untouched and
  correctly reported as customised rather than default, and no group is missing a
  class.
- The engine surface is intact: generate, diagnose, intercompany flows,
  `_eliminated` statement RPCs, CTA reconciliation, the eliminations report, the
  three-column consolidated statements, and the settings policy editor.

Confirmed **false / still outstanding**:

- **Drill-down does not exist.** The Brick 7 log section claims the eliminations
  report offers "drill-down to the intercompany positions consumed". It does not.
  `source_evidence` (`source_account_ids`, `entry_count`,
  `net_debit_before_elimination`) is written by the engine and is referenced
  nowhere in `src/` — the report never reads it, and there is no path from a leg
  to a position, account or journal entry. That log claim is corrected here.
- **The live group's 41,500 tolerance is still a materiality-sized figure with
  policy `refuse`,** not the rounding-scale default. Step 7.2 made the set
  balanced; it did not resolve whether that tolerance is the accountant's
  intended policy. This stays an accountant decision, surfaced but not
  overwritten.
- **The remedy loop is still unproved as a signed-in user** — this project uses an
  external Supabase project, so the sandbox cannot mint a preview session.

Nothing later than 7.3 was started. Resuming at **Step 7.4**.

## Phase 2 — Plan additions justified by the verification

Two items the previous plan did not name, added to 7.4's scope because they are
inherent to drill-down:

1. **Cross-company drill-down is an authorization event, not a link.** The group
   report is visible to an org owner/admin; the member company's ledger is
   business-scoped. A leg must only offer a ledger link for a business the
   viewer can actually open, and the server, not the browser, decides that.
2. **Evidence today is thin.** `source_evidence` holds account ids and an entry
   count. Naming an account and counting entries is not traceability; the
   drill-down needs the positions and the actual entries behind them, returned
   by a server function that reads the same primitives the generator reads, so
   preflight, run and evidence cannot disagree.

Unchanged remaining sequence after this step: 7.5 audit trail, 7.6 period
control and reversal, 7.7 realistic scenario proof, then Brick 8 (persisted,
versioned runs). Ownership/NCI and consolidated cash flow stay out of scope,
with no placeholders.

## Step 7.4 — Drill-down: every consolidated number explains itself

### Database

- `consolidation_elimination_evidence(group, period_start, period_end, class,
  declaring_business, counterparty_business, group_account)` — read-only,
  SECURITY INVOKER, fixed `search_path`, behind the same owner/admin/super-admin
  organisation check as generation. For one elimination leg it returns the
  translated intercompany positions consumed (both companies, both source
  accounts with code and name, source-currency and presentation-currency
  amounts, the translation rate class applied), and, underneath each position,
  the journal entries behind it (entry id, number, date, business, line amount)
  so a figure resolves to documents rather than to a count. Reads the same
  `consolidation_intercompany_flows` / translation primitives as the generator;
  no new arithmetic, no second FX resolver.
- `consolidation_line_eliminations(group, period, group_account)` — which
  elimination legs moved a given consolidated statement line, for the
  statement → eliminations path.
- Both functions return, per referenced business, a server-computed
  `viewer_can_open_ledger` flag so the client never decides access itself.
  `anon` revoked; grants match the existing consolidation functions.

### Surface

- **Eliminations report:** each leg expands into its evidence — positions, then
  entries. A difference leg explains itself instead of expanding: policy in
  force, tolerance, both currencies, the rate class used, and the residual, from
  the diagnosis the server already produces. Entry rows deep-link to the
  existing journal entry detail route and account rows to the existing general
  ledger route (`account_id` + `date_from` + `date_to`), only when the server
  says the viewer can open that business's ledger; otherwise the row states
  plainly that the ledger belongs to a company outside the viewer's access.
- **Consolidated statements:** the Eliminations column amount on a line opens
  the eliminations report with group, period and group account preselected via
  query params, matching the `?consolidationGroup=` convention Step 7.1
  established in finance settings.
- No arithmetic and no refusal-text sniffing in the browser — the existing
  architecture guard is extended to cover the new components.

### Verification for this step

- New `supabase/tests/consolidation_elimination_evidence_test.sql`: evidence sums
  reconcile to the leg it explains; a same-currency and a cross-currency leg both
  resolve to entries; a difference leg returns its policy context and no phantom
  positions; a member of another organisation receives nothing; `anon` is
  refused.
- Architecture suite extended and re-run, `tsgo --noEmit` clean, live rows re-read
  against the report.
- Checkpoint appended to `.lovable/consolidation-brick-log.md`, including the
  explicit correction of the earlier false drill-down claim.

### Intentionally absent after this step

Audit/run history (7.5), period control and reversal (7.6), persisted versioned
runs (Brick 8), NCI and consolidated cash flow. No scaffolding or disabled
controls for any of them.




===========PROGRESS STATUS============

Step 7.4 is in: the engine now exposes entry-level intercompany evidence (with the aggregate flows derived from it, so summary and detail can't diverge), an authorization-aware per-leg evidence RPC, and an expandable drill-down in the eliminations report with ledger links only where the server permits them. One caveat recorded in the brick log: numeric tie-out of the rebuilt flows against the stored August run needs a signed-in accountant, since this external Supabase project blocks unauthenticated verification.

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
