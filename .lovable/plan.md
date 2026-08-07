# Reporting Surface — Authoritative Project Status

Scope: the on-screen reporting layer (payroll, HR, finance) and its export/audit parity.
This file is the single source of truth for where this workstream stands.

## Currently active phase

**None — the reporting roadmap (Phases 1–9) is complete.** The next agent verifies, then
picks up the deferred item in "Deliberately not done" or the next roadmap in the archive.

## Completed and verified

| Phase | What | Verification |
| --- | --- | --- |
| 1 | Finance pages pass `reportType` in ExportConfig | `reports-registry-key-coverage.test.ts` |
| 2 | HR reports untruncated; screen == export | no `.slice(` in `HRReports.tsx` |
| 3 | One accounting kernel (`_shared/reports/accountingKernel.ts`), sole owner of classification | `accounting-kernel-parity.test.ts` |
| 3c | Server snapshot over `buildBalanceSheet` / `buildIncomeStatement`, incl. 3200+ equity and 8000–8999 other income/expense bands, plus an assets = liabilities + equity assertion on a balanced fixture ledger | `src/test/architecture/report-statement-snapshot.test.ts` |
| 4 | Module report-screen guards (10 screens) | `module-report-screens.test.ts` |
| 6 | **The defect.** Column projection moved out of the PDF renderer into the report result. `_shared/reports/resolveColumns.ts` is the sole owner; the JSON branch, the prebuilt CSV/XLSX/PDF branch and `renderReport()` all call it. A server-built report can no longer return rows without a column layout | `src/test/architecture/report-json-column-projection.test.ts` (also asserts every server-built reportType has a `columnSpecs` entry) |
| 7 | Export parity. `ReportExportService.buildRenderPayload` is the one payload builder for PDF, CSV and XLSX; when `reportType` + org + period are present it takes SERVER-BUILD mode and deliberately omits client rows/columns, so an export carries the full dataset, not the browser's page slice | `reports-viewer-contract.test.ts` (9 tests) |
| 8 | One owner for payroll readiness. `PayrollReportContextHeader` consumes `usePayrollReportReadiness` instead of running its own approval query — banner and chips cannot disagree | header holds no local readiness query |
| 9 | Empty-state semantics. `ReportEmptyState` models `no_data` / `missing_prerequisite` / `failed` / `missing_presentation`; `ReportPageLayout` accepts a typed `emptyState`; the payroll viewer names which one applies. Rows-with-no-columns now renders a defect banner instead of silence | `src/test/architecture/report-empty-state-semantics.test.ts` |
| 5 | Uniform report-run auditability. `_shared/reports/logReportRun.ts` writes `report_run_log` for screen (JSON), server-build CSV/XLSX and prebuilt CSV/XLSX renditions, alongside the PDF logging that already existed in `renderReport.ts`. Every rendition of a report is now attributable to an actor, org, business, period and row count | `render-report` deployed; `run_hash` derived (column is NOT NULL) |

Frontend typecheck clean; all reporting guards green.

## Deliberately not done (decisions, not omissions)

- **`payroll_report_runs` was NOT folded into `report_run_log`.** The plan offered "fold or make a
  view"; neither is correct. They answer different questions: `report_run_log` is the org-wide
  security/audit trail written server-side by the renderer, while `payroll_report_runs` is a
  payroll-facing *history* carrying pack code, pack version, template version, report label, owner
  kind and duration, and it powers `PayrollReportHistoryStrip`. Collapsing them would either lose
  those columns or pollute the audit table with presentation metadata. Turning it into a view would
  break its client insert path. They stay separate and complementary.
- **HR's question-driven library** (`HrReportsRoutes.tsx`) is entirely `WorkspaceComingSoon` stubs —
  classification **F**. A product gap. Reports will not be fabricated to fill navigation.
- **Warehouse/WMS has no reporting surface at all** — also **F**.
- **The document printing architecture and the PDF renderer** are healthy and were not touched.

## Known residual risk

- The payroll viewer could not be verified visually this round: the sandbox browser session is
  signed out (`/hr/payroll/reports/employer_contributions` redirects to the sign-in screen), so the
  Phase 6/9 behaviour is proven by tests and by reading the response shape, not by a screenshot.
- The repository-wide vitest run times out under sandbox load with ~160 pre-existing failing files
  unrelated to reporting (WMS topic vocabulary, etc.). Not caused by this workstream, not fixed here.

## Instructions for the next agent

1. **Verify before building.** Confirm, against the code and not against this file:
   - `resolveReportColumns` is called on *every* exit path of `supabase/functions/render-report/index.ts`
     that returns tabular data (JSON, server-build CSV/XLSX, prebuilt CSV/XLSX, PDF). One un-resolved
     path re-opens the original defect.
   - `logReportRun` is called on every one of those same paths, and the `report_run_log` rows it writes
     are real — query the table after exercising a report, don't trust the code read.
   - `buildRenderPayload`'s server-build branch still omits `rows` and `columns`.
   - Sign in through the Lovable preview first, then load a payroll report and confirm the grid has
     headers, so Phase 6/9 gets the visual confirmation this round could not obtain.
2. **Then resume at the next logical milestone**, not at unrelated work. In order of value:
   - Extend the Phase 9 typed empty states beyond the payroll viewer to the finance report pages that
     still pass a bare `emptyMessage` string (`AgingReport`, `AuditTrail`, `BudgetReport`,
     `CashFlowReport`, `DepreciationReport`, `BankReconciliationReport`, `AccountRegister`). The
     component and the layout prop already exist; this is adoption, not new architecture.
   - Then surface `report_run_log` to administrators — there is now a complete audit trail with no
     reader. That is the only piece of this workstream currently without a UI.
3. Do not start a new subsystem audit while either of the above is outstanding.
