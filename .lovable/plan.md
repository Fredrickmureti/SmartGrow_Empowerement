# Enterprise Document Platform — Continuation Plan

## Phase 1 — Verification of prior engineer's claims

Independent audit against the codebase confirms the prior plan (`.lovable/plan.md`) is accurate.

**Verified landed:**
- Rendering ownership guards: `eslint-rules/no-raw-pdf-lib-in-app.js` + `eslint-rules/no-direct-barcode-lib.js` present; ADR‑0084 and ADR‑0085 committed.
- Single-renderer path: `supabase/functions/generate-document` + `_shared/pdf/*` composition (BrandedHeader, RecipientBlock, NotesBlock, TotalsBlock, LineItemsTable, DataTable, SummaryBlock, BrandedFooter, SignatureBlock).
- Immutable artifact store: `document_artifacts` table + `DocumentArtifactStore.ts` + `_shared/documents/persistArtifact.ts` with `PERSIST_ALLOWLIST` including invoice/bill/receipt/statement/…/HR types.
- Wave B3.5 record-page parity: `DocumentVersionsSection` mounted on Sales + Purchases record pages, enforced by architecture test.
- Phase 6.1 core: `_shared/pdf/components/SignatureBlock.ts`, `_shared/hrLetterGenerator.ts`, `generate-document/hrLetterFetchers.ts`, HR branch in `generate-document/index.ts`, HR types in `PERSIST_ALLOWLIST` (`offer_letter`, `contract_letter` blocking-persist; `promotion_letter`, `warning_letter` fire-and-forget). Deno tests `persistArtifact_hr_test.ts` and `hr-letters-registered_test.ts` present.

**Verified pending:**
- Phase 6.1 step 4 — no HR page invokes `generate-document` for the four letter types; `rg` for `offer_letter|promotion_letter|warning_letter|contract_letter` in `src/` returns no hits.
- Phase 6.2 — `src/lib/pos/receipt/renderers/{ThermalPrintRenderer,PdfRenderer}.ts` still present; POS callers not yet demoted to `printClient.print()`.
- Phase 6.3 — no `format=csv|xlsx` branch in `generate-document`; no `render_mode: "export"` artifacts.

**No rework required.** Resume from Phase 6.1 step 4.

## Phase 2 — Plan expansion (additions justified by audit)

Additions on top of the prior plan:

1. **HR letter UI surface is undecided.** `src/pages/hr/contracts`, `src/pages/hr/lifecycle`, `src/pages/hr/documents` exist but none render a per-letter record. Rather than scaffold four new record pages, extend `HR › Documents › DocumentsListPage` with a "Generate letter" action per lifecycle event / contract / offer that calls `generate-document` and opens the resulting artifact through `PrintPreviewDialog`. Add `DocumentVersionsSection` next to each source row (employee profile → Documents tab, contract detail, lifecycle event peek).
2. **POS demotion smoke coverage.** Add byte-level golden fixtures for one 58mm and one 80mm receipt captured *before* the renderer move so the demotion is provably byte-identical.
3. **Export renderer library choice.** `xlsx-populate` and `sheetjs` both work in Workers; pin `exceljs`'s ESM build (used elsewhere in reporting) if compatible, else `xlsx-populate`. Confirm bundle size stays under Worker limits (< 3 MB gzipped).
4. **Rendered-format registry.** Introduce `render_mode: "export"` on `document_artifacts` and extend `DocumentVersionsSection` to render a download affordance for non-PDF mime types (CSV/XLSX icons + filename). Small, single-file change; unblocks 6.3 UI.

## Phase 3 — Execution order

### Milestone A — Phase 6.1 step 4 (HR letter UI wiring)

1. Add `usePrintOrPreview` calls for the four HR types on:
   - Offer letter — Recruitment / candidate offer surface (source: `offer_letters` row).
   - Contract letter — `ContractsListPage` row action + contract detail peek (source: `employee_contracts`).
   - Promotion / warning letter — `LifecycleTimelinePage` per-event action (source: `employee_lifecycle_events`).
2. Mount `DocumentVersionsSection` on each of those surfaces (employee profile Documents tab, contract detail, lifecycle event peek) with the correct `documentType` / `documentId`.
3. Manual smoke: invoke each type end-to-end, confirm PDF renders and a `document_artifacts` row lands with the correct `document_type` and `version` chain.
4. No new architecture test yet — the peek/record parity test already covers Sales + Purchases; HR letters get their own once dedicated record pages exist.

### Milestone B — Phase 6.2 (POS receipt renderer demotion)

1. Capture golden byte fixtures (58mm ESC/POS + 80mm PDF) from current renderers.
2. Reduce `ThermalPrintRenderer.ts` and `PdfRenderer.ts` to pure `(data, paperFormat) => bytes` builders — strip transport, dialog, and hook coupling.
3. Route every POS caller through `printClient.print()`; keep `PreviewRenderer.tsx` (on-screen only, allowed).
4. Add `src/test/architecture/pos-renderer-ownership.test.ts` — asserts no file under `src/pages/pos/**` or `src/features/pos/**` imports the two renderer modules directly.
5. Replay golden fixtures — bytes must match.

### Milestone C — Phase 6.3 (tabular exports through the platform)

1. Extend `generate-document` with `format: "csv" | "xlsx"`, gated to `statement`, `general_ledger`, `trial_balance`.
2. Reuse `persistArtifact` with `render_mode: "export"`; MIME `text/csv` / `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.
3. Extend `DocumentVersionsSection` to render a download button for non-PDF artifacts.
4. Migrate the three finance pages' existing export buttons to `printClient.print({ format })`.
5. Deno test: invoking with `format=csv` produces a row with the right MIME + `render_mode`.

## Definition of done

- Every HR letter print button routes through `generate-document`; artifacts persist; version history visible on the source surface.
- Zero direct imports of `ThermalPrintRenderer` / `PdfRenderer` outside `printClient` and the renderer files themselves; POS receipt bytes byte-identical to pre-demotion.
- Finance exports (statement, GL, trial balance) produce `document_artifacts` rows with `render_mode: "export"` and are downloadable from the version history.
- Typecheck, ESLint, architecture tests, and Deno tests all green after each milestone.

## Risks

| Risk | Mitigation |
|---|---|
| HR letter surface choice is wrong for the product | Wire buttons on existing pages (Recruitment, Contracts, Lifecycle Timeline) rather than inventing new record pages; can move later without touching the backend contract. |
| POS demotion changes receipt bytes | Golden fixtures captured before the move; CI diffs bytes. |
| xlsx bundle bloats the edge function | Prefer `xlsx-populate` (pure JS, ~200KB) over `exceljs` if size regresses; verify Worker cold-start unchanged. |
| `render_mode: "export"` schema drift | `document_artifacts.render_mode` is TEXT (no enum) — no migration required; add a check constraint only after the format stabilises. |

Execute A → B → C in order. Update `.lovable/plan.md` after each milestone.
