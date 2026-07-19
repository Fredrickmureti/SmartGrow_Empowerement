# Enterprise Document Platform — Audit Verdict & Foundation Plan

## 1. Verdict: the platform exists, it is not finished

The investigation is not "is there a document platform?" — there is. The correct question is **"which of its capabilities are complete, which are half-built, and which are still scattered across applications?"** Building a *new* platform on top of what already exists would be the architectural mistake, not the fix.

### 1a. What is already canonical (do not rebuild)

| Concern | Canonical owner | Evidence |
|---|---|---|
| Domain → PDF rendering | `supabase/functions/generate-document` + `_shared/pdf/PdfBuilder` + `themes/accountantMono` | ADR-0008; `docs/printing-pipeline.md` |
| Paper format / render-mode policy | `document_print_policies` table + resolver | ADR-0008 §Decision |
| Client print/preview/download primitives | `src/services/printing/pdfUtils.ts` (3 sanctioned fns) | `docs/printing-pipeline.md` |
| Cross-app single print entry point | `PrintClient.print({documentType, documentId, intent})` | ADR-0026 |
| Hardware chokepoint + audit log | `hardwareClient` → `hardware_exec_log` | ADR-0014, ADR-0037 |
| ESC/POS receipts (shared engine) | `supabase/functions/_shared/receipt/engine` + `theme.ts` | Phase B.1 |
| ZPL / EPL / ESC-POS label drivers | `electron/hardware/drivers/{Zpl,Epl,EscPos}LabelDriver` + `_shared/printing/zpl/builder` | ADR-0037 |
| Localization influence on documents | Localization packs → fiscal blocks (`_shared/pos/fiscalBlock`, `EtimsQRCode`) consumed by renderers | ADR-0010, ADR-0056 |
| Statutory paper pinning | `assertStatutoryPaper("a4")` sentinel | ADR-0008 §Statutory exceptions |
| Country-agnostic business apps | `architecture.fiscal-country-agnostic.test.ts` | Enforced |

### 1b. Real, verified gaps (these are the deliverables)

1. **Shadow print path still live on 12 surfaces.** ADR-0026 accepted 2026-06-17, "implementation deferred to wave B1" — never executed. `useDocumentPrint` + `PrintPreviewDialog` are still the default on Invoices, SalesOrders, Estimates, DeliveryNotes, CreditNotes, ProformaInvoices, CustomerPayments, Bills, PurchaseOrders, PurchaseReturns, SalesReturns, CreditNoteDetailDialog. A4 prints from these pages bypass `hardware_exec_log` — the platform is blind to them.
2. **`print_policies.resolve` RPC does not exist.** ADR-0026 depends on it; without it `PrintClient` cannot auto-route and every migrated surface would open the preview dialog on every print.
3. **Labels are a second, parallel stack.** `labelDispatch.ts` + `useInventoryLabelPrinter` + `Products.tsx` label printing do not go through `PrintClient.print({intent: "label"})`. Product labels, shelf/bin/pallet/LP labels are effectively owned by Inventory and Warehouse pages instead of the document platform.
4. **No canonical document-artifact storage.** `generate-document` renders on demand every time. There is no `document_artifacts` table pinning `(document_type, document_id, version, sha256, storage_path, rendered_at, template_version, locale, paper_format)`. Reprints re-render — auditors cannot get *the exact bytes that were issued*.
5. **No template versioning or regeneration history.** ADR-0008 anticipated `document_print_policies` per business; there is no equivalent version pin on the renderer/theme/localization pack so a document reprinted 2 years later can silently differ from the original.
6. **Barcode/QR generation is fragmented.** `EtimsQRCode` (component), ZPL builder (server), `bwip-js`/`qrcode` scattered, `suggest-scanner-label` edge fn. No `renderBarcode({symbology, data, ...})` service consumed by both PDF and label renderers.
7. **HR document types (offer/promotion/warning/contract letters) have no renderer** in `generate-document` — they are the last domain outside the platform.
8. **Exports (CSV/XLSX/PNG/SVG) are ad-hoc.** Reports export through their own paths; there is no `generate-document?format=xlsx` symmetry. This is acceptable *if* we name it explicitly rather than pretending the platform covers it.

### 1c. Duplication to eliminate

- Two receipt-render paths on the client (`ThermalPrintRenderer` + `PdfRenderer` under `src/lib/pos/receipt/renderers`) coexist with the canonical `PrintClient.print({intent:"receipt"})`. Keep the render classes as *pure builders* consumed by `PrintClient`; forbid direct calls from POS UI.
- `useDocumentPrint` (219 lines) is retained per ADR-0026 as the manual-fallback driver only. After wave B1, its only importer must be `PrintPreviewDialog`.

## 2. Target architecture (one sentence per layer)

```
Domain apps (Sales/Purchases/Inventory/WMS/POS/HR/Payroll/Finance)
        │  emit canonical business data + doc identity (no rendering)
        ▼
Document Platform
  ├─ Policy resolver ...... print_policies.resolve(business, branch, docType, intent)
  ├─ Template + theme ..... generate-document (edge) → PdfBuilder / EscPos / Zpl / Epl / Html
  ├─ Barcode service ...... renderBarcode() shared by PDF + label + web
  ├─ Localization hook .... pack-provided fiscal blocks + legal text (country-agnostic apps)
  ├─ Artifact store ....... document_artifacts (immutable bytes + sha256 + template_version)
  └─ Delivery .............. PrintClient (single entry) → hardwareClient → hardware_exec_log
        │
        ▼
Transports: Thermal / Laser / Label / Fiscal / Bluetooth / USB / Network / Email / Download
```

Business apps only ever call: `printClient.print({documentType, documentId, intent})`, `documentPlatform.preview(...)`, `documentPlatform.download(...)`, `documentPlatform.email(...)`. They never know paper size, printer, or template.

## 3. Phased implementation

### Phase 1 — Close ADR-0026 (unblocks everything else)
1. Land `print_policies.resolve(business_id, branch_id, document_type, intent)` RPC returning `{device_id, paper_format, copies, ask_user}`.
2. Extend `PrintClient.print()` to call the resolver, lazy-import `PrintPreviewDialog` only when `ask_user=true`.
3. Migrate all 12 shadow-path surfaces to `printClient.print(...)`.
4. Ship `eslint-rules/no-document-print-shadow-path` and `no-direct-window-print` at `error`.
5. Add `src/test/printing/cross-app-print-routing.test.ts` (static-analysis golden) covering the 12 pages.

### Phase 2 — Unify label & barcode generation
1. Extract `src/services/documents/renderBarcode.ts` (browser) + `supabase/functions/_shared/barcode/render.ts` (edge). Symbologies: EAN/UPC, Code128, ITF, GS1-128, QR, DataMatrix, PDF417.
2. Route `useInventoryLabelPrinter`, `Products.tsx`, shelf/bin/pallet/LP label paths through `printClient.print({intent:"label", documentType:"product_label"|"shelf_label"|...})`.
3. Move label templates into `generate-document` as first-class `documentType`s; delete `labelDispatch` bespoke transport once callers are migrated.
4. Test: `src/test/architecture/labels-through-document-platform.test.ts`.

### Phase 3 — Document artifact store & regen history
1. Migration: `document_artifacts(id, business_id, document_type, document_id, version, sha256, storage_path, template_version, theme_version, pack_version, locale, paper_format, render_mode, rendered_at, rendered_by, superseded_by)` — grants for `authenticated` + `service_role`, RLS scoped by `business_id`, unique `(document_type, document_id, version)`.
2. Supabase Storage bucket `document-artifacts` (private).
3. `generate-document` writes an artifact on first render; reprints fetch bytes by `(document_id, latest non-superseded version)`. New render only on explicit "Regenerate" (creates version N+1, sets `superseded_by` on N).
4. UI: shared `DocumentHistoryPanel` in `src/features/documents/` — preview / print / download / regenerate / view history / audit trail — mounted by every domain via the existing `DocumentPeekShell`.

### Phase 4 — Close remaining domain gaps
1. Add HR letter renderers (offer, promotion, warning, contract) to `generate-document`, reusing `BrandedHeader`/`RecipientBlock`/`NotesBlock`.
2. Retire the two orphan client receipt renderers as *renderers* — repurpose as pure builders consumed by `PrintClient`; add architecture test forbidding POS UI from calling them directly.
3. Add `format=csv|xlsx` to `generate-document` for the document types where tabular export is a real business need (statements, GL, trial balance). Explicitly out-of-scope for receipts/labels.

### Phase 5 — Governance & guardrails
- ADR-0084 (new): "Document artifact immutability and regeneration".
- ADR-0085 (new): "Barcode rendering ownership".
- ESLint: `no-raw-pdf-lib-in-app` (only `_shared/pdf/*` may import `pdf-lib`), `no-direct-barcode-lib` (only barcode service).
- Architecture tests co-located in `src/test/architecture/`.

## 4. What we are explicitly NOT doing

- Not building a new PDF engine — `PdfBuilder` stays.
- Not replacing `document_print_policies` — extending it.
- Not centralizing every export format on day 1 — receipts/labels/PDF first, tabular exports only where domain-justified.
- Not deleting `useDocumentPrint` — demoted to manual-fallback driver behind `PrintPreviewDialog`, per ADR-0026.
- Not writing long speculative docs. ADRs stay short; audit report is this plan.

## 5. Risks

- **Policy resolver defaults.** If tenants have no `document_print_policies` row, `ask_user=true` must be the default or we'll break existing print flows. Covered by resolver contract test.
- **Artifact storage bytes growth.** Mitigated by content-addressed dedupe (sha256) and per-tenant retention policy (Phase 3 follow-up).
- **Label migration touches Inventory/WMS.** Slice per document type; each slice ships with a golden test.
- **Regeneration semantics.** A regenerated invoice must never *replace* the original in audit — Phase 3 uses `superseded_by` and keeps historical bytes forever.

## 6. Definition of done

- Zero imports of `useDocumentPrint` outside `PrintPreviewDialog.tsx` (ESLint enforced).
- Every domain module's "Print" button routes through `printClient.print` (golden test enforced).
- All labels + barcodes render through the document platform (architecture test enforced).
- Every printed document has a row in `document_artifacts`; reprints are byte-identical; regenerations preserve history.
- No app-owned `pdf-lib` / barcode-lib imports outside `_shared/pdf/*` and the barcode service (ESLint enforced).

## 7. Confirmations needed before I start Phase 1

1. Proceed phase-by-phase with review gates between phases, or authorise Phases 1–2 back-to-back?
2. Any tenant currently depending on the operator-picks-destination preview dialog as the *intended* UX (i.e. should `ask_user=true` remain the shipped default until policies are configured)?
3. Retention policy for `document_artifacts` — indefinite (safest for audit; my default) or tenant-configurable from day 1?
