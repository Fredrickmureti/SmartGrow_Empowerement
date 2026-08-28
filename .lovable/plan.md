# Consolidation — what the artifacts are actually telling you, and the repair order

Everything below was verified this session against the live database, the SQL
engine source, the page code and the two PDFs you uploaded. Nothing is carried
over from the previous agent's notes.

Short answer to your question: **it is not you.** Two of the three things you
questioned are genuine defects that would fail an audit, and the third (the red
residual banner) is the system correctly reporting a real accounting problem
that was then papered over with a fitted tolerance.

## A. The Trial Balance says "Out of balance by KES 1,960,000". It is wrong — the group actually balances.

The TB footer computes its balance proof by summing the **period movement**
debit and credit columns (KES 2,077,212.00 vs KES 117,212.00). But the
translation reserve figure is a **closing-balance** plug, not a movement, so
those two columns can never tie in a translated group TB. The correct proof is
on closing balances, and it ties exactly:

```text
Assets            77,840,867.60
Liabilities        2,590,249.60
Equity + reserve  64,878,843.40
Result             10,371,774.60
Sum of L + E      77,840,867.60   -> in balance
```

So a corporate reader is being told their consolidated trial balance is broken
when it isn't. Related: the reserve row does not roll forward either —
opening 1,738,443.40 plus debit 1,960,000.00 does not reach closing
-221,556.60, because opening, movement and closing are each computed as
independent plugs.

## B. The Consolidated Balance Sheet's totals are pre-elimination, and "in balance" is asserted against the wrong column.

The line rows come from the eliminated projection; the totals block and the
"is balanced" verdict come from `get_consolidated_statement_totals`, which sums
the **non-eliminated** lines. Verified in the function body and in the page
(`ConsolidatedStatements.tsx` line 259). The printed effect:

| Printed | Value | Actual consolidated |
| --- | --- | --- |
| Total assets | 77,840,867.60 | 75,209,127.60 |
| Total liabilities | 2,590,249.60 | 9.60 |
| Total equity | 75,250,618.00 | 75,209,118.00 |

The printed equity total does not even equal the sum of the equity lines
printed directly above it (gap: exactly the 41,500 residual). The consolidated
column does balance — the totals row is simply reading the wrong source.

## C. The red residual banner — the accounting substance

The two elimination rules in this tenant carry tolerances of **41,500.00** and
**1,500.00**, which are exactly the size of the two observed gaps. The system's
own seeded default is 1.00. The tolerances were fitted to the data so the run
would stop refusing. Worse, both rules say `difference_policy = refuse`, but
the engine plugs to the reserve whenever a gap is *inside* tolerance and never
consults the policy — so the "Policy in force: Refuse the run" chip on that
screen is not the policy that ran.

The substance of each residual:

- **KES 40,000 (balances).** The parent holds a KES 2,630,000 receivable; the
  subsidiary holds a USD 20,000 payable. They matched at the trade rate 131.5
  and diverge at the closing rate 129.5. That is an **unrecorded exchange loss
  on the parent's foreign-currency intragroup monetary item**. IAS 21.45 puts
  exchange differences on intragroup monetary items in profit or loss unless
  the item forms part of the net investment in a foreign operation. Carrying it
  to the translation reserve by default is not correct, and the real remedy is
  member-level period-end revaluation, not a consolidation plug.
- **KES 1,500 (trading).** Posted as Dr Income 1,500 / Cr reserve 1,500 — that
  removes group revenue into equity. Both sides of intragroup trading translate
  at the same average rate, so a trading mismatch is never a translation
  difference. It means one side is unrecorded, or the margin is sitting in the
  buyer's inventory (unrealised profit, eliminate against inventory), or it is
  a timing cut-off. Never the reserve.

## D. The PDFs — yes, they are being generated for the sake of it in three specific ways

1. **Wrong entity on the masthead.** Both group artifacts are headed *Mombasa
   Port Services Limited, Mombasa KE, Tax ID P052001234X, Headquarters (HQ)* —
   a subsidiary and a branch — for a Joshua Holdings Group report.
2. **Traceability is stripped in the export.** The contribution rows export an
   empty account code and name by construction, which is why the PDF shows six
   identical `- - Joshua Holdings (parent)` rows under G1900. On screen those
   are 1015 Cash on Hand, 1100 AR, 1340 Undeposited Funds. An auditor cannot
   tie the artifact back to any ledger.
3. **"Run 12d1ea08" / "Run 45773053" are not consolidation runs.** They are
   per-export identifiers — the same period printed six minutes apart carries
   two different "Run" numbers. `consolidation_runs` is empty: **no
   consolidation run has ever been created in this system.**

The tiny type has a single named cause: PDF typography is pinned per report in
the server report registry, and consolidation reports are not registered at all
and send no report type, so they miss the `statement` profile (10pt, taller
rows) that the Balance Sheet, P&L and Trial Balance receive, and fall through
to inferred density. The registry-coverage test that enforces this on statutory
statements simply does not cover consolidation.

## E. Configuration gaps

- The group's translation reserve points at **account 3050 owned by Joshua
  Holdings**, a member's own GL account, while every other group line uses the
  group chart (G1100, G2100, G3900). The group's reserve should be a group
  account.
- Nothing bounds or justifies an elimination tolerance, and nothing records who
  widened one or why — which is how 41,500 got in.
- Brick 8 remains open on its own terms: lifecycle functions exist, zero runs
  have ever executed, and `anon` still holds EXECUTE on all three.

## Repair order

Each step lands complete — SQL, guard, surface, artifact, scenario test, brick
log — before the next begins.

**R1 — Stop the artifacts from lying.** TB balance proof moves to closing
balances; balance-sheet totals and the balanced verdict read the eliminated
projection. Scenario assertions that a translated group TB proves on closing
balances and that totals equal the sum of the printed consolidated lines.

**R2 — Artifact identity and traceability.** Group masthead for group reports;
member account code and name restored in exported contribution rows; the "Run"
line on a consolidated artifact carries the consolidation run id or is plainly
labelled an export reference.

**R3 — Register consolidation reports.** Add them to the server report registry
with `presentationProfile: "statement"` pinned, and extend the registry
coverage test so a consolidated statement can never again ship unpinned.

**R4 — Make the residual policy honest.** Apply `difference_policy` inside
tolerance as well as outside; forbid trading residuals from reaching the
translation reserve; disclose any residual as a named reconciling line on the
face of the consolidated statements rather than inside equity; bound tolerances
and record who changed one and why; reset this tenant's fitted 41,500 / 1,500
to a defensible policy.

**R5 — Remove the cause, not the symptom.** Member-level period-end revaluation
of foreign-currency intragroup monetary balances, so the KES 40,000 is
recognised where it belongs and the residual disappears legitimately.

**R6 — Make the reserve articulate.** Opening plus movement equals closing for
the translation reserve, and move the group reserve onto a group account
instead of the parent's 3050.

**R7 — Close Brick 8 for real.** Revoke the `anon` EXECUTE grants and drive one
genuine create → finalize → supersede run against this group, with the frozen
figures proven immune to a later member rate edit. Only then Brick 9 (ownership
and non-controlling interests).

## Deliberately not in this plan

No NCI, no equity method, no consolidated cash flow, and no scaffolding for
them. No new tables until R4 needs one.

================================================
IMPLEMENTATION PROGRESS
=========================================
R3 is done: the consolidation reports are now registered reports rather than anonymous wide tables.

- Added `consolidated_balance_sheet`, `consolidated_income_statement`, `consolidated_trial_balance` and `consolidation_eliminations` to the shared report registry (`_shared/reports/columnSpecs.ts`), each with a pinned format profile, orientation and typography. The two group statements now print portrait at the statutory `statement` face (10pt, semantic total spacing, "Page i of N"); the trial balance and elimination schedules print landscape at the `ledger` face, which reclaims the page gutter for column width instead of shrinking digits — that is the honest treatment for an eight-column working schedule.
- The three pages now declare their registry key and orientation on export, and `ReportExportService` stopped forcing every prebuilt PDF to landscape.
- Bumped the PDF cache to `v: 8` and redeployed `render-report` and `process-scheduled-reports`, so the next export you pull is the new typography, not a cached rendition.

Typecheck passed and both consolidation suites are green (34 tests).

What remains from the audit order: R4 — the elimination engine plugging residuals into the translation reserve while the group policy says refuse, and the tolerance that was fitted to the exact size of the KES 41,500 error; then R5 (the underlying IAS 21 revaluation the parent never recorded), R6 (defaults a new group ought to get automatically), R7 (configs buried out of the UI). I'd also re-render one PDF of each type and read it page by page before calling the presentation work proven.


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
