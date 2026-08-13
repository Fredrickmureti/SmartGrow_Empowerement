# Printing — Business Event → Template Coverage Matrix

Companion to `docs/printing-pipeline.md` and ADR-0086 (enterprise output
platform). Every printable artifact in the ERP must trace to (a) a
business event, (b) a canonical renderer, and (c) a template resolved
through the media / printer / template split defined in ADR-0087.

This document is the authoritative index of that mapping. A row without
a wired template is a follow-up ticket, not a silent absence.

## Legend

- **Renderer**
  - `PdfBuilder` — `supabase/functions/_shared/pdf` (accountantMono theme).
  - `Line[] AST` — `supabase/functions/_shared/escpos/renderLinesEscPos`
    fed by `documentToReceiptLines` (ADR-0084/0085).
  - `LabelDoc compiler` — `src/services/printing/labelCompiler.ts`
    dispatched by `labelDispatch.ts` (ADR-0088/0090).
- **Template source** — where the body lives. `label_templates` rows are
  seeded by `seed_default_label_templates()`; A4 documents use
  `document_templates` + `PdfBuilder` components.
- **Status**
  - `WIRED` — end-to-end path exists and is exercised by tests.
  - `PARTIAL` — renderer exists, template seeded, but no default binding
    from the event to `printDocument(...)` yet.
  - `GAP` — no template or no renderer for this event.

## Labels (thermal / small-format media)

| Business event | Kind | `template_key` | Renderer | Status |
|---|---|---|---|---|
| Product create / republish | product | `product_label` | LabelDoc compiler | WIRED |
| Shelf reprice | shelf | `shelf_label` | LabelDoc compiler | WIRED |
| Lot / batch create | lot | `lot_label` | LabelDoc compiler | WIRED |
| Bin / location create | bin | `bin_label` | LabelDoc compiler | WIRED |
| Receiving / GRN posted | receiving | `receiving_label` | LabelDoc compiler | WIRED (thermal label on receipt; A4 `goods_receipt` bound in `GoodsReceiptWizardPage`) |
| Pallet built (WMS) | pallet | `pallet_label` | LabelDoc compiler | WIRED |
| Shipment dispatched | shipping | `shipping_label` | LabelDoc compiler | WIRED |
| Asset tag issued | asset | `asset_label` | LabelDoc compiler | WIRED (Fixed-Assets → row action, Wave 21) |
| Cycle-count sheet header | count | `count_label` | LabelDoc compiler | WIRED (Warehouse count session header, Wave 21) |
| Return / RMA tag | return | `return_label` | LabelDoc compiler | WIRED (Sales Returns → row action, Wave 21) |

## Receipts (thermal roll — 58 / 80 mm)

All receipts share the canonical `documentToReceiptLines` producer and
are printed via `renderLinesEscPos` (bytes) or `renderThermalPdf` (PDF).

| Business event | DocumentData kind | Renderer | Status |
|---|---|---|---|
| POS sale committed | `pos_receipt` | Line[] AST | WIRED |
| POS return / refund | `pos_return_receipt` | Line[] AST | WIRED |
| Customer payment received | `customer_payment_receipt` | Line[] AST | WIRED |
| Vendor payment issued | `vendor_payment_receipt` | Line[] AST | WIRED |
| Kitchen ticket | `kitchen_ticket` | Line[] AST (kitchen block) | WIRED |
| X / Z fiscal reports | `pos_fiscal_report` | Line[] AST | WIRED |
| Cash-drawer float open/close | `drawer_slip` | Line[] AST | WIRED (auto-print on every `pos_cash_movements` insert via `usePOSCashDrawer` → `drawer_slip` short-circuit in `generate-document`; fire-and-forget so an offline printer never blocks the movement) |

## A4 documents (`generate-document` → `PdfBuilder`)

| Business event | DocumentData kind | Renderer | Status |
|---|---|---|---|
| Sales invoice | `invoice` | PdfBuilder | WIRED |
| Sales order | `sales_order` | PdfBuilder | WIRED |
| Estimate / quote | `estimate` | PdfBuilder | WIRED |
| Delivery note | `delivery_note` | PdfBuilder | WIRED |
| Credit note | `credit_note` | PdfBuilder | WIRED |
| Proforma invoice | `proforma_invoice` | PdfBuilder | WIRED |
| Customer statement | `customer_statement` | PdfBuilder | WIRED |
| Vendor statement | `vendor_statement` | PdfBuilder | WIRED |
| Purchase order | `purchase_order` | PdfBuilder | WIRED |
| Bill (vendor invoice) | `bill` | PdfBuilder | WIRED |
| Purchase return | `purchase_return` | PdfBuilder | WIRED |
| Sales return | `sales_return` | PdfBuilder | WIRED |
| Payslip | `payslip` | PdfBuilder (statutory-pinned) | WIRED |
| Employee tax certificate (P9 / eq.) | `tax_certificate` | PdfBuilder (statutory-pinned) | WIRED |
| Statutory return (PAYE/NSSF/NHIF/SHIF/HL) | `statutory_return` | PdfBuilder (statutory-pinned) | WIRED |
| Audit / investigation certificate | `audit_certificate` | PdfBuilder (statutory-pinned) | WIRED |
| GRN / receiving voucher (A4 copy) | `goods_receipt` | PdfBuilder | WIRED (auto-dispatch from `GoodsReceiptWizardPage` via `printOrPreview({ intent: 'a4_document' })`; policy resolved by ADR-0088) |
| Journal entry posted / reviewed (journal voucher) | `journal_entry` | PdfBuilder (`journal_voucher` ledger layout) | WIRED (snapshot pipeline — `finance.journal_entry` document kind; Preview/Print/Download from `useJournalEntryActions`; no `email` intent) |
| Landed cost voucher allocated / posted | `landed_cost_voucher` | PdfBuilder (`landed_cost_voucher` ledger layout) | WIRED (snapshot pipeline — `purchases.landed_cost_voucher` document kind; Preview/Print/Download from `useLandedCostActions`; no `email` intent — internal costing evidence) |
| Stock adjustment voucher | `stock_adjustment` | PdfBuilder | WIRED (Wave 21 — `fetchStockAdjustment`) |
| Stock transfer note | `stock_transfer` | PdfBuilder | WIRED (Wave 21 — `fetchStockTransfer`) |
| Vendor return note (A4) | `vendor_return` | PdfBuilder | WIRED (Wave 21 — `fetchPurchaseReturn`; alias `purchase_return`) |
| Cycle count sheet | `count_sheet` | PdfBuilder | WIRED (ADR 0106 — `fetchCountSheet`; dispatched from `CountSession`/`CountReview` via `CountDocumentsMenu` → `printDocument({ intent: 'a4_document' })`) |
| Cycle count sheet (blind) | `count_sheet_blind` | PdfBuilder | WIRED (ADR 0106 — `fetchCountSheetBlind`; separate fetcher, never a flag, so expected quantity cannot leak onto a blind sheet) |
| Cycle count difference report | `count_variance_report` | PdfBuilder | WIRED (ADR 0106 — `fetchCountVarianceReport`; latest attempt per line, reason code + approver) |
| Cycle count audit report | `count_audit_report` | PdfBuilder | WIRED (ADR 0106 — `fetchCountAuditReport`; every attempt and recount round, counter and approver identity) |
| Bill of lading | `bill_of_lading` | PdfBuilder | WIRED (ADR 0110 — `fetchBillOfLading`; dispatched from `LoadingBay` via `DispatchDocumentsMenu` → `printDocument({ intent: 'a4_document' })`) |
| Dispatch manifest (load sheet) | `dispatch_manifest` | PdfBuilder | WIRED (ADR 0110 — `fetchDispatchManifest`; carton-by-carton internal load sheet) |
| Packing list | `packing_list` | PdfBuilder | WIRED (ADR 0110 — `fetchPackingList`; per sales order, travels with the goods) |
| Carrier label | `carrier_label` | Line[] AST / label | WIRED (ADR 0110 — `fetchCarrierLabel`; requested with `intent: 'label'`, barcode is the allocated tracking number — rendering never mints one) |
| Wave pick list | `wave_pick_list` | PdfBuilder | WIRED (ADR 0112 — `fetchWavePickList`; dispatched from the wave tower via `WaveDocumentsMenu` → `printDocument({ intent: 'a4_document' })`; walk order from released pick tasks, wave lines before release) |
| Wave summary | `wave_summary` | PdfBuilder | WIRED (ADR 0112 — `fetchWaveSummary`; supervisor release sheet: demand per order, task progress, readiness verdict) |


## Cross-cutting invariants

1. **Single entry point.** Every event above prints via
   `printDocument` / `printDocumentIntent` from
   `@/services/printing/PrintService` (ADR-0026, as amended by ADR-0084/0085).
   No page invokes a render endpoint directly; no page hand-
   rolls PDF bytes (`no-raw-pdf-lib-in-app` ESLint rule).
2. **Media geometry lives in `media_profiles`.** Templates carry no
   `^PW`/`^LL` / `q,Q` / paper-size string — the dispatcher injects the
   envelope from the resolved media profile (ADR-0088).
3. **Printer capability lives in `printer_profiles`.** `command_language`,
   `dpi`, `margins_mm`, and `supported_media_ids` drive dispatch. Drivers
   never read `device_assignments.config` for capability data.
4. **Statutory paper is pinned.** Rows tagged "statutory-pinned" call
   `assertStatutoryPaper("a4")` so a misconfigured policy cannot produce
   a non-compliant filing (ADR-0008).

## Follow-up tickets (GAPs)

- ~~Promote the drawer-slip receipt from on-demand to auto-print on
  cash movements~~ — **WIRED (this turn)**. `usePOSCashDrawer.onSuccess`
  now dispatches `printDocumentIntent({ intent: 'receipt', documentType:
  'drawer_slip' })` for every `pos_cash_movements` row. The
  `generate-document` edge function renders via `_shared/escpos/drawer.ts`
  (SOX/PCI audit slip: cashier, timestamp, movement type, amount,
  reason, manager override id, signature line). Fire-and-forget so a
  disconnected printer never aborts a cash movement; auditors can
  reconcile the paper trail against `pos_cash_movements` by movement id.
  Still deferred: automatic slip on `pos_drawer_events` no-sale opens
  (the RPC that writes those rows doesn't exist yet); design once the
  domain event bus emits `drawer:opened` on manual-open contexts.
- ~~Promote `grn` from "data path exists" to a bound A4 event~~ —
  **WIRED (prior turn)**. `GoodsReceiptWizardPage.tsx` dispatches
  `printOrPreview({ documentType: 'goods_receipt', intent: 'a4_document' })`
  after a successful post; policy resolved by ADR-0088.


When any of these ship, flip the row's status to `WIRED` in the same PR
that adds the ESLint / architecture test proving it.
