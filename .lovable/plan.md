# Enterprise Document Platform — Resumption (verified)

## Phase 1 — Verification results

Audited `.lovable/plan.md` claims against the codebase. Every checkpoint in the previous agent's "verification checklist" passes:

- **Rendering ownership guards** — `rg` for `pdf-lib`, `bwip-js`, and raw `qrcode` imports under `src/` returns zero real hits (only the architecture test itself matches, by design).
- **Shadow-path migration** — `useDocumentPrint` in `src/pages/**` is restricted to the two allow-listed POS settings surfaces (`POSTerminal.tsx`, `POSSettings.tsx`).
- **Artifact persistence** — both PDF and ESC/POS return branches in `supabase/functions/generate-document/index.ts` dynamically import and call `persistArtifact` (lines ~2441 and ~2521).
- **Peek-sheet history** — `DocumentVersionsSection` is mounted in 12 peek sheets under `src/features/`.
- **ADR-0085** — present at `docs/architecture/decisions/0085-barcode-and-pdf-rendering-ownership.md`; ESLint rules `no-raw-pdf-lib-in-app` and `no-direct-barcode-lib` are registered.

Conclusion: waves B1 / B2 / B3.2 / B3.4 and Phases 4–5 are genuinely landed. No rework required. The single-renderer / policy-resolver / immutable-artifact architecture (Odoo/SAP-style) is in place and enforced by ESLint + architecture tests. Resume, do not restart.

## Phase 2 — Plan validation

The remaining plan (Wave B3.5 → Phase 6) is architecturally sound. One small addition justified by the peek-sheet work already shipped: the record-page parity smoke test should mirror the peek-sheet guard exactly, so a future record page cannot ship without the version history section.

## Phase 3 — Execution order

### Wave B3.5 — Record-page version-history parity
1. Locate every full record page under `src/features/sales/record/**` and `src/features/purchases/record/**` (Sales: Invoice, Estimate, SalesOrder, CreditNote, Proforma, DeliveryNote, CustomerPayment, SalesReturn; Purchases: Bill, PurchaseOrder, VendorCreditNote, PurchaseReturn).
2. Mount `<DocumentVersionsSection documentType="..." documentId="..." />` below each record's existing Activity/Timeline section. The component self-hides when no artifacts exist, so no per-page guards are needed.
3. Add `src/test/architecture/document-versions-record-pages.test.ts` — walks the two record directories and asserts every record page imports `DocumentVersionsSection`, mirroring the existing peek-sheet guard.

### Phase 6.1 — HR letter renderers
1. Extend `supabase/functions/generate-document/index.ts` with document types `offer_letter`, `promotion_letter`, `warning_letter`, `contract_letter`.
2. Compose them entirely from `supabase/functions/_shared/pdf/components` (`BrandedHeader`, `RecipientBlock`, `NotesBlock`, `BrandedFooter`) — no new pdf-lib code, no forked builder, no new theme.
3. Add the four types to `PERSIST_ALLOWLIST` in `supabase/functions/_shared/documents/persistArtifact.ts` so HR letters land in `document_artifacts` on the same immutable audit trail.
4. Wire each HR page's "Print / Preview" button through `printClient.print()` (never `useDocumentPrint`).

### Phase 6.2 — POS receipt renderer demotion
1. Move `src/lib/pos/receipt/renderers/ThermalPrintRenderer.ts` and `PdfRenderer.ts` to pure builders that emit bytes for a given `DocumentData` + paper format. They must not know about transports, dialogs, or hooks.
2. Route every POS caller through `printClient.print()` so paper-format, transport, and persistence all resolve through the platform.
3. Add `src/test/architecture/pos-renderer-ownership.test.ts` asserting no file under `src/pages/pos/**` or `src/features/pos/**` imports the two renderer modules directly.

### Phase 6.3 — Tabular exports through the platform
1. Add `format=csv|xlsx` to `generate-document` — restricted to `statement`, `general_ledger`, `trial_balance`. Receipts and labels stay PDF/ESC-POS only.
2. Reuse the same persistence path: exports land as `document_artifacts` rows with correct MIME type and `render_mode: "export"` so they participate in the same reprint / history / audit UX.
3. Extend `DocumentVersionsSection` (only if needed) to render download links for non-PDF mime types.

## Definition of done (unchanged)

- Zero `useDocumentPrint` imports outside `PrintPreviewDialog` and the two POS settings surfaces.
- Every domain Print button routes through `printClient.print`.
- Every persistable printed or exported document produces a `document_artifacts` row; reprints are byte-identical; regenerations preserve the `supersedes_id` chain.
- No app-owned `pdf-lib` / raw-barcode imports outside sanctioned modules.
- Record pages and peek sheets show identical version history.

## Risks

| Risk | Mitigation |
|---|---|
| A record page silently ships without the versions section | Architecture test asserts import on every record page |
| HR letters need signature blocks the shared components don't have | Extend `NotesBlock` (or add one small `SignatureBlock` component) inside `_shared/pdf/components` — never fork the builder |
| POS renderer demotion breaks live receipt printing | Keep the byte-level golden receipt tests green after each move; migrate one renderer at a time |
| `xlsx` bundle size in the edge function | Use a Workers-compatible xlsx writer (e.g. `xlsx-populate`-style pure JS); no native deps |

Execute B3.5 → 6.1 → 6.2 → 6.3 in order. Each milestone must land with typecheck, tests, and ESLint clean before advancing.
