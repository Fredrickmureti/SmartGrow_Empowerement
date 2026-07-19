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

---

## Phase 4 — Execution log (live)

### ✅ Wave B3.5 — COMPLETE
- `DocumentVersionsSection` mounted on all 12 Sales + Purchases record pages (via `RecordShell` children or `SalesRecordScaffold.extraSections`).
- Architecture guard: `src/test/architecture/document-versions-record-pages.test.ts` enforces the mount on every full record page.
- Pre-existing build blockers fixed: `usePrintOrPreview.ts` (DocumentType cast), `DocumentArtifactStore.ts` (Supabase type inference), `CustomerPayments.tsx` (printOrPreview API).

### 🚧 Phase 6.1 — HR letter renderers — IN PROGRESS (core landed)
**Landed this turn:**
- `supabase/functions/_shared/pdf/components/SignatureBlock.ts` — shared signature-block component (single or side-by-side signatories), now exported from `_shared/pdf/index.ts`.
- `supabase/functions/_shared/templateRenderer.ts` — `DocumentType` union extended with the four HR types.
- `supabase/functions/_shared/hrLetterGenerator.ts` — dedicated prose renderer composing `PdfBuilder` + `BrandedHeader` + `NotesBlock` + `SignatureBlock` + `drawFinalFooter`. Emits: recipient block, right-aligned meta (ref# / issue / effective), subject line, facts grid, salutation, multi-paragraph body, closing, notes, signatures, audit footer.
- `supabase/functions/generate-document/hrLetterFetchers.ts` — fetchers for all four HR types: `offer_letter` (from `offer_letters` + candidate join), `contract_letter` (from `employee_contracts` + employee join), `promotion_letter` / `warning_letter` (from `employee_lifecycle_events` + employee join, payload-driven).
- `supabase/functions/generate-document/index.ts` — dedicated HR branch runs BEFORE the sales `FETCHER_MAP` dispatch: fetches tenancy, enforces org membership, renders, and persists to `document_artifacts` via the standard `persistArtifact` pipeline. HR path deliberately bypasses template / payment_methods / escpos / statement stages (none apply to prose letters).
- `supabase/functions/_shared/documents/persistArtifact.ts` — HR types added to `PERSIST_ALLOWLIST`; `offer_letter` + `contract_letter` marked as blocking-persist (audit integrity).
- Architecture guards:
  - `supabase/functions/_shared/documents/persistArtifact_hr_test.ts` — allowlist regression guard.
  - `supabase/functions/generate-document/hr-letters-registered_test.ts` — asserts type-guard coverage, HR branch precedence over `FETCHER_MAP`, and dispatcher coverage of every HR type.

**Pending in Phase 6.1:**
- Step 4 of the original plan: wire each HR page's "Print / Preview" button through `usePrintOrPreview` / `printClient.print()`. The four HR pages do not yet exist as dedicated Record pages in `src/features/hr/**`; the backend contract is ready and any caller can `supabase.functions.invoke("generate-document", { body: { documentType: "offer_letter", documentId } })`.
  - When HR record pages are added (or if they already live under a different path — audit `src/features/hr/**` and `src/pages/hr/**` first), each must import `usePrintOrPreview` **and** mount `DocumentVersionsSection`, matching the sales/purchases contract.
- Manual smoke: invoke `generate-document` for one seeded row of each HR type and confirm a fresh row lands in `document_artifacts` with the correct `document_type` + version chain.

### ⏭ Next milestone — Phase 6.2 (POS receipt renderer demotion)
Only start after 6.1's UI wiring + smoke tests pass. See "Phase 6.2" above.

---

## Handoff — instructions for the next agent

1. **VERIFY 6.1 CORE FIRST.** Do not start new work until you have:
   - Read `supabase/functions/_shared/hrLetterGenerator.ts`, `supabase/functions/generate-document/hrLetterFetchers.ts`, and the HR branch inside `supabase/functions/generate-document/index.ts` end-to-end. Confirm they compose ONLY shared `_shared/pdf/components` primitives (no forked pdf-lib code, no bespoke theme).
   - Run the two new Deno tests: `persistArtifact_hr_test.ts` and `hr-letters-registered_test.ts`. Both must pass.
   - Manually invoke `generate-document` against a real row of each HR type (or seed one). Confirm the returned PDF renders, has header/footer/signature block, and a `document_artifacts` row was created with the correct `document_type`.
   - Confirm the sales pipeline is unaffected: render one invoice and one bill, verify byte-identical output vs. pre-6.1.
2. **FINISH 6.1 STEP 4.** Audit `src/features/hr/**` and `src/pages/hr/**` for existing HR letter pages. For each: mount `usePrintOrPreview` on the Print/Preview button (documentType = the HR slug) and add `DocumentVersionsSection` for parity with sales. If pages do not yet exist, coordinate with the HR feature owner before scaffolding new UI — do NOT invent new record pages unilaterally.
3. **THEN advance to Phase 6.2** (POS receipt renderer demotion). Do NOT jump to 6.3 first — chronological order preserves the architectural narrative.
4. Update this plan file at the end of each milestone. Keep the ✅ / 🚧 / ⏭ markers accurate.
