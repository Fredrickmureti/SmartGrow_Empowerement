# Financial Statements — Controlled Wave Plan

Authoritative status. Prepared 2026-08-22 after a fresh verification pass.

## Verified baseline

- `bunx tsgo --noEmit -p tsconfig.app.json` is clean.
- The five reporting architecture suites named in the handover pass (18 tests).
- The wider reporting guard suite has 68 passing tests and 5 stale or contract-mismatch failures in `financial-reports-scope-labeling.test.ts`.
- Live database inspection confirms the reporting RPCs (`get_account_movements`, `get_ledger_opening_balances`, `get_equity_result`, `get_general_ledger`, `get_journal_report`) contain the current triple gates: `finance_can_read_scope`, `finance_can_read_branch`, and `finance_can_read_financials`.
- The Phase B fiscal-year anchoring, Phase C branch-scope gate, Phase D row footing, and Phase E inactive-account claims are true against the current code.

## Defects this wave will close

1. **Export branch scope can disagree with the statement being viewed.** Report queries use `ReportFilterContext`, but `ReportPageLayout` / `ReportContext.enrichExportConfig` fall back to the global navigation branch and `??` destroys an explicit `null` ("All branches").
2. **SERVER-BUILD P&L and Balance Sheet emit numeric keys the export registry does not read.** The engine emits P&L `balance` where the registry reads `amount`, and emits Balance Sheet `closing_balance` where the registry reads `balance`. Scheduled/server-built statements can therefore render blank amount columns.
3. **Comparatives are incomplete.** The screen computes comparative account rows, but subtotal and calculated-result rows do not foot in the comparative and variance columns; SERVER-BUILD has no comparative path; the Balance Sheet silently fetches an epoch-to-date comparison that is never displayed.
4. **The PDF cache key can collide.** It hashes only row/column counts plus the first and last row, so a middle-row balance change can reuse a stale PDF within the five-minute TTL.
5. **Schedule persistence is organization-scoped instead of business-scoped.** `scheduled_reports` and `report_generation_logs` carry `business_id`, but their RLS policies only test organization membership, allowing cross-business visibility or mutation inside one organization.
6. **Branch-scope guards are inconsistent.** Partner Ledger, Journal Report, and Budget vs Actual tests pin stale source patterns; Cash Flow still sends a branch although the registry says it is entity-only; Audit Trail claims branch-sliceability without branch data in its unified view.

## Work plan

### 1. Make export scope match the report screen

- Preserve an explicit `branchId: null` in `ReportContext.enrichExportConfig` by testing property presence instead of using nullish fallback.
- Pass the report's active branch into the P&L export config and an explicit `null` into the Balance Sheet export config.
- Add an optional `reportKind` prop to `ReportPageLayout`; render `ReportBranchFilter` with that kind. Financial Reports will pass the active statement kind and stop rendering a second, duplicate branch control.
- Remove the Cash Flow page's branch parameter from data and export paths, matching the entity-only registry rule.
- Mark Audit Trail entity-only until every source in `v_unified_audit` exposes a trustworthy `branch_id`; a partial branch filter would silently omit branchless audit events.

### 2. Repair the server statement/export contract before extending it

- Align `buildIncomeStatement` rows with the registry's P&L `amount` key.
- Align `buildBalanceSheet` rows with the registry's Balance Sheet `balance` key.
- Emit canonical statement `_kind` values from these builders while retaining legacy flags only where the current renderer still needs them.
- Extend the export coherence/architecture tests so every numeric key produced by these builders is consumed by the selected columns and no report-specific column is left blank by construction.

### 3. Complete P&L comparatives across screen, PDF, CSV, XLSX, and schedules

- On screen, compute comparative amount, variance, and variance percent for subtotal and calculated-result lines as well as account detail lines, so every visible comparative statement foots in every numeric column.
- Remove the hidden Balance Sheet comparison fetch until a fiscal-anchored Balance Sheet comparative presentation is intentionally built.
- Add one shared comparative-period resolver for previous period and previous year; mirror it byte-identically between `src` and `supabase/functions/_shared`, with a parity guard.
- Add an optional comparison mode to `buildIncomeStatement`, `render-report`, and `process-scheduled-reports`. Comparative builders will supply their own column list; the existing registry remains the default for non-comparative statements.
- Add an optional comparison selector to the P&L scheduling UI and persist it in `filters.comparisonMode`; existing schedules keep `comparison_mode: "none"` behaviour.
- Keep direct screen exports PREBUILT, but include the comparison mode and a deterministic full-row hash in the export fingerprint so screen exports cannot collide with a different mode or changed middle rows.

### 4. Tighten schedule persistence to business scope

Create one migration that:

- Rewrites `scheduled_reports` member policies so users can only view, create, change, or remove schedules whose `business_id` belongs to a business they may access.
- Rewrites `report_generation_logs` member policies with the same business boundary.
- Leaves service-role execution untouched so `process-scheduled-reports` continues to run.
- Backfills no rows; existing `business_id` values are already present and authoritative.

### 5. Bring branch-scope tests and SQL isolation tests back to green

- Update the stale Partner Ledger, Journal Report, and Budget vs Actual guards to assert the current RPC/budget-scope contract rather than old source patterns.
- Assert Cash Flow is entity-only end-to-end and Audit Trail is entity-only until its view gains branch identity.
- Refresh `reporting_isolation_matrix_test.sql` from the retired `finance_can_read_org` assumption to the current triple-gate names.
- Add SQL coverage for the branch-aware RPC variants: denied sibling branch, denied non-member business, and allowed all-branches scope.

## Verification

- `bunx tsgo --noEmit -p tsconfig.app.json`
- `bunx vitest run src/test/architecture/report-statement-snapshot.test.ts src/test/architecture/statement-row-footing.test.ts src/test/architecture/statement-inactive-accounts.test.ts src/test/architecture/report-branch-scope-parity.test.ts src/test/architecture/report-format-parity.test.ts`
- `bunx vitest run src/test/architecture/report-export-coherence.test.ts src/test/architecture/financial-reports-scope-labeling.test.ts src/test/architecture/report-comparative-periods.test.ts`
- `bun test supabase/tests/sql/rendering/reporting_isolation_matrix_test.ts` if the local Supabase harness is available; otherwise keep the SQL artifact and record the same environment limitation.
- Redeploy `render-report` and `process-scheduled-reports` after `_shared` changes, and bump `v` in `src/services/reports/pdfCache.ts`.

## Deferred deliberately

- Balance Sheet comparative presentation remains out of this wave; it needs comparative fiscal-year anchoring and a deliberate presentation contract, not the current hidden epoch-range fetch.
- Phase G currency presentation follows after scope and comparatives are coherent.
- No posting-engine, FX-translation, second reporting engine, or client-side ledger aggregation changes.

## Execution order

1. Scope/export truth and server statement key repair.
2. Shared comparative periods plus screen footing.
3. SERVER-BUILD and scheduled-report comparatives.
4. Cache fingerprint hardening.
5. Business-scoped RLS migration and SQL isolation tests.
6. Full verification and handover ledger update.
