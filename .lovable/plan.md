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


### Milestone B — POS receipt renderer demotion — **next**

Scope confirmed by audit:
- Renderers to demote: `src/lib/pos/receipt/renderers/{ThermalPrintRenderer,PdfRenderer}.ts`.
- Direct callers to reroute: exactly two — `src/components/pos/TransactionSummaryView.tsx` and `src/components/pos/PostPaymentScreen.tsx`. `PreviewRenderer.tsx` stays (on-screen SVG only, allowed under ADR‑0085).
- `generate-document` already handles `receipt` and `pos_receipt` document types (see `index.ts` L681, L831, L1022), so the demotion is a client-side rewire — no new server code.

Plan:
1. Capture golden byte fixtures (58mm ESC/POS + 80mm PDF) from the two renderers against a fixed cart snapshot; commit under `src/lib/pos/receipt/__fixtures__/`.
2. Reduce the two renderers to pure `(data, paperFormat) => bytes` builders — strip transport, dialog, and hook coupling.
3. Rewire `TransactionSummaryView` and `PostPaymentScreen` to `printClient.print()`.
4. Add `src/test/architecture/pos-renderer-ownership.test.ts` — no file under `src/pages/pos/**` or `src/features/pos/**` may import the two renderer modules directly (only `printClient` and the renderers themselves).
5. Replay golden fixtures; assert byte-identical output.

### Milestone C — Tabular exports through the platform — **after B**

1. Extend `generate-document` with `format: "csv" | "xlsx"`, gated to `statement`, `general_ledger`, `trial_balance`.
2. Reuse `persistArtifact` with `render_mode: "export"`.
3. Extend `DocumentVersionsSection` to render a download affordance for non-PDF mime types.
4. Migrate the three finance pages' export buttons to `printClient.print({ format })`.
5. Deno test on the CSV path.

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
| xlsx bundle bloats the edge function | Prefer `xlsx-populate` (pure JS, ~200KB) over `exceljs` if size regresses. |
| `render_mode: "export"` schema drift | `document_artifacts.render_mode` is TEXT — no migration; add a check constraint only after the format stabilises. |
