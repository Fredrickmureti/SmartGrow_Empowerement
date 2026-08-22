# Financial Statements — Execution Ledger (continuation of the 2026-08-22 audit)

Companion to `.lovable/plan/financial-statements-p-l-balance-sheet-audit-findings-execut-2026-08-22.md`
(findings, principles, verdicts). This file tracks only what is now **done, proven, or pending**.

## Verified state of the predecessor's work

- `finance_can_read_scope(_org_id, _business_id)` was present in all five reporting
  RPCs → audit **Phase A (business-level authorization) is genuinely complete**
  (VERIFIED FACT: `pg_get_functiondef` on `get_account_movements`,
  `get_ledger_opening_balances`, `get_equity_result`, `get_general_ledger`,
  `get_journal_report`).
- No other implementation work existed. Phases B–F were unstarted.
- Corrected predecessor claims: balance-sheet imbalance is *surfaced* (validation
  card), not silently swallowed; the root cause of the missing prior-year profit is
  the reporting-window start date, not a missing client-side addition.

## Completed and proven this wave

**Phase B — one retained-earnings authority (DONE).**
`get_ledger_opening_balances` only folds closed years' result into the
retained-earnings account when the requested date is at/before the fiscal-year
start. Both statement paths pinned windows that defeated that fold, so every prior
year's profit dropped out of equity and the balance sheet did not balance.

- `src/hooks/useFinancialReport.ts` — resolves `get_equity_result` first and uses its
  `fiscal_year_start` as the movements/openings window (`effectiveDateFrom`);
  equity = accounts + current-year earnings + prior years' result *only when no
  retained-earnings account exists* (otherwise it is already inside the account).
- `supabase/functions/_shared/reportDataEngine.ts` `buildBalanceSheet` — same
  anchoring, same equity composition, so PDF/export and screen cannot diverge.
  Correct for any requested start date because
  `opening(fy_start) + movement(fy_start..end) == balance(end)`.

**Phase C — export/screen convergence for equity (DONE for the equity defect).**
Both builders now derive equity from the same RPC with the same rules, including the
"no retained-earnings account" fallback line. Remaining Phase C items (multi-step
structure parity, `branchId` threading into `buildIncomeStatement`) still pending.

**Phase A+ — branch and module authorization on the reporting RPCs (DONE).**
The RPCs are SECURITY DEFINER, so RLS on `journal_entries` / `accounts` does not
apply; they validated branch *ownership* but never branch *access*, and skipped the
`financials:read` module permission the RLS policies require. Added
`finance_can_read_branch(_org, _business, _branch)` and
`finance_can_read_financials(_org, _business)` and injected both into all five RPCs
by patching their existing scope check in place (so aggregation logic is
byte-identical). Named branch → caller must be able to access it; all-branches
request → head-office access (no branch assignments in scope) or
`finance.view_consolidated`. Verified no current user is locked out
(`user_branch_assignments` ⋈ `user_roles` probe: 0 affected).

**Drill-down defect (DONE).**
`FinancialReports.tsx` compared `activeTab === "bs"` while the tab value is
`"balance_sheet"`, so every balance-sheet drill-down was period-bounded and could
never reconcile with the cumulative figure on the line. Fixed.

**Consolidation gate surfaced (DONE).**
`requiresConsolidation` now renders an explanatory banner instead of a statement of
zeros that reads as "no activity".

**Tests (DONE for the above).**
`src/test/architecture/report-statement-snapshot.test.ts` rewritten: the Supabase
double is now RPC-shaped (the old one only mocked `.from`, so the file had been
failing) and reproduces the SQL fold rule. Asserts the statement balances and keeps
closed-year profit for windows starting 1970-01-01, at fiscal-year start, and
mid-year; asserts no double counting of prior years; asserts the unallocated line
when no retained-earnings account exists. Proven non-vacuous: reverting the
fiscal-year anchoring makes the mid-year case fail.

## Pending, in dependency order

1. **Phase D — hierarchy correctness.** Parent rows must show rolled-up figures and
   parents' own postings must enter section totals exactly once (roll up onto
   rendered rows, total from roots). Highest remaining accounting risk.
2. **Phase C remainder.** Multi-step P&L structure parity between screen and
   `reportDataEngine`; thread `branchId` into `buildIncomeStatement`; express
   "balance sheet is entity-level" in one shared constant consumed by both
   `ReportBranchFilter` and the server builder.
3. **Phase E — classification hygiene.** Warn at report level when any in-scope
   account was classified by code range rather than `detail_type`, and when no
   retained-earnings account resolves.
4. **Deactivated accounts carrying balances.** `is_active = true` filters can drop an
   account that still has a balance; either include non-zero inactive accounts or
   block deactivation while a balance exists.
5. **Comparative periods on the balance sheet.**
6. **Phase F — Statement of Changes in Equity; masthead states basis, currency, scope.**
7. **SQL tests** (`supabase/tests/`) for the RPC gates: sibling-branch request denied,
   non-member business request denied, head-office all-branches allowed.

## Scope boundaries (unchanged)

No second reporting engine, no client-side ledger aggregation, no FX translation
work, no posting-engine changes. Trial Balance / GL / Journal Report touched only
through the shared authorization functions.

## Execution status

- **Active phase:** none in flight — every item above marked DONE is complete,
  typechecked (`tsgo` clean) and covered by passing tests
  (`src/test/architecture/report-statement-snapshot.test.ts`, plus
  `report-export-coherence` and `ledger-reports-single-source` re-run green).
- **Next phase:** Pending item 1 — **Phase D, hierarchy correctness**.

## Instructions for the next agent

1. **Verify before extending.** Re-confirm, don't trust this file:
   - `finance_can_read_branch` / `finance_can_read_financials` exist and appear in all
     five reporting RPCs (`pg_get_functiondef`), and that an authenticated non-HQ user
     is refused a sibling branch. `supabase--read_query` cannot execute these RPCs
     (no EXECUTE for that role) and this project is `external_unmanaged`, so no
     authenticated browser session could be minted — **the gates are proven by
     definition inspection and a lock-out probe, not by a live signed-in call.** Close
     that gap with the SQL tests in pending item 7.
   - `useFinancialReport.ts` resolves `get_equity_result` before movements/openings and
     uses `fiscal_year_start` as the window start; the client path has no unit test yet
     (the server path does) — consider adding one.
   - Run `bunx vitest run src/test/architecture/report-statement-snapshot.test.ts`; it
     must pass, and must fail if the fiscal-year anchoring is reverted.
2. **Then resume at Phase D** (parent/child roll-up and single-count section totals) —
   the largest remaining accounting-correctness risk — and work down the pending list
   in order. Update this file as each item lands.
