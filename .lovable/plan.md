
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

**Plan correction (this session):** finance/GL/TB reports do NOT flow through `generate-document`; they flow through `render-report`, which owns the report registry + column specs + branding + prebuilt/server-build modes. Adding CSV/XLSX to `generate-document` would have created a second report pipeline. C.2 was therefore landed against `render-report` instead. Reports are computed views (not immutable business artifacts), so they are intentionally NOT added to the `document_artifacts` `PERSIST_ALLOWLIST` — export requests re-run against fresh journal data every time.

### C.2 — SHIPPED

1. **Shared builders** — `supabase/functions/_shared/exports/reportCsv.ts` and `reportXlsx.ts` are pure `(ReportExportConfig) → Uint8Array` builders. CSV: UTF-8 BOM + CRLF + RFC-4180 escaping. XLSX: `xlsx@0.18.5` via `esm.sh` with Deno target — same version pinned by the client, so historical workbook shape is preserved. Column widths, currency (`#,##0.00`) / number (`#,##0`) format codes, title-row merges applied.
2. **`render-report` prebuilt-mode dispatch** — accepts `format ∈ { pdf, csv, xlsx }`. Tabular formats short-circuit before the PDF renderer and resolve `companyName` via `getOrganizationBranding` so the masthead matches the PDF path exactly. Server-build mode (used only by scheduled reports) still emits PDF/JSON; adding CSV/XLSX there requires exposing the column registry through `renderReport`, deferred as a follow-up.
3. **Client migration** — `src/services/reports/ReportExportService.ts` no longer imports `xlsx`. `exportToCSV`/`exportToExcel` are now thin `supabase.functions.invoke('render-report', { body: { format } })` wrappers returning `Promise<void>`. Call sites (`ReportExportButtons`, `PrintPreviewDialog`) updated to `await`.
4. **Architecture guard** — `eslint-rules/no-raw-xlsx-in-app.js` forbids the WRITE-side APIs (`XLSX.write`, `XLSX.writeFile`, `XLSX.utils.book_new`, `XLSX.utils.aoa_to_sheet`, `XLSX.utils.json_to_sheet`, `XLSX.utils.book_append_sheet`) across `src/**`. READ-side APIs (`XLSX.read`, `sheet_to_json`) stay legal for bank-statement / generic import parsers. Two legitimate template-scaffold call sites in `src/lib/importUtils.ts` carry `// RENDERER-EXEMPT` markers (blank import template + per-import error report — not report artifacts). Wired into `eslint.config.js` under the existing rendering-ownership block.
5. **Tests** — `reportCsv_test.ts` (BOM/CRLF/RFC-4180/masthead/footer/currency) and `reportXlsx_test.ts` (OOXML round-trip via SheetJS to assert cell values + format codes + merges) added under `_shared/exports/`.

**Not done (deliberately out of scope, tracked as follow-ups):**
- Server-build (scheduled reports) CSV/XLSX — requires column registry passthrough from `renderReport` to the shared builders.
- `xlsx` package removal from `package.json` — the two inbound parsers (`bankStatementParsers/csvParser.ts`, `importUtils.ts`) still depend on it. Guard is sufficient.
- Migration of `_shared/reports/renderReport.ts` internal export path to the same builders (currently only the edge-function entrypoint dispatches).

## Phase 3 — Deferred: HR letter record-page peek sheets

Milestone A wired list-row Print/History via `DocumentHistorySheet`. Once the HR module gets record pages for contracts / lifecycle events / offers, mount `DocumentVersionsSection` there for parity with the Sales/Purchases record pages the architecture test already enforces. No new document types; renderer + persistence unchanged.

## Non-negotiables (carried forward from prior engineer)

- Single-renderer / single-fetcher invariant: every new export format consumes the same fetch path the PDF renderer uses. No parallel fetching.
- Every persisted BUSINESS-DOCUMENT artifact goes through `persistArtifact` — never write directly to storage or `document_artifacts`. Reports are exempt (computed views, always re-runnable).
- No client-side XLSX/CSV serialisation for platform reports — enforced by `no-raw-xlsx-in-app` + `ReportExportService` service surface.
- HR/POS/Finance/Sales/Purchases all remain consumers of `generate-document` + `printClient`; Finance reports consume `render-report`.

## Handover cue for the next agent

Two follow-ups worth picking up:
1. Extend `render-report` server-build mode to dispatch CSV/XLSX by exposing the report registry columns through `renderReport`. Unblocks scheduled-report tabular attachments.
2. Phase 3 (HR letter record-page peek sheets) is fully specified above and blocks on a new HR record-page pattern landing — currently no HR record page exists to mount `DocumentVersionsSection` in.
