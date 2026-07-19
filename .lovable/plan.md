# Enterprise Document Platform — Audit Verdict & Foundation Plan (v2)

Defaults locked in per enterprise-ERP norms (Odoo, SAP, Oracle, NetSuite). No further questions.

## 1. Verdict

The platform exists — it is not finished. Building a new platform on top of what already exists would be the mistake. The work is to **complete, consolidate, and enforce** it.

### 1a. Already canonical (do not rebuild)

| Concern | Owner |
|---|---|
| Domain → PDF | `supabase/functions/generate-document` + `_shared/pdf/PdfBuilder` + `themes/accountantMono` (ADR-0008) |
| Paper format / render-mode policy | `document_print_policies` table |
| Client print/preview/download | `src/services/printing/pdfUtils.ts` (3 sanctioned fns) |
| Cross-app print entry point | `PrintClient.print({documentType, documentId, intent})` (ADR-0026) |
| Hardware chokepoint + audit | `hardwareClient` → `hardware_exec_log` (ADR-0014, ADR-0037) |
| ESC/POS receipts | `supabase/functions/_shared/receipt/engine` |
| ZPL / EPL / ESC-POS labels | `electron/hardware/drivers/*LabelDriver` + `_shared/printing/zpl/builder` |
| Localization → documents | Packs → fiscal blocks (`_shared/pos/fiscalBlock`, `EtimsQRCode`) |
| Statutory paper pinning | `assertStatutoryPaper("a4")` |
| Country-agnostic apps | `architecture.fiscal-country-agnostic.test.ts` |

### 1b. Verified gaps (the deliverables)

1. Shadow print path live on 12 surfaces (Invoices, SalesOrders, Estimates, DeliveryNotes, CreditNotes, ProformaInvoices, CustomerPayments, Bills, PurchaseOrders, PurchaseReturns, SalesReturns, CreditNoteDetailDialog). A4 prints bypass `hardware_exec_log`.
2. `print_policies.resolve` RPC does not exist — ADR-0026 wave B1 never landed.
3. Labels are a parallel stack (`labelDispatch`, `useInventoryLabelPrinter`, `Products.tsx`) not routed through `PrintClient.print({intent:"label"})`.
4. No `document_artifacts` table — reprints re-render; issued bytes are not preserved for audit.
5. No template/theme/pack version pin on outputs.
6. Barcode/QR generation fragmented (`EtimsQRCode`, ZPL builder, `bwip-js`, `qrcode`, `suggest-scanner-label`).
7. HR letter renderers (offer, promotion, warning, contract) not in `generate-document`.
8. Tabular exports (CSV/XLSX) are ad-hoc — explicitly scoped, not universally centralized.

### 1c. Duplication to eliminate

- POS client renderers (`ThermalPrintRenderer`, `PdfRenderer` in `src/lib/pos/receipt/renderers`) coexist with `PrintClient.print({intent:"receipt"})` — demote to pure builders consumed by `PrintClient`.
- `useDocumentPrint` retained only as fallback driver behind `PrintPreviewDialog` (ADR-0026).

## 2. Target architecture

```
Domain apps (Sales/Purchases/Inventory/WMS/POS/HR/Payroll/Finance)
        │  emit canonical business data + doc identity only
        ▼
Document Platform
  ├─ Policy resolver ...... print_policies.resolve(business, branch, docType, intent)
  ├─ Renderer .............. generate-document → PdfBuilder / EscPos / Zpl / Epl / Html
  ├─ Barcode service ....... renderBarcode() shared by PDF + label + web
  ├─ Localization hook ..... pack fiscal blocks + legal text (apps stay country-agnostic)
  ├─ Artifact store ........ document_artifacts (immutable bytes + sha256 + versions)
  └─ Delivery .............. PrintClient → hardwareClient → hardware_exec_log
        ▼
Thermal / Laser / Label / Fiscal / Bluetooth / USB / Network / Email / Download
```

Business apps only call: `printClient.print(...)`, `documentPlatform.preview(...)`, `documentPlatform.download(...)`, `documentPlatform.email(...)`. They never know paper size, printer, or template.

## 3. Locked defaults (enterprise-ERP norms)

- **Rollout:** Phases 1 → 2 → 3 in one continuous wave (Odoo/SAP standard: land the platform, migrate consumers, add immutability together). Phase 4 & 5 follow immediately after.
- **Policy resolver default:** `ask_user=true` when no `document_print_policies` row exists — preserves existing UX for unconfigured tenants (SAP output-determination default).
- **Artifact retention:** Indefinite, content-addressed (sha256 dedupe). Matches SAP ArchiveLink, Oracle WebCenter Content, NetSuite File Cabinet defaults. Per-tenant retention policy is a later add-on, not day-1.

## 4. Phased implementation

### Phase 1 — Close ADR-0026
1. Migration: `print_policies.resolve(p_business_id, p_branch_id, p_document_type, p_intent)` RPC → `{device_id, paper_format, copies, ask_user}`. Returns `ask_user=true` when no policy row.
2. Extend `PrintClient.print()` to call the resolver; lazy-import `PrintPreviewDialog` only when `ask_user=true`.
3. Migrate all 12 shadow-path surfaces to `printClient.print(...)`.
4. Ship ESLint rules `no-document-print-shadow-path` and `no-direct-window-print` at `error`.
5. Golden test `src/test/printing/cross-app-print-routing.test.ts` covering the 12 pages.

### Phase 2 — Unify labels & barcodes
1. `src/services/documents/renderBarcode.ts` (browser) + `supabase/functions/_shared/barcode/render.ts` (edge). Symbologies: EAN/UPC, Code128, ITF, GS1-128, QR, DataMatrix, PDF417.
2. Route `useInventoryLabelPrinter`, `Products.tsx`, shelf/bin/pallet/LP label paths through `printClient.print({intent:"label", documentType:...})`.
3. Add label templates as first-class `documentType`s in `generate-document`; retire `labelDispatch` bespoke transport.
4. Architecture test `src/test/architecture/labels-through-document-platform.test.ts`.

### Phase 3 — Document artifact store & regen history
1. Migration `document_artifacts(id, business_id, document_type, document_id, version, sha256, storage_path, template_version, theme_version, pack_version, locale, paper_format, render_mode, rendered_at, rendered_by, superseded_by)` — full GRANTs, RLS scoped to `business_id`, unique `(document_type, document_id, version)`, sha256 index for dedupe.
2. Private storage bucket `document-artifacts`.
3. `generate-document`: on first render, write artifact + return; on reprint, fetch latest non-superseded bytes; on explicit "Regenerate", write N+1 and set `superseded_by` on N.
4. Shared `DocumentHistoryPanel` in `src/features/documents/` — preview / print / download / email / regenerate / view history / audit trail — mounted via `DocumentPeekShell`.

### Phase 4 — Close remaining domain gaps
1. HR letter renderers in `generate-document` (offer, promotion, warning, contract) reusing `BrandedHeader` / `RecipientBlock` / `NotesBlock`.
2. Demote client receipt renderers to pure builders consumed by `PrintClient`; architecture test forbids POS UI from calling them directly.
3. Add `format=csv|xlsx` to `generate-document` for statements / GL / trial balance only (justified tabular exports). Receipts/labels explicitly out of scope.

### Phase 5 — Governance
- ADR-0084 "Document artifact immutability and regeneration".
- ADR-0085 "Barcode rendering ownership".
- ESLint `no-raw-pdf-lib-in-app` (only `_shared/pdf/*` may import `pdf-lib`).
- ESLint `no-direct-barcode-lib` (only barcode service may import `bwip-js` / `qrcode`).
- Architecture tests in `src/test/architecture/`.

## 5. What we are NOT doing

- Not building a new PDF engine — `PdfBuilder` stays.
- Not replacing `document_print_policies` — extending it.
- Not centralizing every export format — only where domain-justified.
- Not deleting `useDocumentPrint` — demoted to fallback driver.
- Not writing long speculative docs — short ADRs where they materially help.

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Resolver default breaks existing prints | `ask_user=true` default; resolver contract test |
| Artifact storage growth | sha256 content-addressed dedupe; retention policy hook reserved for later |
| Label migration touches Inventory/WMS | One documentType per slice, golden test per slice |
| Regenerated invoice replaces original in audit | `superseded_by` chain + immutable bytes forever |
| POS receipt renderer regressions | Existing `stage-b-receipt-snapshot.test.ts` + new `pos-receipt-renderer-contract.test.ts` guard |

## 7. Definition of done

- Zero imports of `useDocumentPrint` outside `PrintPreviewDialog.tsx` (ESLint).
- Every domain Print button routes through `printClient.print` (golden test).
- All labels + barcodes go through the document platform (architecture test).
- Every printed document has a `document_artifacts` row; reprints are byte-identical; regenerations preserve history.
- No app-owned `pdf-lib` / barcode-lib imports outside `_shared/pdf/*` and the barcode service (ESLint).

Ready to execute Phases 1–3 back-to-back on approval.
