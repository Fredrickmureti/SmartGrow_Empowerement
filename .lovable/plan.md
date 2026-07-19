# Enterprise Document Platform — Continuation Plan

## Phase 1 — Verification of prior engineer's claims

Independent audit against the codebase confirms the prior plan is accurate.

**Verified landed:**
- Rendering ownership guards: `no-raw-pdf-lib-in-app.js` + `no-direct-barcode-lib.js`; ADR‑0084 and ADR‑0085 committed.
- Single-renderer path: `supabase/functions/generate-document` + `_shared/pdf/*` composition.
- Immutable artifact store: `document_artifacts` + `DocumentArtifactStore.ts` + `_shared/documents/persistArtifact.ts` with the HR types in `PERSIST_ALLOWLIST`.
- Wave B3.5 record-page parity: `DocumentVersionsSection` mounted on Sales + Purchases record pages, enforced by architecture test.
- Phase 6.1 core: `SignatureBlock`, `hrLetterGenerator`, `hrLetterFetchers`, HR branch in `generate-document/index.ts`, Deno tests.

## Phase 2 — Execution status

### Milestone A — HR letter UI wiring — **shipped**

Landed:
- `ContractsListPage`: per-row Print (`contract_letter`) + `DocumentHistorySheet` for version history. Single `PrintPreviewDialog` mounted at page level.
- `LifecycleTimelinePage`: per-row Print + History for events mapping to `promotion_letter` / `warning_letter`. Mapping in local `letterTypeFor` helper.
- `Recruitment` pipeline offer stage: new `OfferActions` sub-component. Creates an `offer_letters` row on demand via `useOffers.createOffer`, then exposes Print (`offer_letter`) + History per offer.
- New reusable `src/components/documents/DocumentHistorySheet.tsx` wraps `DocumentVersionsSection` in a Sheet so list rows can surface artifact history without a dedicated record page.

Verification: `tsgo --noEmit` clean on touched files. End-to-end print/persist/version flow exercised through `generate-document` + `document_artifacts`.


### Milestone B — POS receipt renderer demotion — **shipped**

Landed:
- `PrintClient` now owns the POS receipt bytes helpers: `printReceiptThermal({ transactionId, printRawBytes })` and `renderReceiptPdfBlob(transactionId)`. Register-scoped `printRawBytes` is passed in explicitly because the transport comes from `useHardwareProxy(register_id)`.
- Deleted `src/lib/pos/receipt/renderers/ThermalPrintRenderer.ts` and `PdfRenderer.ts`. They were already thin dispatchers over `generate-document`; their responsibilities collapsed into `PrintClient`.
- Rewired `src/components/pos/PostPaymentScreen.tsx` — auto-print, manual print/retry, PDF fallback, and Save PDF all now go through `printClient.*`. `TransactionSummaryView.tsx` never called the renderers (audit confirmed) and needed no change.
- `renderers/index.ts` now exports only the on-screen renderers (`PreviewRenderer`, `showSuccessOnCustomerDisplay`).
- Rewrote `src/test/architecture/pos-receipt-renderer-contract.test.ts` to lock the demotion (banned modules absent, `PostPaymentScreen` delegates through `printClient`).
- Added `src/test/architecture/pos-renderer-ownership.test.ts` — asserts no file across `src/{components,pages,features,hooks,lib}` imports the removed renderer paths or the `printThermal`/`renderReceiptPdf` symbols from the barrel.

Verification: `tsgo --noEmit` clean; both architecture tests green (12/12). Bytes remain byte-identical by construction — the server-side renderer path (`generate-document` → ESC/POS / PDF) is unchanged; only the client dispatch layer was collapsed.


### Milestone C — Tabular exports through the platform — **C.1 shipped (CSV for statements); C.2 pending (XLSX + GL/TB)**

**C.1 — Shipped (this turn):**
- New shared builder `supabase/functions/_shared/exports/statementCsv.ts` — RFC 4180 CSV with UTF-8 BOM + CRLF, consuming the exact `DocumentData` shape the PDF fetchers produce (single source of truth).
- `generate-document/index.ts` accepts `format: "csv"`, gated by `CSV_EXPORT_ALLOWED = { customer_statement, vendor_statement }`; short-circuit branch calls `buildStatementCsv` → `persistArtifact({ renderMode: "export", meta: { export_format: "csv" } })` → returns bytes with `text/csv; charset=utf-8`.
- `persistArtifact.EXT_FOR_MIME` extended for `text/csv` and `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.
- `PrintClient.exportDocument()` + `PrintClient.downloadExport()` — single chokepoint for tabular downloads; blob returned or archived + downloaded via anchor.
- `DocumentHistoryPanel` extension resolves `.csv` / `.xlsx` from mime — CSV artifacts now open/download correctly from any version-history surface.
- UI wiring: "Export CSV" dropdown row action in `CustomerStatements.tsx` and `VendorStatements.tsx`.
- Tests: `_shared/exports/statementCsv_test.ts` (4 tests — BOM/CRLF, RFC 4180 escaping, section coverage, Uint8Array output); `generate-document/csv-export-registered_test.ts` (6 tests — format acceptance, allowlist, builder delegation, `render_mode: "export"`, content-type, module existence). All 10 green.
- `tsgo --noEmit` clean.

**C.2 — Pending:**
1. XLSX branch behind bundle-size review — prefer `xlsx-populate` (~200KB) over `exceljs`; same `render_mode: "export"` shape.
2. Extend the CSV allowlist + build a shared `ledgerCsv`/`trialBalanceCsv` for `general_ledger` and `trial_balance` — reuse ledger/TB fetchers; do NOT re-fetch inline.
3. Migrate `ReportExportButtons` (finance pages) from client-side XLSX serialisation to `printClient.downloadExport({ format })` — kills the last direct `xlsx` usage in `src/services/reports/ReportExportService.ts`.
4. Architecture guard: extend `no-raw-pdf-lib-in-app` (or a sibling rule) to forbid `xlsx`/`exceljs` imports outside `supabase/functions/_shared/exports/**`.

## Definition of done

- Every HR letter print button routes through `generate-document`; artifacts persist; version history visible from the source surface once peek pages exist.
- Zero direct imports of `ThermalPrintRenderer` / `PdfRenderer` outside `printClient` and the renderer files; POS receipt bytes byte-identical to pre-demotion.
- Finance exports (statement, GL, trial balance) produce `document_artifacts` rows with `render_mode: "export"`, downloadable from version history.
- Typecheck, ESLint, architecture tests, and Deno tests all green after each milestone.

## Risks

| Risk | Mitigation |
|---|---|
| HR letter surface choice is wrong for the product | Wired on existing list pages; no new record pages invented. Trivial to relocate later. |
| POS demotion changes receipt bytes | Golden fixtures captured before the move; CI diffs bytes. |
| xlsx bundle bloats the edge function | Prefer `xlsx-populate` (pure JS, ~200KB) over `exceljs` if size regresses. Defer until C.2. |
| `render_mode: "export"` schema drift | `document_artifacts.render_mode` is TEXT — no migration; add a check constraint only after the format stabilises. |

## Handover — next agent

**Active phase:** Milestone C — Tabular exports. **C.1 (CSV for statements) shipped this turn. Resume at C.2.**

**Step 1 — verify C.1 (do this before writing new code):**
1. Read `supabase/functions/_shared/exports/statementCsv.ts` and confirm: UTF-8 BOM present, CRLF row separators, RFC 4180 quoting (`"` doubled to `""`, field wrapped in `"..."` when it contains `,`, `"`, `\r`, or `\n`), no direct DB access — pure `DocumentData -> Uint8Array`.
2. Read the `format === "csv"` branch in `supabase/functions/generate-document/index.ts` (search `CSV_EXPORT_ALLOWED`). Confirm it: (a) rejects non-statement types with 400, (b) reuses the same fetcher path as PDF for `documentData`, (c) calls `persistArtifact({ renderMode: "export", meta: { export_format: "csv" } })`, (d) returns `text/csv; charset=utf-8`.
3. `cd supabase/functions && deno test --allow-read --allow-net _shared/exports/statementCsv_test.ts generate-document/csv-export-registered_test.ts` — expect 10/10 green.
4. `bunx tsgo --noEmit -p tsconfig.app.json` — expect zero errors.
5. Manually verify a customer + vendor statement "Export CSV" round-trip in preview: dropdown → CSV downloads → new row appears in `DocumentHistoryPanel` with `.csv` extension.
6. Confirm `PrintClient.exportDocument` is the ONLY call site of `functions.invoke("generate-document", { body: { format: "csv" } })` from the frontend (grep for `format: "csv"` under `src/`).

If any of the above fails, fix before continuing.

**Step 2 — resume at C.2 (do NOT jump to unrelated work):**
1. XLSX support in `generate-document`: add `xlsx-populate` (or equivalent lightweight, pure-JS lib) via esm.sh import; extend `format` union; keep the allowlist gate; persist with `meta.export_format: "xlsx"`. Add matching `statementXlsx.ts` builder + Deno tests.
2. General Ledger + Trial Balance CSV: extend `CSV_EXPORT_ALLOWED` and add `ledgerCsv.ts` / `trialBalanceCsv.ts` builders. Reuse the fetchers already used by the PDF renderers — do NOT re-query in the export path.
3. Migrate finance-report client exports: replace `ReportExportService`'s direct `xlsx` writes in `src/pages/reports/*` and `src/components/reports/ReportExportButtons.tsx` with `printClient.downloadExport({ format })`. Keep the API surface of `ReportExportButtons` stable so consumers don't churn.
4. Add ESLint rule (or extend `no-raw-pdf-lib-in-app.js`) forbidding `import ... from "xlsx"|"exceljs"` outside `supabase/functions/_shared/exports/**`. Delete `xlsx` from `package.json` once the last import is gone.
5. Update this plan on completion; mark C fully shipped; propose Phase 3 (record-page peek sheets for HR letter surfaces, deferred from Milestone A) as the next milestone.

**Non-negotiables carried forward:**
- Single-renderer / single-fetcher invariant: every new export format MUST consume the same `DocumentData` the PDF path uses. No parallel data fetching.
- Every persisted artifact goes through `persistArtifact` — never write directly to storage or `document_artifacts`.
- No client-side XLSX/CSV serialisation for platform documents once C.2 lands.
