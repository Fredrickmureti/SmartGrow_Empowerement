
# Enterprise Document Platform — Continuation

## Phase 1 — Verification of prior engineer's claims (done)

Cross-checked `.lovable/plan.md` against the codebase. All landed items confirmed:

- **Rendering ownership guards**: `eslint-rules/no-raw-pdf-lib-in-app.js` + `no-direct-barcode-lib.js` present. ADRs 0084 (document-artifacts) and 0085 (barcode-and-pdf-rendering-ownership) committed.
- **Single-renderer path**: `supabase/functions/generate-document/index.ts` is the sole PDF/ESC-POS/ZPL entry, composing `_shared/pdf/*`, `_shared/printing/*`, `_shared/exports/*`.
- **Immutable artifact store**: `document_artifacts` table + `_shared/documents/persistArtifact.ts`; HR types in allowlist.
- **Milestone A — HR letters**: `ContractsListPage`, `LifecycleTimelinePage`, `Recruitment/OfferActions`, `DocumentHistorySheet` — all wired through `PrintPreviewDialog` → `generate-document`.
- **Milestone B — POS receipt renderer demotion**: `ThermalPrintRenderer.ts` / `PdfRenderer.ts` gone. `PostPaymentScreen` delegates to `printClient.*`. Architecture tests `pos-receipt-renderer-contract` + `pos-renderer-ownership` in place.
- **Milestone C.1 — CSV export for statements**: `_shared/exports/statementCsv.ts` + `statementCsv_test.ts` present; `generate-document/index.ts` has the `format === "csv"` branch gated by `CSV_EXPORT_ALLOWED = { customer_statement, vendor_statement }`, persisting via `persistArtifact({ metadata: { export_format: "csv" } })`; `PrintClient.exportDocument` / `downloadExport` exist; `CustomerStatements` + `VendorStatements` expose "Export CSV". `csv-export-registered_test.ts` present.

**Outstanding client-side spreadsheet usage confirming C.2 is genuinely pending:**
- `src/services/reports/ReportExportService.ts` still imports `xlsx` directly.
- `src/lib/importUtils.ts` and `src/lib/bankStatementParsers/csvParser.ts` import `xlsx` but are **inbound** (import/parse), not document generation — they are out of scope for the document-platform guard and will be explicitly allowlisted.

No regressions or superficial patches detected. Resume from C.2.

## Phase 2 — Execution: Milestone C.2 (tabular exports)

Sequential steps. Each step ends with tests green + typecheck clean before the next begins.

### C.2.1 — GL + Trial Balance CSV (lowest risk, reuses the shipped CSV branch)

1. Confirm PDF fetcher functions for `general_ledger` and `trial_balance` in `supabase/functions/_shared/pdf/**` (or the equivalent `_shared/reports/**`); reuse them — no new queries in the export path.
2. Add `_shared/exports/ledgerCsv.ts` and `_shared/exports/trialBalanceCsv.ts` — pure `DocumentData → Uint8Array`, same BOM/CRLF/RFC-4180 rules as `statementCsv.ts`.
3. Extend `CSV_EXPORT_ALLOWED` in `generate-document/index.ts` to include `general_ledger`, `trial_balance`; dispatch to the right builder.
4. Deno tests mirroring `statementCsv_test.ts` (BOM, CRLF, quoting, section coverage, `Uint8Array`) + extend `csv-export-registered_test.ts` for the two new types.

### C.2.2 — XLSX branch in `generate-document`

1. Add `xlsx-populate` via `esm.sh` import in `_shared/exports/xlsx/` (pure JS, ~200 KB — matches the risk table). If bundle size or compat blocks it, fall back to `sheetjs`/`xlsx` via `esm.sh` **inside the edge function only**.
2. Extend the `format` union to `"xlsx"`; keep the same allowlist as CSV to start (`customer_statement`, `vendor_statement`, `general_ledger`, `trial_balance`).
3. `statementXlsx.ts` + `ledgerXlsx.ts` + `trialBalanceXlsx.ts` builders — column widths, header row bold, currency formatting; each returns `Uint8Array` with the OOXML mime.
4. `persistArtifact({ metadata: { export_format: "xlsx" } })`; ensure `EXT_FOR_MIME` already resolves `.xlsx` (verified — plan claims it does; re-check).
5. Deno tests: builder unit tests (round-trip via `xlsx-populate.fromDataAsync` in test to assert cell values) + a `xlsx-export-registered_test.ts` sibling to the CSV one.

### C.2.3 — Migrate finance-report client exports

1. `src/services/reports/ReportExportService.ts` — replace the direct `xlsx.utils.book_new`/`writeFile` pipeline with `printClient.downloadExport({ documentType, id, format: "xlsx" | "csv" })`. Keep the public method signatures so `ReportExportButtons` and consumers don't churn.
2. `src/components/reports/ReportExportButtons.tsx` — no API change; only the underlying service swap.
3. Verify every finance report page (`src/pages/reports/**`) still gets identical CSV/XLSX output by diffing a sample export before/after.

### C.2.4 — Architecture guard + dependency cleanup

1. New ESLint rule `eslint-rules/no-raw-xlsx-in-app.js` (or extend `no-raw-pdf-lib-in-app.js`) forbidding `import ... from "xlsx"|"exceljs"|"xlsx-populate"` outside:
   - `supabase/functions/_shared/exports/**`
   - `src/lib/importUtils.ts` (inbound import parser — explicit allowlist)
   - `src/lib/bankStatementParsers/**` (inbound bank-statement parser — explicit allowlist)
2. Add an architecture test (`src/test/architecture/no-raw-xlsx.test.ts`) mirroring the existing PDF-lib guard to keep the invariant enforced independently of ESLint.
3. Remove `xlsx` from `package.json` **only if** no in-app consumer remains. If the inbound parsers still need it, keep the dep and rely on the guard.
4. Update `.lovable/plan.md` — mark C.2 shipped; move to Phase 3.

## Phase 3 — Deferred: HR letter record-page peek sheets

Milestone A wired list-row Print/History via `DocumentHistorySheet`. Once the HR module gets record pages for contracts / lifecycle events / offers, mount `DocumentVersionsSection` there for parity with the Sales/Purchases record pages the architecture test already enforces. No new document types; renderer + persistence unchanged.

## Non-negotiables (carried forward from prior engineer)

- Single-renderer / single-fetcher invariant: every new export format consumes the same `DocumentData` the PDF path uses. No parallel fetching.
- Every persisted artifact goes through `persistArtifact` — never write directly to storage or `document_artifacts`.
- No client-side XLSX/CSV serialisation for platform documents once C.2.3 lands.
- HR/POS/Finance/Sales/Purchases all remain consumers of `generate-document` + `printClient` — no app-local rendering paths reintroduced.

## Definition of done

- `generate-document` accepts `format ∈ { pdf, escpos, zpl, csv, xlsx }`, gated by per-type allowlists.
- CSV and XLSX available for `customer_statement`, `vendor_statement`, `general_ledger`, `trial_balance`.
- `ReportExportService` contains zero direct spreadsheet-library imports.
- Architecture test + ESLint rule prevent regression.
- `bunx tsgo --noEmit -p tsconfig.app.json` clean; `deno test` under `supabase/functions` green; existing architecture tests still pass.

## Risks

| Risk | Mitigation |
|---|---|
| `xlsx-populate` bundle size on edge function | Measure after C.2.2; fall back to `sheetjs` via `esm.sh` if regressed. |
| GL / TB fetchers return shapes the PDF path already relies on but export needs flatter | Add a thin adapter in the builder — do not change the fetcher. |
| Finance-report consumers depended on `xlsx` cell-level formatting the server builder doesn't reproduce | Diff sample exports before removing the client path; extend server builder before deleting client code. |

## Handover cue for the next agent

Resume at **C.2.1** (GL + TB CSV). Do not skip to XLSX or the client migration first — the CSV allowlist extension is the smallest verifiable step and unblocks the report-export migration path.
