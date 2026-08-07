# Reporting Subsystem — Audit Findings and Convergence Plan

## What the audit found

I traced the reporting stack end-to-end across Finance, Payroll/HR, Sales, Purchases, Inventory, Warehouse, POS, Projects and CRM: report pages, hooks, RPCs, the `render-report` edge function, the shared PDF/CSV/XLSX builders, the report registries, run/audit tables, and the architecture tests that police them.

Headline: the reporting engine is **already largely canonical and healthy** — much healthier than the request assumes. There is one server render entry point (`render-report`), one PDF builder, one CSV builder, one XLSX builder, one on-screen table engine (`src/design-system/reports`), one client CSV writer, and ESLint rules plus architecture tests that block parallel stacks (`no-raw-xlsx-in-app`, `no-raw-pdf-lib-in-app`, csv-single-writer, report-format-parity). This should be preserved, not rebuilt.

The real defects are narrower and specific.

### Verified findings, classified

**KEEP**
- `render-report` as the single server render entry (prebuilt + server-build modes), shared `_shared/reports/renderReport.ts`, `columnSpecs.ts` registry, `reportCsv.ts` / `reportXlsx.ts` / `reportPdfGenerator.ts`.
- `src/design-system/reports` (`ReportSurface`, `ReportTable`, `format.ts`) with its screen↔PDF format-parity test.
- Payroll Reporting Centre (ADR-0062): registry-driven definitions, tenant-scoped discovery RPC, `payroll_report_runs` history, viewer route. This is the most mature reporting architecture in the codebase.
- Projects reporting (fully server-built, guarded by its own tests).
- Document/print pipeline — untouched.

**REPAIR**
1. **Finance PDFs bypass the server column registry.** Only `pnl`, `balance_sheet`, `trial_balance` set `ExportConfig.reportType`. Cash Flow, General Ledger, Partner Ledger, Journal, Budget, Depreciation and Audit Trail omit it even though matching registry keys exist, so their exports use client-shipped columns instead of the canonical format profile. This is exactly the drift the registry was built to prevent.
2. **`HRReports.tsx` is the genuine "shows N rows, not the report" surface.** Its group cards hard-cap at `.slice(0, 10)` / `.slice(0, 8)`, and its export ships a hand-written 5–7 row KPI summary — a *different, smaller* dataset than what is on screen. Neither view shows the full breakdown. (The Payroll Report Viewer itself is **not** truncating: screen and export consume the identical `render-report` result; a prior PDF-empty bug was already fixed there.)
3. **Trial Balance / P&L / Balance Sheet / Cash Flow are computed in the browser** from raw `journal_entry_lines` via `ReportCalculationEngine`, while the server has GL builders for the same reports in `reportDataEngine.ts`. Two implementations of the same financial fact — screen and PDF can legitimately disagree.

**EXTEND**
4. Engine adoption and its architecture guards stop at `src/pages/reports/` (plus Projects). Module-native report screens — `AgedPayables`, `SalespersonPerformance`, `CustomerLedger`, `Collections`, `CRMPipeline`, `POSReports` — are hand-rolled tables. They do use the central export service, so exports are safe, but their on-screen model is unguarded and can drift.
5. Report-run auditability is split: payroll has rich, reproducible `payroll_report_runs` (params, source run ids, pack/template version, row counts); everything else has best-effort `report_run_log` (report_type, params, run hash, byte count) written only on PDF renders — CSV/XLSX and on-screen views leave no reproducible record.

**RETIRE**
6. `ReportCalculationEngine` client-side financial computation, once (3) lands.
7. `CustomerLedger.tsx`'s hand-built CSV row/header assembly (bypasses `ReportExportService`).

**RECONSIDER (not in this wave)**
- Leave/talent/org HR reports are `WorkspaceComingSoon` stubs — absent, not broken.
- Warehouse/WMS has no reporting surface at all — a product gap.

**No evidence of** rogue `xlsx`/`jspdf` usage, duplicate PDF stacks, or cross-business leakage in the paths traced (RLS + org/business filters are applied server-side in the builders).

## Proposed work

Ordered by risk-adjusted value. Each phase is independently shippable and verifiable.

**Phase 1 — Close the finance registry gap (low risk, high value)**
Add the correct `reportType` registry key to `getExportConfig()` on the seven finance reports that omit it. Add an architecture test asserting every page in `src/pages/reports/` whose report has a `columnSpecs.ts` entry sets that key, so this cannot regress.

**Phase 2 — Fix `HRReports.tsx` honestly**
Remove the silent `.slice()` caps (paginate or show all), and rebuild its export config from the same arrays the page renders, so screen and export are the same dataset. No new engine — reuse `ReportSurface`/`ReportTable` and `ReportExportService`.

**Phase 3 — One computation for the core financial statements**
Move Trial Balance, P&L, Balance Sheet and Cash Flow on-screen data to the existing server builders (`render-report` with `format: "json"`), the same pattern the Payroll Viewer and Projects already use. Delete `ReportCalculationEngine` and the client-side ledger math once numbers are verified equal. Verification: same period, same business — screen figures must match today's PDF figures before deletion.

**Phase 4 — Extend the guard beyond `src/pages/reports/`**
Widen the engine-adoption architecture test to cover module-native report screens, and migrate `AgedPayables`, `SalespersonPerformance`, `CustomerLedger`, `Collections`, `POSReports`, `CRMPipeline` to `ReportPageLayout` + design-system table. Route `CustomerLedger`'s CSV through `ReportExportService`.

**Phase 5 — Uniform report-run auditability**
Write `report_run_log` on every generation path (JSON/screen, CSV, XLSX, PDF), not just PDF, and align its columns with what makes a run reproducible (report key, full params, scope, source period, row count, status, duration). Consider whether payroll's richer table becomes the shared shape rather than a second one. Any schema change ships as a documented migration with backwards compatibility.

## Technical notes

- The three "no table" finance pages (`ControlAccountReconciliation`, `InventoryGLReconciliation`, `ManagementReports`) stay exempt — they are card compositions, not tabular reports.
- Statutory returns and tax certificates keep their own generators (`generate-statutory-return`, `generate-tax-certificate`); the Reporting Centre catalogs them without duplicating them. That is correct per ADR-0062 and stays.
- `LEGACY_KPI_FORMATTERS` (11 pages still using `formatCurrency` for KPI cards) is an existing tracked ratchet; Phases 2–4 shrink it opportunistically rather than as a separate wave.
- No database changes in Phases 1–4. Phase 5 is the only phase that may need a migration, and it will be specced before it is written.
- On-screen visual polish stays out of scope, as requested.

## Suggested first step

Phases 1 and 2 together — they fix the two symptoms you named (finance export fidelity, payroll/HR "N rows instead of the report") without touching the working engine. Phase 3 is the largest correctness win and the one that needs number-for-number verification before any deletion.
