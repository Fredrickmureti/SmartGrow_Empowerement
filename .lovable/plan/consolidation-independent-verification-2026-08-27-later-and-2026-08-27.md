# Consolidation — independent verification (2026-08-27, later) and the next brick

Supabase project `AccrualFlowCorporation` (ref `jkszmrroyjfdwokbkzis`) is already
connected. No connection work is needed.

Everything below was checked directly against the live database and the files in this
session. The previous engineer's progress note was treated as unverified.

## Phase 1 — what is actually true right now

| Previous claim | Verdict | Evidence |
|---|---|---|
| Group settings configure the reserve account and each foreign company's equity rate date | True | `ConsolidationGroupsSettings` has a translation-settings card with an equity-account picker and a per-member historical rate date, both persisted through `useConsolidationGroups` |
| The Consolidated Trial Balance reads the translated engine | True | The page calls only the translated RPC, renders per-line rate class, own-currency figures per company, the reserve line and an independent reserve proof |
| An architecture test fails if a consolidation RPC is unreachable from the UI | True | `consolidated-trial-balance.test.ts` asserts every user-facing consolidation RPC appears in a hook |
| Brick 3 database side is real | True | `consolidation_translate_member`, `get_consolidated_trial_balance_translated`, `consolidation_cta_reconciliation`, `consolidation_member_translation_rates` all exist; only guards and the member-count helper are SECURITY DEFINER, so RLS still applies to every read path |
| Front-end and architecture tests pass | True | 22 consolidation architecture assertions pass |
| The four SQL suites have been executed against the current function bodies | **Unproven** | Nothing in the repo or the plan records a run. A test written but never executed is not evidence |

Also established, not from the old notes:

- There is **no** intercompany, trading-partner, related-party or elimination object
  anywhere in the database. Brick 6/7 are genuinely greenfield.
- Consolidated reporting today is **trial balance only**. There is no consolidated
  P&L and no consolidated balance sheet on the translated engine. The old comparative
  page still shows companies side by side in their own currencies and still says
  consolidation is future work.

**Conclusion:** Brick 3 is functionally complete but not closed — it has never been
validated end to end against the live functions. Resume at validation, close the brick,
then build Brick 5 (consolidated statements), not intercompany.

## Phase 2 — additions to the plan

- The consolidated P&L and balance sheet must be projections of the same translated
  trial balance, not new queries. One translation, one set of statements.
- The balance sheet must prove it balances *including* the translation reserve, and
  refuse to render rather than show an out-of-balance statement.
- Retained earnings and the current-period result need an explicit, stated rule at
  group level; this is where a silent second accounting truth would otherwise appear.
- The comparative page's "consolidation is future work" copy is now false for currency
  translation. It must be corrected and pointed at the real statements without
  deleting the side-by-side view, which is still legitimate management reporting.

## Work order

### Step A — validate Brick 3 (blocking)
Execute all four suites against the live functions:
`consolidation_group_foundation_test.sql`, `consolidated_trial_balance_test.sql`,
`consolidated_trial_balance_reconciliation_test.sql`,
`consolidation_translation_test.sql`. Fix whatever they surface. Record the outcome
here. Nothing else starts until they pass.

### Step B — close Brick 3
Write the stop/go checkpoint into this file: what was established, the accounting
rules that now hold (current-rate method, dated equity movements, average-rate result,
reserve as residual with an independent proof), the security boundaries, what passed,
and what Brick 5 depends on.

### Step C — Brick 5: consolidated statements
- A single group-level statement engine in SQL that consumes the translated trial
  balance and classifies accounts through the existing authoritative account-type
  classification — no new classification logic, no arithmetic in TypeScript.
- Consolidated P&L: income and expense at the period average rate, group result,
  per-company contribution on drill-down, non-controlling share disclosed separately.
- Consolidated balance sheet: assets and liabilities at closing rate, equity at
  dated/historical rates, translation reserve as its own equity line, with a hard
  balance check that blocks the report when it fails.
- Every blocker (rate gap, missing reserve account, inaccessible member, equity-method
  member, closed-period edge) is explained in plain English, never a blank report.
- Drill-down from any consolidated figure to the contributing company and account.
- Explicit, visible statement that intercompany balances are not yet eliminated.

### Step D — tests for Brick 5
Same-currency group is a no-op; mixed-currency group ties to the translated trial
balance; the balance sheet balances only with the reserve included; refusal paths;
scope isolation (a user without access to one member cannot see group figures);
architecture test extended to the new RPCs.

## Explicitly out of scope until Brick 5 closes

Intercompany identification, eliminations, consolidated cash flow, persisted
consolidation runs, minority-interest equity roll-forward, equity method. No
placeholders for any of them.
