
# Consolidation — verified handover (2026-08-28, 11:4x UTC), Step 7.7 then Brick 8

Your Supabase project `AccrualFlowCorporation` (ref `jkszmrroyjfdwokbkzis`) is already connected — no connection work is needed.

## Phase 1 — what I verified this session (not taken on trust)

Checked directly against the live database and the repository:

**Genuinely landed**
- The engine is server-side and SECURITY INVOKER throughout: `resolve_consolidation_scope`, `consolidation_translate_member`, `get_consolidated_trial_balance(_translated)`, `get_consolidated_statement_lines/_totals` and their `_eliminated` variants, `consolidation_intercompany_balances/activity/coverage/flows/entry_lines`, `consolidation_generate_eliminations`, `consolidation_diagnose_eliminations`, `consolidation_elimination_evidence`, `consolidation_eliminations_balance`, `consolidation_reverse_eliminations`, `consolidation_cta_reconciliation`. Only the trigger guards and the scope-count helper are DEFINER.
- Tables present: groups, members, group accounts, account mappings, intercompany partners, elimination rules, eliminations, group change log, and `consolidation_elimination_events`.
- **Step 7.5 (audit trail) is real**, contrary to the brick log, which still lists it as absent. `consolidation_elimination_events` exists and the eliminations report renders a "History of this period's runs" panel from it.
- **Step 7.6 (period control and reversal) is real.** `consolidation_generate_eliminations` refuses when a member's fiscal period covering the range is closed, with a remedy-carrying message; `consolidation_reverse_eliminations` exists and the page has a reason-required withdrawal dialog.
- The traceability wave closed: five surfaces on one drill primitive, one branded export pipeline, `docs/consolidation-traceability-lineage.md` written.
- `npx tsgo --noEmit -p tsconfig.app.json` is clean.

**Confirmed still open**
1. **Step 7.7 — the realistic scenario proof does not exist.** `supabase/tests/` has ten consolidation suites, none of which is the multi-scenario proof the parent prompt requires (independent companies, differing charts, KES parent / USD subsidiary, intercompany sale, reciprocal AR/AP, CTA, closed-period refusal, double-run idempotence, cross-organization isolation).
2. **The brick log is stale.** It ends at Step 7.4 and explicitly names audit history, period control and reversal as "intentionally absent" — both now false. A closure record that misstates what exists is worse than none.
3. **Brick 8 has not been started.** There is no persisted, versioned consolidation run: figures are recomputed on every read, so "what did we report for 2026-08, and on what basis?" cannot be answered.

## Phase 2 — plan corrections carried forward

- Brick 8 stays strictly persistence and versioning of what the engine already computes. No NCI, no equity method, no consolidated cash flow, and no placeholders for them.
- One accounting truth: a run stores the output of the existing RPCs. It never recomputes balances, never resolves its own FX rates, and the browser never does arithmetic.
- A step closes only when its SQL suite has executed against the live database and the result is recorded in the brick log.
- Status claims are re-derived from the repository and database at the start of each session, never copied forward from a previous log.

## Work order

### Step 7.7 — Realistic scenario proof (do first; blocks Brick 8)

New `supabase/tests/consolidation_scenarios_test.sql`, built as separate blocks in one rolling-back transaction, each block a fixture in a dedicated test organization — nothing seeded into the live tenant:

1. Two independent companies, no intercompany — group totals equal the sum of translated members.
2. Different charts of accounts mapped to one group chart — an unmapped account refuses rather than silently dropping.
3. Parent KES / subsidiary USD — closing rate on balance items, average rate on income items, residual to the translation reserve, CTA reconciliation ties.
4. Intercompany sale A→B — revenue and COGS eliminate to nil at group level.
5. Reciprocal AR/AP — the pair eliminates and the set balances (`consolidation_eliminations_balance` = balanced).
6. Closed member period — generation refuses with the remedy message.
7. Double run — regenerating produces the same legs and one additional audit event, never duplicated accounting effect.
8. Reversal — withdrawal clears the set, records the event, and leaves the statement unchanged from pre-generation.
9. Cross-organization isolation — a caller from another organization receives nothing from any consolidation RPC.

Run one file at a time, never batched.

### Step 7.8 — Correct the brick log

Rewrite the stale "intentionally absent" claims and add the Step 7.5, 7.6 and 7.7 sections in the log's existing format: what was verified by execution, what changed, the accounting rule now enforced, the security boundary, what remains deliberately absent.

### Brick 8 — Persisted, versioned consolidation runs

Only after 7.7 passes.

- `consolidation_runs`: group, period from/to, presentation currency, state (draft / final / superseded), FX basis snapshot, rule-set snapshot reference, actor, timestamps, and the balance verdict. Grants to `authenticated` and `service_role` only, RLS by organization and group access, append-only state transitions through a function.
- `consolidation_run_lines`: the frozen statement lines the run produced, each traceable to group account, member contributions and the elimination legs that moved it.
- `consolidation_create_run` / `consolidation_finalize_run` / `consolidation_supersede_run`: SECURITY INVOKER, period-controlled the same way generation is, refusing an unbalanced elimination set and any period a member has closed.
- Surface: a run history and run viewer on the consolidated statements report, where a finalized run is read from storage rather than recomputed, and a live view is clearly labelled as live.
- Its own SQL suite plus architecture-test coverage, then a brick log section.

## Explicitly out of scope

Non-controlling interest, equity method, consolidated cash flow, and any TODO scaffolding for them.

## Technical notes

- Each new database object goes in its own small migration; grants to `authenticated` and `service_role` only.
- All arithmetic stays in SQL; architecture tests in `src/test/architecture/` are extended in the same change as any new surface.
- Verification is `npx tsgo --noEmit -p tsconfig.app.json` (the solution-style `tsconfig.json` checks nothing) plus the consolidation suites.
- This is an external Supabase project, so the sandbox cannot mint a signed-in session; anything that genuinely needs a logged-in click is reported as such rather than claimed green.

=======================PROGRESS STATUS====================
Step 7.7 is closed: all four scenario blocks in supabase/tests/consolidation_scenarios_test.sql (differing charts + unmapped refusal, KES/USD translation with CTA, intercompany elimination with re-run/audit/withdrawal, closed-period and cross-org isolation) were executed against the live database and passed, with everything rolled back; the brick log now records those results and corrects the stale "audit trail and period control are absent" claim.

Two assumptions from the earlier plan turned out wrong and are fixed in the suite: group equity includes the period result, and RLS must be checked under SET LOCAL ROLE authenticated since the migration role bypasses it.

Next up is Brick 8 (persisted consolidation runs) — say the word and I'll start it.

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
