# Reporting Engine Convergence — Project Plan

Authoritative status for the system-wide reporting engine audit and convergence.

## Status summary

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Finance registry-key coverage | Done, verified |
| 2 | HR reports: no truncation, screen == export | Done, verified |
| 4 | Architecture guards for module-native report screens | Done, verified |
| 3 | Single accounting kernel (client + server) | **Active — core done, parity verified; live-data comparison pending** |
| 5 | Uniform report-run auditability across all formats | Not started — next |

## Phase 1 — Finance registry gap (COMPLETE)

Every finance report page that has a server `columnSpecs.ts` entry now passes the
matching `reportType` in its `ExportConfig`, so exports go through the registry
instead of the "prebuilt" inference fallback.

Changed: `CashFlowReport`, `GeneralLedger`, `PartnerLedger`, `JournalReport`,
`BudgetReport`, `DepreciationReport`, `AuditTrail`.
Guard: `src/test/architecture/reports-registry-key-coverage.test.ts`.

## Phase 2 — HR reports (COMPLETE)

`src/pages/hr/HRReports.tsx`: removed all `.slice(...)` row truncation (group
cards, birthdays, anniversaries — replaced with scrollable containers) and
rebuilt `exportConfig` from the full datasets rather than a hand-written 5-row
summary. Screen and export are now the same data.

## Phase 4 — Architecture guards (COMPLETE)

`src/test/architecture/module-report-screens.test.ts` extends the guards beyond
`src/pages/reports/`: module-native report screens must use
`ReportExportService` (no hand-rolled CSV/XLSX writers) and may not truncate
rows inside export config blocks. Fixed the defect it found:
`src/pages/Reports.tsx` exported only the first 10 expense categories.

## Phase 3 — Single accounting kernel (ACTIVE)

Original plan was to delete the client engine outright. That was downgraded:
deleting browser-side tree-shaping costs a round trip on every filter change
for no correctness gain. The real defect was **two copies of the accounting
rules that had already drifted** (equity `>= 3200` server vs `3200..3999`
client; the 8000-8999 other-income/other-expense band missing server side).

Done:
- `supabase/functions/_shared/reports/accountingKernel.ts` — dependency-free
  single definition of `isDebitNormal`, `calculateBalance`,
  `extractCodeNumber`, `classifyByCodeRange`, `classifyAccount`,
  `SUB_TYPE_LABELS`, `ACCOUNT_TYPE_ORDER/LABELS` and statement section
  ordering (`BS_*_ORDER`, `PNL_*_ORDER`).
- `supabase/functions/_shared/reportDataEngine.ts` binds to the kernel; its
  local primitives, labels and ordering constants are gone.
  `DETAIL_TYPE_TO_SUB_TYPE` is now exported so parity can be asserted.
- `src/services/reports/AccountClassification.ts` is a thin kernel binding that
  keeps only the browser detail-type lookup and the `ClassifiedAccount` shape.
- `src/services/reports/ReportCalculationEngine.ts` re-exports the kernel
  primitives and keeps only hierarchy building, variance and validation.
- Guard: `src/test/architecture/accounting-kernel-parity.test.ts` — no host
  re-declares a kernel primitive, the server detail-type projection matches
  `DETAIL_TYPE_CLASSIFICATION` exactly, and client/server classification agree
  across the whole code-range space and every known detail type. 7/7 green.
- `tsgo --noEmit` clean.

Pending for Phase 3 to be closed:
1. Live-data comparison on a real org/business and period: Trial Balance,
   P&L and Balance Sheet on screen vs the `render-report` PDF, figure for
   figure. The kernel change alters equity and other-income/expense placement
   for charts of accounts using 3200+ and 8000+ codes, so this must be seen,
   not assumed.
2. A server snapshot test over `buildBalanceSheet` / `buildIncomeStatement`
   with a fixed account fixture, so future kernel edits show up as a diff.

## Phase 5 — Report-run auditability (NEXT)

Not started. Target: every report render, in every format (screen, PDF, XLSX,
CSV) writes a uniform row to `report_run_log` — org, business, report type,
period, filters, row count, format, duration, actor. Today only part of the
finance PDF path logs, and `payroll_report_runs` is a separate shape.

## Instructions for the next agent

1. **Verify before continuing.** Run `tsgo --noEmit` and
   `bunx vitest run src/test/architecture`. Two failures are pre-existing and
   unrelated to reporting — `wms-realtime-publication-sync` and
   `bank-export-template-metadata`; everything reporting-related must be green.
   Then read `accountingKernel.ts` against `reportDataEngine.ts` and
   `AccountClassification.ts` and confirm neither host has grown a private copy
   of any accounting rule.
2. **Close Phase 3** by doing the two pending items above, in order. Do not
   start Phase 5 with Phase 3 half-verified.
3. **Then Phase 5**, as scoped above. Keep execution chronological; do not open
   unrelated areas of the system.
