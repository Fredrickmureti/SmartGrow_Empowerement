# Cash & Banking Reporting — Verification + Continuation (2026-08-21)

Legend: **[FACT]** re-verified this session · **[FINDING]** new defect found this session ·
**[TASK]** work to do · **[TEST]** test requirement · **[OPEN]** unresolved policy

## Phase 1 — Independent verification of the previous engineer's claims

| Claim | Verdict |
| --- | --- |
| Security gate on GL/report RPCs, definer + pinned search_path, no `anon` EXECUTE | **[FACT] TRUE.** `pg_proc` shows `prosecdef=true`, `search_path=public`, ACL `postgres/authenticated/service_role` only — no PUBLIC, no `anon` — for `finance_can_read_org`, `finance_cash_flow_statement`, `finance_bank_reconciliation_statement`, `get_general_ledger`, `get_account_movements`, `get_account_balances`, `get_account_balance_at_date`, `get_gl_transactions`, `check_balance_integrity`, `get_control_account_reconciliation`. |
| `finance_bank_reconciliation_statement` exists with the stated signature | **[FACT] TRUE** (`_org_id, _bank_account_id, _as_of, _business_id, _branch_id`). |
| Client seam is the only caller; report page does no accounting arithmetic | **[FACT] TRUE.** Only `src/services/finance/bankReconciliationStatement.ts` calls the RPC; the page renders the payload and computes only row counts. |
| Guard tests green | **[FACT] TRUE.** 22 tests pass across `bank-reconciliation-single-engine`, `cash-flow-single-engine`, `reporting-isolation-matrix`. |
| Registry entry moved to `cash_bank`, nav group "Cash & banking" | **[FACT] TRUE** (`ReportRegistry.ts` + `reportsNav.ts`). |
| Phase 2b: "the PDF/schedule path reads the one cash-flow engine" | **[FACT] PARTLY TRUE — see [FINDING] 1.** The server builder `buildCashFlow` does call `finance_cash_flow_statement`, but the Cash Flow *screen's* export never reaches it. |

### New findings

1. **[FINDING] The Cash Flow screen's PDF/CSV/XLSX is still browser rows, not the engine.**
   `ReportExportService.canServerBuild` requires `reportType && organizationId && dateFrom && dateTo`.
   `CashFlowReport.getExportConfig` supplies `reportType: "cash_flow"` and a display `dateRange`
   only — no `organizationId`, no `dateFrom`/`dateTo`. So every export silently falls into the
   prebuilt branch and re-ships the page's rendered rows. The single-engine victory holds for
   scheduled reports and direct `render-report` calls, not for the button the accountant presses.
2. **[FINDING] Server-built cash flow ignores branch scope.** `buildCashFlow(..., branchId?)` accepts
   a branch, but neither `render-report/index.ts:121` nor `process-scheduled-reports/index.ts:183`
   passes one, although `render-report` already parses `branchId` from the body. A branch-scoped
   screen and its scheduled PDF therefore state different cash flows.
3. **[FINDING] Bank Reconciliation has no server build path at all.** `render-report`'s
   `buildReportData` switch has no `bank_reconciliation` case; the registry's
   `reportType: "bank-reconciliation"` would throw `Unsupported report type`. The page exports
   prebuilt rows, so the exported proof is capped by the page's own 200-item truncation and does
   not go through the canonical column spec/masthead.
4. **[FINDING] Report-type vocabulary is inconsistent.** The registry uses kebab (`cash-flow`,
   `bank-reconciliation`); the server switch uses snake (`cash_flow`). Nothing normalizes between
   them — the Cash Flow page only works because it hardcodes the snake form in its export config.
   This is the exact trap that will make finding 3's fix silently no-op.
5. **[FACT]** The SQL isolation matrix only has the negative leg (foreign org raises) for the new
   RPC; no positive leg, and no registry test pinning `cash_bank` membership.

### Live-data item carried forward (not an engine defect)

**[FACT]** Org "Joshua Holdings" / "Test Operating Bank – KES" shows a −50,000.00 KES unexplained
difference: the opening balance is posted twice (via `bank_accounts.opening_balance_je_id` and via a
separate entry behind the 2026-07-31 "Opening balance" statement line). Data fix for the business.

## Phase 5 — Export coherence (next, in this order)

- **[TASK] 5a.** Normalize the report-type vocabulary in one place (registry key → server builder
  key) so a registry `reportType` is always what `render-report` dispatches on. No new engine, no
  per-page hardcoding.
- **[TASK] 5b.** Make `CashFlowReport.getExportConfig` a server-build config: pass
  `organizationId`, `businessId`, `branchId`, `dateFrom`, `dateTo`. Drop the prebuilt rows so the
  prebuilt branch cannot be re-entered.
- **[TASK] 5c.** Thread `branchId` from the `render-report` body and from the schedule record into
  `buildCashFlow`.
- **[TASK] 5d.** Add a `bank_reconciliation` builder to `_shared/reportDataEngine.ts` that calls
  `finance_bank_reconciliation_statement` and renders the same proof rows the screen renders
  (no arithmetic in the builder), wire it into `render-report`'s switch, and switch the report
  page's Statement tab to a server-build export. Requires `bank_account_id` + `as_of` to travel as
  `filters` — extend the server-build contract minimally rather than adding a second export path.
- **[TEST] 5e.** Extend `cash-flow-single-engine` / `bank-reconciliation-single-engine` guards:
  (i) no Cash & Banking page may export prebuilt rows; (ii) every registry `reportType` in
  `cash_bank` must resolve to a server builder; (iii) branch must be threaded into the builder.
- **[TEST] 5f.** Registry test asserting `cash_bank` membership (cash flow, bank reconciliation).
- **[TEST] 5g.** SQL positive leg for `finance_bank_reconciliation_statement` (own org succeeds,
  foreign org raises 42501) in `supabase/tests/reporting_isolation_matrix_test.sql`.

## Phase 6 — Taxonomy: is two reports enough (investigate, then decide)

Deferred until Phase 5 lands, and to be settled by evidence, not by copying another ERP's menu.
The three candidates worth testing against the existing model:

- **Cash position / bank balances as at a date** — one line per bank & cash account, book balance,
  last reconciled date, uncleared count. Likely a *report*, since no existing screen answers
  "how much cash do we have, by account, at a date, reconciled or not".
- **Bank book / cash ledger** (opening, movements, running balance, closing per account) — likely a
  *register* reachable as drill-down from the position report, not a new financial statement.
- **Outstanding items ageing** (deposits in transit / unpresented payments by age) — most likely a
  *drill-down dimension* of the reconciliation statement, not a separate report.

Rule for this phase: a new entry is justified only if it answers an accounting question no existing
screen answers, and can be sourced from an existing engine without new accounting logic.

## Open policy

**[OPEN]** Whether cash equivalents are `cash_flow_category='cash'` only, or must also include POS /
credit-card / undeposited-funds clearing accounts. Default stands: `'cash'` only.

## Phase 0 — Blocking type error left by the previous engineer (fix first)

**[FINDING]** `src/pages/reports/BankReconciliationReport.tsx` does not typecheck. The proof rows
use `tone: "subtle"` and `tone: "total"`, which are not members of
`ReportRow["tone"]` (`default | warning | danger | success`) — those are *row kinds*, not tones.
Six TS2322 errors. The fix is to express structure through `kind` (`subsection` for the two
balance captions, `subtotal` for the two adjusted balances, `calculatedResult` for the residual)
and keep `tone` for the exception state only. This also makes the proof carry the canonical
statement vocabulary into the PDF, which Phase 5d depends on.

## Notes for execution

- ~111 pre-existing failing test files elsewhere in the repo (e.g. `wms-rpc-grants`) are unrelated;
  do not attribute them to this work and do not fix them here.
- Do not add a second reporting engine, a second FX path, or accounting arithmetic in React or in
  the edge builders. Builders render engine payloads.
