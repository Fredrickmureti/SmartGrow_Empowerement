# Printing Architecture Audit — 2026-05-11

This document captures the system-wide audit of how documents are rendered
and printed in this ERP, the gap that prevents non-POS documents (invoices,
sales orders, purchase orders, bills, credit/delivery notes, statements,
estimates, proformas, payments/receipts) from being printed on thermal
hardware, and the staged plan that closes the gap without disrupting A4
workflows.

The audit is the canonical source for ADR-0008 and for plan stages P0–P9
(see `.lovable/plan.md`).

---

## 1. Two parallel printing pipelines

The codebase has two completely independent rendering stacks. They share no
templates, no layout primitives, no paper-size logic, and no transports.

```text
POS path (browser, hardware-aware)             Non-POS path (server, A4 PDF only)
─────────────────────────────────────          ──────────────────────────────────────
src/services/receipt/                           supabase/functions/generate-document/
  ├─ ReceiptTemplateGenerator.ts (HTML)           └─ index.ts (1251 lines, fetchers
  └─ ReceiptEscPosBuilder.ts (ESC/POS bytes)         per document type)
src/services/hardware/                          supabase/functions/_shared/
  ├─ PrinterService.ts                            ├─ pdfGenerator.ts
  ├─ drivers/EscPosPrinterDriver.ts               │     pageSize: "a4"  ← hardcoded
  ├─ drivers/EposPrinterDriver.ts                 │     (lines 269, 472)
  ├─ transport/{Electron,LocalAgent,WebUSB}       ├─ pdf/PdfBuilder.ts
  ├─ interfaces/{Network,USB,Serial}              │     PageSize = "letter" | "a4" only
  └─ local-agent/protocol.ts                      ├─ pdf/components/{Header,Footer,
agent/src/routes/print.ts (Node TCP raw bytes)   │      DataTable,LineItemsTable,...}
src/lib/receiptConfig.ts                          └─ templateRenderer.ts
  └─ PAPER_CONFIGS: 58mm, 80mm, A4, A5, Letter   src/services/printing/
src/hooks/useReceiptSettings.ts                   ├─ PrintService.ts (browser print)
  → businesses.receipt_settings (per-company)     └─ pdfUtils.ts (download/print blob)
                                                src/hooks/useDocumentPrint.ts
                                                  → invokes generate-document → PDF
```

### Concrete coupling points

- `supabase/functions/_shared/pdfGenerator.ts:269` and `:472` call
  `PdfBuilder.create({ orientation: "portrait", pageSize: "a4" })`. The
  paper choice is a literal in the renderer; no caller can override it.
- `supabase/functions/_shared/pdf/PdfBuilder.ts:20` declares
  `PageSize = "letter" | "a4"`. Thermal widths cannot even be expressed in
  the type system the non-POS renderer uses.
- `src/hooks/useDocumentPrint.ts` is the single client entry point used by
  every non-POS surface (Invoices, Estimates, Bills, PurchaseOrders,
  CreditNotes, DeliveryNotes, ProformaInvoices, SalesOrders, SalesReturns,
  PurchaseReturns, CustomerPayments, statements). It always invokes
  `generate-document` and always receives an A4 PDF blob.
- `src/services/receipt/ReceiptTemplateGenerator.ts` and
  `src/lib/receiptConfig.ts` know paper widths, column counts, font
  scaling, item display modes, and ESC/POS but expose this knowledge
  exclusively to POS code paths. The edge-function PDF generator is
  unaware of any of it.

## 2. Settings fragmentation

| Concern                              | POS                                     | Non-POS                            |
|--------------------------------------|-----------------------------------------|------------------------------------|
| Paper / template per company         | `businesses.receipt_settings` (JSON)    | none                               |
| Per-document overrides               | implicit via POS register profile       | none                               |
| Printer profiles (LAN/USB/agent)     | hardware drivers + device registry UI   | none                               |
| Render mode choice                   | HTML preview, ESC/POS, browser print    | PDF download / browser print only  |

`document_templates` carries label/title/colour preferences only — no paper
size, no transport, no printer binding.

## 3. Template duplication risk

- POS HTML receipt: 956 LoC in `ReceiptTemplateGenerator.ts`, end-to-end.
- Non-POS PDF: built via `PdfBuilder` + `LineItemsTable` / `TotalsBlock` /
  `RecipientBlock` / `NotesBlock` (Deno + pdf-lib).
- They share no domain mapping layer. Naively forking the PDF stack to
  emit thermal output, or forking the receipt stack to emit invoices,
  would triple the surface area of templates we maintain.

## 4. How major ERPs solve this (research summary)

- **Odoo** — every document is a QWeb HTML/CSS report; `paperformat_id`
  (per-document or per-company) dictates `page_width_mm`,
  `page_height_mm`, margins. The same template renders to A4 PDF or 80 mm
  receipt by swapping the paperformat. POS uses an ePOS HTML receipt
  rendered by the IoT Box for ESC/POS. Three reusable abstractions:
  *(1)* one template engine, *(2)* paper format as a first-class entity,
  *(3)* printer/destination as a separate "report action".
- **NetSuite / SAP** — "Form templates" + per-subsidiary/role/transaction
  printer routing. Printer choice is a routing concern, separated from
  template design.
- **QuickBooks / Xero** — invoice templates carry paper size; POS
  receipts go through a dedicated POS hardware service.
- **Common pattern across all four** — the document domain model is
  paper-agnostic; a **format/policy** layer chooses size and transport
  (PDF download, ESC/POS over LAN, HTML preview).

## 5. Root cause

`generate-document` was designed for accountants (A4 invoices) at the same
time the POS subsystem was designed for cashiers (thermal receipts), and
the two were never reconciled. As a result, a wholesale or B2B business
that issues invoices but uses thermal printers has no path through the
system: `useDocumentPrint` always returns A4 PDF, and the hardware /
ESC/POS stack only accepts POS `ReceiptTransactionData`, not invoice / SO
/ PO data shapes.

---

## 6. Recommended architecture (three layers)

```text
1. DOCUMENT MODEL (paper-agnostic, already exists)
   DocumentData produced by fetchers in generate-document/index.ts.

2. PAPER FORMAT + RENDER STRATEGY (new)
   paper_formats: 58mm | 80mm | A5 | A4 | Letter | custom mm
   render_mode:   "pdf" | "escpos" | "html"
   Resolved per request: explicit override → user prefs →
                         business.print_policy[document_type] → A4 default.

3. TRANSPORT / DESTINATION (already exists for POS)
   download | browser-print | ESC/POS via Network/USB/LocalAgent
```

### Backward-compatibility guarantee

A4 remains the system default for every existing document type until a
business opts in via policy. Existing PDFs are byte-comparable for A4
because component code paths remain unchanged when `density = "wide"`.
The legacy `pageSize: "a4" | "letter"` argument continues to work as an
alias for the new `paperFormat` field on `PdfBuilder.create`.

## 7. Risks

- **Auto-height pages on thermal** — pdf-lib needs a known page size at
  `addPage`. We render once, then add a single page sized to the final
  Y. Any component that calls `newPage()` mid-render must be guarded
  behind `paperFormat.heightMm !== "auto"`.
- **Narrow column math** — `LineItemsTable` weights assume ≥ ~400 pt
  content width. Add a narrow-mode (description on its own line, qty ×
  price below) before claiming thermal works.
- **ESC/POS code pages** — non-Latin text needs the same code-page
  handling POS already does; reuse `escpos-commands.ts`.
- **Multi-page invoices on 80 mm** — `escpos` uses continuous
  (height = "auto"); `pdf` on thermal uses a single sized page if the
  caller wants a downloadable file.

## 8. Stages

See `.lovable/plan.md` for the staged implementation P0–P9. Stages P1–P3
unblock the "wholesale on thermal" use case at the engine level; P4–P8
make it admin-configurable per business and per document type without
touching A4 behaviour for anyone who does not opt in.

## 9. Phase T1 — Continuous paper profile (2026-07-19)

Followup audit closed the "thermal PDF renders as a very tall blank
strip" defect. Root cause was that `PdfBuilder.PAPER_PRESETS` seeded the
thermal presets (80/58/40mm) with `heightMm: 297`, and `create()` silently
mapped the reserved `"auto"` value to 297mm. Layout components (`density
=== "narrow"` branches in `LineItemsTable`, `TotalsBlock`, `RecipientBlock`,
`BrandedHeader`, etc.) were already correct — the sheet was simply too
tall.

Fix (see `supabase/functions/_shared/pdf/PdfBuilder.ts`):

- Thermal presets now declare `heightMm: "continuous"`.
- `create()` allocates a provisional 3000pt page height in continuous mode.
- `save()` calls `PDFPage.setMediaBox` to crop the visible page to
  `(paperWidth × consumedContentHeight + bottomMargin)`, matching Odoo's
  `paperformat` with `page_height=0` and the standard "receipt formatter"
  pattern in SAP POS DM / Xstore / D365 Commerce.
- `newPage()` throws on continuous media (a roll printer has no page
  break), and `ensureSpace()` becomes a no-op there.
- A4 / Letter / A5 output is unchanged.

Test: `supabase/functions/_shared/pdf/__tests__/paper-format_test.ts`
now asserts the media box is cropped for thermal presets and that
`newPage()` throws on continuous.

## 10. Phase T5 — ESC/POS ↔ PDF parity guardrail (2026-07-19)

Phases T2 (statutory hardening) and T3 (policy UI copy) shipped alongside
T1. T4 is a no-op: `src/services/printing/previewSurface.ts` opens the
already-generated PDF blob (no HTML re-render layer to keep in parity).

T5 closes the roadmap with an architecture test —
`supabase/functions/_shared/pdf/__tests__/escpos-parity_test.ts` — that
feeds a single `DocumentData` fixture through both `buildDocumentEscPos`
and `PdfBuilder` (80 mm continuous) and asserts each renderer succeeds
and preserves the document identifiers. Any future fork of the shared
model breaks this test before it can ship.



## 11 — Receipt card vs. transport artifact (Enerpize parity)

**Symptom reported by operator:** printing a POS sale on a laptop with no
thermal printer bound sent an 80mm-shaped PDF to Chrome's native print
dialog, producing a narrow strip with a tall blank tail on an A4 sheet.

**Root cause:** the fallback path (`ReceiptPreviewDialog.handlePrint` and
`PrintClient.print` with `fmt === 'pdf'`) rendered `pos_receipt` at its
policy paper (80mm) regardless of destination. Paper size was being
treated as a property of the document; it is a property of the *target
device*.

**Rule locked in:** the on-screen preview stays HTML (already true — the
dialog uses `TransactionSummaryView` + `MonospacePreview`, not a PDF
iframe). At the transport boundary the shape follows the destination:

- Thermal-bound → ESC/POS (unchanged).
- Sheet transport (browser print dialog / OS printer / no printer) →
  server PDF forced to A4.

**Implementation:**

- `generateDocumentPdf` accepts an optional `paperFormat` override, forwarded
  as `body.paperFormat` to `generate-document` (already honoured by the
  edge function).
- `ReceiptPreviewDialog.handlePrint` passes `paperFormat: 'a4'` on the
  no-thermal branch.
- `PrintClient.print` forces `paperFormat: 'a4'` whenever a `receipt` or
  `kitchen_ticket` intent resolves to the PDF transport. Non-receipt
  intents (`invoice`, `a4_document`, etc.) are untouched — their
  templates already render as sheets.
- `ReceiptPreviewDialog` gained an optional `onClone` prop so the sale
  can be duplicated from the completion dialog, matching the Enerpize
  Cancel / Clone / Print action bar.

**Guardrail:** `src/test/pos/receipt-transport-shape.test.ts` asserts:

1. Receipt intent + PDF fallback → `generateDocumentPdf` called with
   `paperFormat: 'a4'`.
2. Receipt intent + ESC/POS → no PDF is rendered.
3. Non-receipt PDF intents → no A4 override is injected.
