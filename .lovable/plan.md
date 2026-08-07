# Reporting Surface Audit — Verification Verdict and Completion Plan

## Part 1 — Verification of the previous engineer's claims

Every claim in the inherited plan was checked directly against the code.

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Phase 1 — finance pages pass `reportType` in ExportConfig | **True** | `CashFlowReport.tsx:126`, `GeneralLedger.tsx:205`, `PartnerLedger.tsx:372`, `JournalReport.tsx:174`, `BudgetReport.tsx:177`, `DepreciationReport.tsx:194`, `AuditTrail.tsx:194`; guard `reports-registry-key-coverage.test.ts` |
| Phase 2 — HR reports untruncated, screen == export | **True** | no `.slice(` remains in `src/pages/hr/HRReports.tsx` outside a comment |
| Phase 4 — module report-screen guards | **True** | `module-report-screens.test.ts` guards 10 module-native screens |
| Phase 3 — single accounting kernel | **True (code), unverified (data)** | `accountingKernel.ts` is dependency-free and sole owner; `reportDataEngine.ts:14-23` and `AccountClassification.ts:26-33` bind to it, no re-declarations; `accounting-kernel-parity.test.ts` asserts full-space agreement |
| Phase 3 pending — server snapshot over `buildBalanceSheet`/`buildIncomeStatement` | **Genuinely not done** | neither function is referenced by any test |
| Phase 5 — report-run auditability | **Partly exists already** | `report_run_log` is real and written by `renderReport.ts:177-186`, so every PDF path logs; client CSV/XLSX and screen renders do not |

Verdict: the inherited work is real and sound. Nothing needs undoing. The plan's own framing, however, missed the defect the parent prompt actually asks about.

## Part 2 — The real defect (found, root-caused, not previously identified)

Branch Payroll Cost is **not** a UI defect, not a data defect, and not a payroll defect. It is one
missing step in the shared server report entrypoint.

```text
parameters -> buildPayrollReport -> { data, summary }
                                        |
        PDF path  -> renderReport() -> columns = getReportSpec(reportType).columns  -> correct PDF
        JSON path -> spread verbatim -> NO columns resolved                         -> blank screen
```

- `render-report/index.ts:467-476` returns `{ reportType, dateRange, ...result }` for `format === "json"`.
  It never consults the column registry.
- No builder in `_shared/reports/payrollData.ts` returns a `columns` key (all nine cases return
  `{ data, summary }`). The same is true of the attendance, project and finance builders.
- The registry **does** have the right columns: `columnSpecs.ts:436-444` defines branch, headcount,
  gross, employer cost, total cost for `branch_payroll_cost`.
- `PayrollReportViewer.tsx:187` falls back to `columns = []`; `TablePreview` then renders zero headers
  and, for the one real row, zero cells. `PayrollReportKpiBand.tsx:103` still counts `rows.length`,
  hence "Rows: 1" over an empty grid.

So the report is computed correctly, is identical for screen and PDF at the row level, and is lost
only in the JSON projection. Classification: **B — presentation drift**, systemic across every
server-build JSON report, not D and not E.

Two knock-on findings:
- **CSV/XLSX are worse than the PDF.** The viewer builds its export config from the client `columns`
  state (`PayrollReportViewer.tsx:192-233`) and sends it through render-report's PREBUILT mode, which
  does not re-resolve `columnSpecs`. PDF preview was previously patched to take the server-build path;
  CSV/XLSX still inherit the empty column list. Screen, PDF, CSV and XLSX are therefore **not** at parity.
- **The two payroll states are not contradictory.** `"No approved payroll run in this period"`
  (`PayrollReportContextHeader.tsx:80`) and `"Payroll approved"` (`usePayrollReportReadiness.ts:24`,
  backed by the `payroll_report_readiness` RPC) run the same predicate — org, optional business,
  `approved_at IS NOT NULL`, period overlap — from two independently cached call sites. The logic
  agrees; only the caching can disagree transiently. Fix is de-duplication, not reconciliation.

## Part 3 — Remaining plan

### Phase 3c — close the accounting kernel (small, first)
Add a server snapshot test over `buildBalanceSheet` and `buildIncomeStatement` with a fixed account
fixture that deliberately includes 3200+ equity codes and 8000-8999 other income/expense codes, so
the kernel's classification change is pinned as a diff. This closes Phase 3 without needing live data.

### Phase 6 — resolve columns once, in the report result (the fix)
Make the column projection part of the **report result**, not of the PDF renderer.

1. In `render-report/index.ts`, resolve `columns` from `getReportSpec(reportType)` for the JSON branch,
   preferring any `columns` a builder explicitly returns. One place, all report families.
2. Pass the same resolved columns into `renderReport()` so PDF and JSON provably share one projection
   rather than each resolving independently.
3. Architecture guard: for every `reportType` handled by a server builder, the JSON response must carry
   a non-empty `columns` array whose codes exist in `columnSpecs.ts` — fails on any future builder added
   without a spec.

No UI markup is invented: the viewer already has a real table renderer for every `preview_kind`.

### Phase 7 — export parity for the payroll viewer
Route the viewer's CSV/XLSX through the same server-build path the PDF preview already uses, so all four
representations derive from one server result. Guard extends
`src/test/payroll/reports-viewer-contract.test.ts` to cover CSV/XLSX, not just PDF.

### Phase 8 — one owner for payroll report readiness
Delete the ad hoc query in `PayrollReportContextHeader.tsx:44-63` and read the
`payroll_report_readiness` RPC through `usePayrollReportReadiness` with a shared query key, so the
context header and the readiness band cannot disagree even transiently.

### Phase 9 — empty-state semantics
Distinguish, in the viewer, the states the parent prompt lists: no data, missing prerequisite
(no approved run), failed computation, and missing presentation (rows present, columns absent). The last
one currently renders as silence and is what hid this bug; after Phase 6 it becomes an assertion failure
rather than a blank grid.

### Phase 5 — uniform report-run auditability (unchanged, last)
`report_run_log` already covers server PDF paths. Extend it to JSON/screen renders and to client CSV/XLSX
via the canonical export service, with the same shape: org, business, report type, period, filters, row
count, format, duration, actor. Fold `payroll_report_runs` into it or make it a view.

### Out of scope, deliberately
- HR's question-driven library (`HrReportsRoutes.tsx`) is entirely `WorkspaceComingSoon` stubs —
  classification **F**. It is a product gap; reports will not be fabricated to fill navigation.
- Warehouse/WMS has no reporting surface at all — also **F**.
- The document printing architecture and the PDF renderer are healthy and will not be touched.

## Technical notes
- Single edit point for Phase 6 is the `format === "json"` branch in
  `supabase/functions/render-report/index.ts`, plus a shared `resolveColumns(reportType, result)` helper
  next to `columnSpecs.ts` used by both branches.
- No client-side calculation is added; no second reporting engine is introduced; `ReportCalculationEngine`
  stays as browser-side tree shaping only, as the previous engineer correctly decided.
