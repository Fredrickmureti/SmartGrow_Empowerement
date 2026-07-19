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
