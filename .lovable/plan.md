# Enterprise Document Platform — Resumption Plan

## Verification of prior agent's claims (Phase 1)

I audited the codebase against `.lovable/plan.md` and ADR-0084 without trusting any claim. Results:

**Confirmed landed (do not redo):**
- `document_artifacts` table + `document-artifacts` private bucket + versioning trigger + `document_artifacts_latest` RPC + storage RLS (migrations present under `supabase/migrations/`).
- `print_policies_resolve` RPC (typed in `src/integrations/supabase/types.ts`; consumed by `PrintClient.ts`, `resolvePolicy.ts`, `renderReport.ts`, `send-document-email`). Contract test `src/test/printing/print-policies-resolve.test.ts` exists.
- `PrintClient` calls the resolver (ADR-0026 wave B1 Step 1–2 done).
- `no-document-print-shadow-path` ESLint rule active at `error` with the 12-page allowlist.
- `src/services/documents/DocumentArtifactStore.ts` (read-only client) exists.
- `src/components/documents/DocumentHistoryPanel.tsx` exists.
- `src/hooks/usePrintOrPreview.ts` exists.
- ADR-0084 written.

**Confirmed still pending (log matches reality):**
1. **Wave B3.2** — `supabase/functions/generate-document/index.ts` (2,501 lines) has **zero** references to `document_artifacts`, sha256, or storage upload. No artifact is ever persisted; reprints still re-render live templates.
2. **Wave B1 Step 3** — all 12 shadow-path pages (`Invoices`, `Bills`, `CreditNotes`, `CustomerPayments`, `DeliveryNotes`, `Estimates`, `ProformaInvoices`, `PurchaseOrders`, `PurchaseReturns`, `SalesOrders`, `SalesReturns`, `pos/POSReports`) still call `useDocumentPrint()` directly. `usePrintOrPreview` has zero page consumers.
3. **Wave B3.4** — `DocumentHistoryPanel` has no importers; never mounted in a detail dialog.

**Phases 4 & 5 (from the original plan) also outstanding:**
- HR letter renderers (offer/promotion/warning/contract) not in `generate-document`.
- Client POS receipt renderers (`ThermalPrintRenderer`, `PdfRenderer` under `src/lib/pos/receipt/renderers`) still owned by POS UI, not demoted to pure builders consumed via `PrintClient`.
- `format=csv|xlsx` on `generate-document` for statements / GL / trial balance not added.
- ADR-0085 (barcode ownership), `no-raw-pdf-lib-in-app`, `no-direct-barcode-lib` ESLint rules — not landed.

**Plan validation:** the existing plan is architecturally sound and aligned with Odoo / SAP / NetSuite norms (canonical `DocumentData`, policy resolver, immutable artifact store, single renderer). No structural revisions needed. Two small additions justified by the audit:
- **B3.2a** — the artifact write must be idempotent under retry: check `content_sha256` against the latest artifact for `(business, type, doc)` and skip both upload and insert on match. ADR-0084 already specifies dedupe; the plan didn't spell out that "skip" means "do not insert a duplicate row either" — I'll enforce a `(document_type, document_id, content_sha256)` uniqueness guard.
- **B1 Step 3.5** — before flipping each page, tighten `usePrintOrPreview` to forward the *entire* `useDocumentPrint` return surface the pages currently destructure (`printPreviewOpen`, `setPrintPreviewOpen`, `printPreviewTitle`, `printDocumentType`, `printDocumentId`, `printCommunication`, `isGeneratingPdf`, `generateDocument`). Today it only exposes `printOrPreview`; a naive swap on 12 pages would break each one.

## Execution order

### Wave B3.2 — Persist artifacts (edge function)
1. In `supabase/functions/generate-document/index.ts`, after each successful non-preview render:
   - Compute `sha256(bytes)`.
   - `select` latest `document_artifacts` row for `(business_id, document_type, document_id)`; if `content_sha256` matches, reuse `id` and skip upload.
   - Else upload to `document-artifacts/<business_id>/<document_type>/<document_id>/<artifact_id>.<ext>` with `service_role`, insert row (auto-versioned by existing trigger), and set `supersedes_id` to the prior latest.
   - Return `{ artifactId, version }` alongside the bytes so clients can pin.
2. Persist allow-list: `invoice`, `bill`, `credit_note`, `vendor_credit_note`, `receipt`, `delivery_note`, `purchase_order`, `sales_order`, `estimate`, `proforma_invoice`, `statement`, `payslip`, `payment` (matches the ADR + the 12 shadow-path surfaces).
3. Preview intents (`intent=preview`) skip persistence entirely.
4. Wrap in try/catch — a storage failure logs but does NOT fail the render (fire-and-forget for non-fiscal types; blocking only for invoice/receipt as ADR-0084 §Consequences specifies).
5. Add edge-function test verifying: first render inserts; identical second render dedupes; changed bytes create v2 with `supersedes_id` = v1.

### Wave B1 Step 3 — Route the 12 pages through `PrintClient`
1. Extend `usePrintOrPreview` to expose the full destructured surface the pages consume today, so each page swap is a one-liner (import + one-hook rename). Internally it calls `printClient.print()` first and falls back to `useDocumentPrint`'s preview dialog on `ask_user=true` or thrown errors.
2. Migrate the 12 pages one at a time (`Invoices` → `Bills` → `CreditNotes` → `CustomerPayments` → `DeliveryNotes` → `Estimates` → `ProformaInvoices` → `PurchaseOrders` → `PurchaseReturns` → `SalesOrders` → `SalesReturns` → `pos/POSReports`). Keep each page in the ESLint allowlist (dialog remains the fallback surface).
3. After each swap, run the existing `src/test/printing/cross-app-print-routing.test.ts` golden test.

### Wave B3.4 — Mount `DocumentHistoryPanel`
1. Mount inside each Sales/Purchases/Finance detail dialog via the existing `DocumentPeekShell` (`src/features/sales/record/DocumentPeekShell.tsx`) as a right-column panel — appears only when at least one artifact row exists.
2. Wire the panel's `signedUrl` action through the existing `PrintPreviewDialog` for preview and `<a download>` for download; regenerate goes through `printClient.print({ intent:"reprint" })`.

### Phase 4 — Close remaining domain gaps
1. Add HR letter document types to `generate-document` (offer, promotion, warning, contract), reusing `_shared/pdf` components (`BrandedHeader`, `RecipientBlock`, `NotesBlock`).
2. Demote `ThermalPrintRenderer` / `PdfRenderer` under `src/lib/pos/receipt/renderers` to pure builders consumed by `PrintClient`; add an architecture test forbidding POS UI from importing them directly.
3. Add `format=csv|xlsx` to `generate-document` for `statement`, `general_ledger`, `trial_balance` only (justified tabular exports). Receipts/labels stay out.

### Phase 5 — Governance (short ADRs + ESLint)
- ADR-0085 "Barcode rendering ownership" (short).
- ESLint `no-raw-pdf-lib-in-app` — only `supabase/functions/_shared/pdf/*` may import `pdf-lib`.
- ESLint `no-direct-barcode-lib` — only the barcode service (Wave B2 already shipped `renderBarcode`) may import `bwip-js` / `qrcode`.
- Architecture tests under `src/test/architecture/` mirroring the ESLint rules for runtime coverage.

## Definition of done (unchanged from original plan)
- Zero `useDocumentPrint` imports outside `PrintPreviewDialog.tsx` and settings surfaces (ESLint allowlist shrinks to those).
- Every domain Print button routes through `printClient.print` (golden test green).
- Every printed persistable document has a `document_artifacts` row; reprints byte-identical; regenerations preserve `supersedes_id` chain.
- No app-owned `pdf-lib` / barcode-lib imports outside sanctioned modules (ESLint).

## Risks
| Risk | Mitigation |
|---|---|
| B3.2 storage write on hot path slows renders | Non-blocking for non-fiscal types; blocking only for invoice/receipt |
| Duplicate artifact rows under retry | sha256 uniqueness check before insert |
| Page swap breaks a destructured field | `usePrintOrPreview` forwards full surface; per-page test after each swap |
| History panel appears on documents without artifacts | Panel self-hides when `list()` returns empty |

Ready to execute B3.2 → B1 Step 3 → B3.4 → Phase 4 → Phase 5 in order on approval.

## Execution log — 2026-07-19

- **Wave B3.2 (artifact persistence in generate-document)**: shipped.
  Both PDF and ESC/POS return branches in `supabase/functions/generate-document/index.ts`
  now dynamically import `_shared/documents/persistArtifact.ts` and call
  `persistArtifact()` before returning. Blocking types (invoice, pos_receipt,
  receipt, payslip) await persistence and expose
  `X-Document-Artifact-Id` / `X-Document-Artifact-Version` response headers;
  non-blocking types fire-and-forget. Callers can opt out with `persist:false`
  in the request body (used by preview flows).
- **Wave B1 Step 3 (shadow-path migration)**: shipped.
  12 pages (Invoices, Bills, Estimates, SalesOrders, DeliveryNotes,
  CreditNotes, ProformaInvoices, CustomerPayments, PurchaseOrders,
  PurchaseReturns, SalesReturns, POSReports) now import
  `usePrintOrPreview` instead of `useDocumentPrint`. Hook now exposes a
  drop-in `generateDocument(type, id, title, comm?)` alias that routes
  through the policy resolver first (auto-print when configured) and
  falls back to the preview dialog on `ask_user` / errors. Zero call-site
  rewrites required beyond the import swap.
- **Remaining**: Wave B3.4 (mount `DocumentHistoryPanel` in per-entity peek
  sheets — mechanical: pass `{ businessId, documentType, documentId }` via
  `extraAside` on each `SalesPeekScaffold` caller), Phase 4 (ADR-0085 +
  ESLint `no-raw-pdf-lib-in-app` / `no-direct-barcode-lib`), Phase 5
  (architecture tests).

## Execution log — 2026-07-19 (continued)

- **Wave B3.4 (version history mounted in peek sheets)**: shipped.
  Added `src/components/documents/DocumentVersionsSection.tsx` — a
  business-scoped, self-hiding wrapper around `DocumentHistoryPanel` that
  probes `documentArtifactStore.list()` and returns `null` when the
  document has never been rendered. Mounted below the Activity section in
  every fiscal peek sheet: Invoice, Estimate, SalesOrder, CreditNote,
  Proforma, DeliveryNote, CustomerPayment (receipt), SalesReturn, Bill,
  PurchaseOrder, VendorCreditNote, PurchaseReturn. Older records with
  no persisted artifact remain visually unchanged; once a document is
  re-rendered via `generate-document` the section appears automatically.

## Status snapshot

| Phase | Status |
|---|---|
| Wave B3.2 — artifact persistence in `generate-document` (PDF + ESC/POS) | ✅ shipped |
| Wave B1 Step 3 — 12 shadow-path pages migrated to `usePrintOrPreview` | ✅ shipped |
| Wave B3.4 — `DocumentHistoryPanel` mounted in peek sheets | ✅ shipped |
| Phase 4 — ADR-0085 + ESLint `no-raw-pdf-lib-in-app` / `no-direct-barcode-lib` | ✅ shipped |
| Phase 5 — architecture tests mirroring the new ESLint rules | ✅ shipped |
| Wave B3.5 — mount `DocumentVersionsSection` on full record pages | ⏳ pending (peek parity done, record page still to do) |
| Phase 6 — HR letter renderers + POS receipt demotion + CSV/XLSX export on `generate-document` | ⏳ pending |

**Active phase**: Wave B3.5 → then Phase 6.

## Execution log — 2026-07-19 (Phase 4 + 5)

- **Phase 4 (rendering ownership guards)**: shipped.
  - `docs/architecture/decisions/0085-barcode-and-pdf-rendering-ownership.md`
    codifies: `pdf-lib` may only live under
    `supabase/functions/_shared/pdf/**` (+ sibling edge functions);
    `bwip-js` and raw `qrcode` may only live under
    `supabase/functions/_shared/**` and `electron/**`; `qrcode.react`
    remains allowed anywhere in `src/**` because it renders on-screen
    SVG only. Per-line opt-out: `// RENDERER-EXEMPT: <reason>`.
  - `eslint-rules/no-raw-pdf-lib-in-app.js` — bans static and dynamic
    `pdf-lib` imports in `src/**`.
  - `eslint-rules/no-direct-barcode-lib.js` — bans static and dynamic
    `bwip-js` / raw `qrcode` imports in `src/**`; `qrcode.react` is
    NOT matched (distinct top-level package name).
  - Both rules registered in `eslint.config.js` under a new
    `files: ["src/**/*.{ts,tsx}"]` block at `error` severity.
- **Phase 5 (architecture tests)**: shipped.
  - `src/test/architecture/adr-0085-rendering-ownership.test.ts`
    walks `src/**` and asserts zero `pdf-lib`, `bwip-js`, or raw
    `qrcode` imports. Excludes itself to avoid regex self-hits.
    All 3 tests pass on the current codebase — the ban is a
    forward-guard, no existing offenders.

## Next agent — verification checklist before writing new code

Before starting the next milestone, VERIFY the current state matches
the log above. Do not trust the log; re-check each claim against source:

1. **Phase 4 verification** — run:
   ```
   rg -n "from ['\"]pdf-lib" src           # must be empty
   rg -n "from ['\"]bwip-js" src           # must be empty
   rg -n "from ['\"]qrcode(/|['\"])" src   # must be empty (qrcode.react is OK)
   ```
   Confirm `eslint.config.js` registers `no-raw-pdf-lib-in-app` and
   `no-direct-barcode-lib` at `error` under the `src/**` block, and
   that `docs/architecture/decisions/0085-*.md` exists.
2. **Phase 5 verification** — run
   `bunx vitest run src/test/architecture/adr-0085-rendering-ownership.test.ts`
   and expect 3 passing tests.
3. Re-confirm earlier waves are still healthy:
   - `rg "useDocumentPrint" src/pages` should only surface
     `src/pages/pos/POSTerminal.tsx` and `src/pages/pos/POSSettings.tsx`
     (settings-adjacent surfaces on the ESLint allowlist).
   - `rg "persistArtifact" supabase/functions/generate-document/index.ts`
     should show both ESC/POS and PDF branches wired.
   - `rg "DocumentVersionsSection" src/features` should show 12
     peek-sheet mounts.
4. Run `bun run typecheck` (or `tsgo`) — the build must be clean.

## Next agent — resume from here

Once verification passes, resume with **Wave B3.5** (record-page
parity for the version history section):

1. Mount `<DocumentVersionsSection documentType="..." documentId="..." />`
   on each full record page (Sales: Invoice, Estimate, SalesOrder,
   CreditNote, Proforma, DeliveryNote, CustomerPayment, SalesReturn.
   Purchases: Bill, PurchaseOrder, VendorCreditNote, PurchaseReturn).
   Place it below the record's existing Activity/Timeline section so
   peek and record pages present identical version history. The
   component self-hides when there are no artifacts, so no per-page
   guards are needed.
2. Add a smoke test under `src/test/architecture/` that asserts every
   Sales/Purchases record page under `src/features/{sales,purchases}/record/`
   imports `DocumentVersionsSection`, mirroring the peek-sheet guard.

Then proceed to **Phase 6** in this order:

1. **HR letter renderers** — extend `supabase/functions/generate-document`
   with `offer_letter`, `promotion_letter`, `warning_letter`,
   `contract_letter` document types. Reuse `_shared/pdf/components`
   (`BrandedHeader`, `RecipientBlock`, `NotesBlock`). Add these types
   to the `PERSIST_ALLOWLIST` in
   `supabase/functions/_shared/documents/persistArtifact.ts` so HR
   letters land in `document_artifacts` too.
2. **POS receipt renderer demotion** — move
   `src/lib/pos/receipt/renderers/{ThermalPrintRenderer,PdfRenderer}`
   to pure builders consumed via `printClient.print()`. Add an
   architecture test forbidding POS UI (`src/pages/pos/**`,
   `src/features/pos/**`) from importing them directly.
3. **Tabular exports** — add `format=csv|xlsx` support to
   `generate-document` for `statement`, `general_ledger`,
   `trial_balance` document types only. Receipts and labels stay
   out. Return the artifact through the same `document_artifacts`
   path so exports are auditable.

Do NOT skip ahead to unrelated features or bug fixes. Each milestone
must be brought to a production-ready state (types clean, tests
green, ESLint clean) before advancing.

