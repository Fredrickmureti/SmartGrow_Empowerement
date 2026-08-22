# Financial Statements — Audit Findings & Remediation Plan

Investigation wave. Every claim below is tagged:
**[VF]** verified fact (code/DB read this session) · **[AP]** accounting principle ·
**[RC]** research-based conclusion · **[INF]** inference · **[UNV]** unverified.

---

## 1. Verified facts

- **[VF]** The category is exactly two statements, rendered by one page:
  `src/pages/reports/FinancialReports.tsx` (737 lines), tabs `pnl` / `bs`.
- **[VF]** Both statements come from ONE client hook, `src/hooks/useFinancialReport.ts`,
  which calls three `SECURITY DEFINER` RPCs and no others:
  `get_account_movements`, `get_ledger_opening_balances`, `get_equity_result`.
  All balance derivation is SQL-owned; the browser does hierarchy, sub-typing and
  presentation only. There is no second reporting engine on the screen path.
- **[VF]** Status filtering is centralised: `ledger_visible_journal_statuses()`
  returns `{'posted','reversed'}`. Draft and voided entries are excluded.
- **[VF]** Including `reversed` is CORRECT here: reversal is a real counter-entry.
  DB check — `JE-00009` (status `reversed`, 50 000) has posted counter-entry
  `JE-00009-REV` (50 000). Net effect zero. No in-place voiding without a counter-entry.
- **[VF]** The ledger itself is internally sound in the live DB: total debits =
  total credits = 211 850.40; no entry has unbalanced lines; zero journal lines point
  at an account belonging to a different business; zero accounts have a NULL `business_id`.
- **[VF]** Accounting equation currently holds exactly: assets 95 840.00 =
  liabilities (−5 010.00) + equity accounts 100 400.00 + net income 450.00.
- **[VF]** Classification is authoritative, not name-based: `detail_type` lookup first
  (`accountingKernel.classifyAccount`), numeric code-range only as fallback for legacy
  accounts. One kernel, mirrored server-side, pinned by an existing parity test.
- **[VF]** Parent/child double counting is NOT present. `buildAccountHierarchy` rolls
  children into a group node's `rollup_amount` (presentation only); section totals sum
  each account's OWN `display_amount` exactly once.
- **[VF]** P&L uses period movement only (`credit − debit` for income,
  `debit − credit` for expense). Opening balances never leak into P&L.
- **[VF]** Balance Sheet is as-of: `dateFrom` is pinned to `1970-01-01`, `dateTo` is the
  as-of date, so closing balances are cumulative. Drill-down uses the same window, so a
  drill total reconciles to the line.
- **[VF]** Export parity holds. `getPnlExportConfig`/`getBsExportConfig` omit
  `dateFrom`/`dateTo`, so `canServerBuild()` is false and `render-report` runs in
  *prebuilt* mode on the exact rows the screen renders. PDF/CSV/XLSX cannot disagree
  with the screen on these two statements.
- **[VF]** RLS on `accounts`, `journal_entries`, `journal_entry_lines` is business- AND
  branch-scoped and requires the `financials:read` module permission.
- **[VF]** `finance_can_read_scope` is correctly strict: business-scoped calls require
  `user_can_access_business`; an unscoped (org-wide) call is allowed only when the caller
  can access EVERY active business in the org. Live catalog confirmed (not just migration text).
- **[VF]** Live data is one organization, one business, one branch, 13 journal entries,
  all inside a single fiscal year (FY start month NULL → calendar year).

## 2. Invalidated assumptions

- **[VF]** "The PDF may use a different query." False — prebuilt mode, same rows.
- **[VF]** "The balance-sheet imbalance is silently swallowed." False — `validationWarnings`
  IS rendered (`FinancialReports.tsx:661`) plus a dedicated balance-check card (line 695).
- **[VF]** "Closed fiscal years are folded into retained earnings on the Balance Sheet path."
  False — the fold exists in SQL but is bypassed by `dateFrom = 1970-01-01` (see B1).
- **[VF]** "Parent + child are both summed into totals." False.
- **[VF]** "Reversed entries inflate the ledger." False — counter-entry model.
- **[VF]** "Sub-type buckets on the P&L may drop accounts." False — the sub-type union is
  closed (6 P&L buckets) and the page renders all six.
- **[VF]** "Classification is inferred from account names." False.
- **[VF]** "Two reports is too few." Not established either way — see §3.

## 3. Accounting principles established

- **[AP]** P&L = flow over a period; Balance Sheet = stock at an instant. Different date
  semantics are correct, not a bug.
- **[AP]** Assets = Liabilities + Equity must hold at every as-of date, where equity
  includes *all* accumulated prior-period results plus the current period's result.
- **[AP]** Under a calculated-retained-earnings model (no closing journals), the statement
  must synthesise BOTH current-year earnings AND accumulated prior-years' result.
- **[RC]** IAS 1 requires a complete set: financial position, profit or loss & OCI,
  changes in equity, cash flows, notes. This ERP already ships Cash Flow and Trial Balance
  under other categories, so the gap versus IAS 1 is **Statement of Changes in Equity**
  and a comparative column on the Balance Sheet — not "more reports" generally.
- **[AP]** A branch is a management dimension, not a legal entity; a branch Balance Sheet
  is not a complete statement of financial position. Scoping the P&L by branch while
  keeping the Balance Sheet entity-wide is defensible — but must be disclosed.

## 4. Current architecture

```text
journal_entries / journal_entry_lines  (posted + reversed only)
  → get_account_movements(org, from, to, business, branch)      period Dr/Cr
  → get_ledger_opening_balances(org, business, as_of, branch)   opening, FY-aware
  → get_equity_result(org, business, as_of, branch)             CY / PY result, RE account
      → useFinancialReport  (hierarchy, sub-typing, section totals)
          → FinancialReports.tsx  (statement grammar, rows)
              → screen  AND  render-report prebuilt → PDF / CSV / XLSX
```

## 5. Findings — Profit & Loss

| # | Finding | Class | Sev |
|---|---|---|---|
| P1 | Structure is genuinely professional: revenue → COGS → **gross profit** → opex → **operating profit** → other income/expense → **profit before tax** → tax → **net profit**, with correct statement-line grammar (one grand total). | Correct | — |
| P2 | Period-only movement, posted+reversed, business-scoped, drill-down reconciles. | Correct | — |
| P3 | Net income on screen is recomputed from sub-type buckets (`FinancialReports.tsx:261-270`) while the hook also computes `netIncome` from section totals (`useFinancialReport.ts:470-473`). Two paths that agree today only because the bucket set is closed. No test pins them. | Correct but fragile | Med |
| P4 | Accounts are fetched with `is_active = true` (`useFinancialReport.ts:161`). A deactivated account still carrying ledger movement silently vanishes from the statement. No such account exists today (**[VF]**), so this is latent. | Incorrect (latent) | High |
| P5 | Branch filter is honoured on P&L but branch authorization is not re-checked — see S2. | Incorrect | High |

## 6. Findings — Balance Sheet

| # | Finding | Class | Sev |
|---|---|---|---|
| **B1** | **Prior years' result is dropped from equity.** Root cause is a two-part interaction, both halves re-verified: (a) `useFinancialReport.ts:506` builds `totalEquity = sectionTotals.equity + currentYearEarnings` and never adds `priorYearsResult`, even though it reads and stores it (lines 501, 509); (b) the code comment at `FinancialReports.tsx:417-420` and `useFinancialReport.ts:481-487` justifies (a) by asserting that closed years are already folded into the retained-earnings account's opening balance by `get_ledger_opening_balances` — **but that fold never happens on this path**, because `fetchOpeningBalancesRPC` is called with `params.dateFrom` (line 308) and the Balance Sheet pins `dateFrom = 1970-01-01`, so the RPC derives its fiscal-year boundary from 1970 and returns ~0 for every account. All Balance Sheet value therefore comes from cumulative movement over `[1970-01-01, dateTo]`, which carries equity *accounts* correctly but leaves every prior fiscal year's nominal result nowhere, since income/expense accounts are not fetched for the Balance Sheet. Consequence: for any as-of date in a fiscal year after one with P&L activity, and with no closing journals, equity is understated and **the statement does not balance**. Arithmetic proof on live data: as of 2027-06-30, assets 95 840.00 vs liabilities + equity 95 390.00 — a 450.00 gap, exactly the earlier year's profit. Masked today only because the live business is still inside its first fiscal year. The load-bearing comment is actively misleading and must be corrected with the fix. | **Incorrect** | **Critical** |
| B2 | The imbalance IS surfaced. `validateBalanceSheet` pushes an equation-error warning (`ReportCalculationEngine.ts:245-251`), the hook returns it, and `FinancialReports.tsx:661-677` renders it in a destructive card, with a second balance-check card at line 695. So B1 degrades loudly, not silently. Residual defect: the warning names the discrepancy but not its cause, and `netAmount` (`useFinancialReport.ts:513`) recomputes the same equation a second time from the same inputs — one derivation should own it. | Correct but incomplete | Low |

| B3 | The missing-retained-earnings-account guard row (`FinancialReports.tsx:431-444`) fires only when NO retained-earnings account resolves. A retained-earnings account DOES resolve here (**[VF]**: one `detail_type = 'retained_earnings'` account plus a `default_account_settings` row), so the guard is silent in exactly the scenario where B1 loses money. | Incorrect | High |
| B4 | Comparison period is fetched for the BS (two extra RPC round trips per run) but `bsColumns` has only `name` + `balance`, so it is discarded. Selecting a comparison mode silently does nothing on the Balance Sheet — and IAS 1 expects a comparative. | Correct but incomplete | Med |
| B5 | The page renders a branch filter; the P&L honours it, the BS hard-codes `branchId: null` (`FinancialReports.tsx:203`). Defensible (§3) but undisclosed — the exported masthead scope label can name a branch on an entity-wide statement. | Correct but incomplete | Med |
| B6 | `requiresConsolidation` is set by the hook for a multi-business org with no business selected, and is **never read** by `FinancialReports.tsx` → a blank/zero statement with no message. | Incorrect | High |
| B7 | `Opening Balance Equity` (code 3900, `detail_type = 'opening_balance_equity'`) classifies to **Reserves**. Presentationally misleading. | Correct but incomplete | Low |
| B8 | Liability section currently shows a net **debit** balance (`2012 Accrued Expenses` debited 5 250 with no credit → total liabilities −5 010). Data/posting anomaly, but the statement has no presentation rule for a wrong-sided control account. | Unverified (data) | Med |
| B9 | `BalanceSheetIntegrityCheck.ts` is dead code — exported, never imported; its doc block describes a historical bug and asserts "FIXED", which is misleading documentation. | Correct but incomplete | Low |

## 7. Ledger / Trial Balance reconciliation

- **[VF]** All three (Trial Balance, General Ledger, Financial Statements) read the same
  RPCs with the same status filter and the same scope predicates. No sign inversion,
  duplicate aggregation or period-filter divergence found.
- **[VF]** Opening window is `_as_of − 1`, period window is `[from, to]` — no overlap, no
  double count at the boundary.
- **[UNV]** No automated cross-report reconciliation test exists. Agreement today is
  structural, not enforced.

## 8. Period / retained-earnings semantics

- **[VF]** Model = **calculated retained earnings**: nominal accounts reset at the fiscal
  year boundary inside `get_ledger_opening_balances`, and prior years' nominal result is
  folded into the retained-earnings account so the opening trial balance still balances.
  Real closing journals, if present, net to zero and cannot double count. This model is
  sound; the **consumption of it on the Balance Sheet is not** (B1).
- **[VF]** Fiscal year start comes from `businesses.fiscal_year_start` (month), defaulting
  to January, with an out-of-range guard.
- **[UNV]** Fiscal-year-boundary, backdated-posting and year-change behaviour is untested.
  Period locks are enforced at *posting* time (ADR 0123), not in reporting — correct.

## 9. FX

- **[VF]** `journal_entry_lines` stores base-currency `debit`/`credit` alongside
  `original_currency` / `original_debit` / `original_credit` / `exchange_rate`. Reports read
  base amounts only. No client-side FX arithmetic anywhere in this path — correct.
- **[VF]** Supported model = **business base currency only**. There is no reporting-currency
  translation and no missing-rate handling in the statements. Presentation currency comes
  from `useCurrency().baseCurrency`, while `ReportContext` resolves
  `currentBusiness.base_currency`. **[INF]** These can diverge and mislabel a statement.
- Scope boundary: do not build FX translation here. Document the dependency.

## 10. Multi-business / branch security

| # | Finding | Class | Sev |
|---|---|---|---|
| S1 | Cross-**business** isolation is sound. RLS on all three tables requires `user_can_access_business` + `financials:read`; the RPCs re-verify via `finance_can_read_scope`, including the "can reach every active business" rule for unscoped runs, plus referential checks that a passed business/branch really belongs to the org. Business A cannot receive Business B's figures. | Correct | — |
| **S2** | **Branch authorization gap.** The RPCs are `SECURITY DEFINER` (RLS bypassed) and validate `_branch_id` only for *ownership* (branch belongs to org/business) — never `user_can_access_branch`, which the RLS policies DO require. A user confined to one branch can request another branch's `_branch_id` and receive its P&L movements and opening balances. | **Incorrect** | **High** |
| S3 | The RPCs do not check the `financials:read` module permission that RLS enforces, so a user with business access but no financials read can obtain aggregate movement totals. | Incorrect | Med |
| S4 | Export/PDF inherits the screen rows, so no separate export-side leak. | Correct | — |

## 11. Export / PDF

- **[VF]** Prebuilt mode ⇒ byte parity of data between screen and export.
- **[VF]** `supabase/functions/_shared/reportDataEngine.ts` contains an *independent*
  server-side balance-sheet/P&L builder used by scheduled reports and direct
  `render-report` server-build calls. It shares the same RPCs and the same B1 defect
  (line 427 also omits prior years' result) but differs in presentation (synthetic
  "Current Year Earnings" row placed inside the retained-earnings sub-section). So a
  scheduled PDF and the interactive PDF are not the same document.

## 12. Critical invariants to enforce

1. Assets = Liabilities + Equity at every as-of date, where equity = equity account
   balances + prior-years' result + current-year result.
2. Sum of P&L account amounts = `netIncome` = the equity current-year-earnings figure.
3. Every account with ledger movement or an opening balance appears in exactly one
   statement section, active or not.
4. No account amount is counted twice (own + rolled-up).
5. Reversed original + its reversal net to zero.
6. Screen totals = export totals = scheduled-report totals.
7. A caller receives data only for businesses AND branches they may access.
8. When a statement cannot be trusted (imbalance, missing RE account, unscoped
   multi-business), the surface says so instead of rendering numbers.

## 13. Dependency-ordered execution phases

**Phase 1 — Balance Sheet equity correctness (blocks everything else).**
Add `priorYearsResult` into `totalEquity` and present it as its own equity line
("Retained earnings — prior years") in `useFinancialReport.ts` and, identically, in
`reportDataEngine.ts`. Keep `get_equity_result` as the single authority; no new SQL math.

**Phase 2 — Surface the trust signals.**
Render `validationWarnings`, `requiresConsolidation` and the missing-retained-earnings
condition in `FinancialReports.tsx`. An out-of-balance statement must be visibly flagged.

**Phase 3 — Close the security gaps.**
Add `user_can_access_branch` and the `financials:read` module check to
`get_account_movements`, `get_ledger_opening_balances`, `get_equity_result`
(and, for consistency, `get_general_ledger` / `get_journal_report`), via migration.

**Phase 4 — Completeness of scope.**
Drop the `is_active` filter in favour of "active OR carries a balance/movement".
Disclose the branch semantics: label the P&L with its branch scope and the Balance Sheet
as entity-wide.

**Phase 5 — Comparatives.**
Add the comparative column to the Balance Sheet (with comparison-date equity resolved via
`get_equity_result`), or remove the wasted comparison fetch.

**Phase 6 — Presentation & hygiene.**
`opening_balance_equity` → its own equity caption; wrong-sided control-account
presentation rule; single net-income derivation (retire the duplicate); delete
`BalanceSheetIntegrityCheck.ts` or wire it in.

**Phase 7 — Statement of Changes in Equity** (only after 1-3 land, and only if wanted).

Each phase is completed and tested before the next. No accounting logic moves into the
browser; no second reporting engine; no weakening of isolation.

## 14. Tests required

- Balance equation across: first fiscal year, second fiscal year with prior profit,
  year-end boundary dates (FY start, FY end, FY start + 1 day), after a reversal,
  with and without explicit closing journals.
- P&L: period-bounded movement, no opening leakage, sub-type totals = net income,
  parent/child no double count, zero-activity accounts.
- Cross-report: Trial Balance = GL = statements for representative accounts.
- Security (pgTAP / integration): Business A user requesting Business B → 42501;
  branch-confined user requesting a sibling branch → denied; user without
  `financials:read` → denied.
- Parity: screen rows vs `render-report` prebuilt vs `reportDataEngine` server build.

## 15. Scope boundaries

In scope: the two statements, their SQL consumption, the three RPCs' authorization,
their presentation and their exports.
Out of scope: FX architecture, the posting engine (ADR 0123), consolidation, Cash Flow,
Trial Balance internals, any new reporting engine, any client-side accounting math.

## 16. Execution status

### Phase 0 — verification of prior work (done this session)

The predecessor's log claimed investigation only, no implementation. Verified — and two
of its findings were wrong, so they are corrected above rather than inherited:

| Prior claim | Verdict | Evidence |
|---|---|---|
| Nothing implemented; no remediation code landed | **Confirmed** | `priorYearsResult` still absent from `totalEquity`; `is_active` filter still at `useFinancialReport.ts:161`; BS still `branchId: null` at `FinancialReports.tsx:203`; no branch check in the three RPCs; `BalanceSheetIntegrityCheck.ts` still unimported |
| B1 — prior years' result dropped, BS can't balance | **Confirmed and sharpened** | Root cause is the `dateFrom = 1970-01-01` / `fetchOpeningBalancesRPC(params.dateFrom)` interaction, not the omission alone — see B1 |
| B2 — imbalance detected but discarded | **Wrong** | Warnings are rendered at `FinancialReports.tsx:661-677`; downgraded to Low |
| B3 — missing-RE guard never fires when an RE account exists | **Confirmed** | Guard requires `!hasRetainedEarningsAccount` (line 433) |
| B6 — `requiresConsolidation` never read | **Confirmed** | Set at `useFinancialReport.ts:286`; zero consumers in `FinancialReports.tsx` |
| Export parity via prebuilt mode | **Confirmed** | `getPnlExportConfig` / `getBsExportConfig` omit `dateFrom`/`dateTo` (lines 470-492) |
| S2 — branch authorization gap in the reporting RPCs | **Confirmed** | Live catalog bodies check branch *ownership* only; RLS on the same tables requires `user_can_access_branch` |

No regressions or partial patches to unwind. The genuine resume point is Phase 1.

### Next

Awaiting approval to implement Phase 1 (Balance Sheet equity correctness), which must
land together with a correction to the misleading retained-earnings comments that
currently justify the defect.

