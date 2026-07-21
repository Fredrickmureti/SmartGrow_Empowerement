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
    from the event to `PrintClient.print(...)` yet.
  - `GAP` — no template or no renderer for this event.

## Labels (thermal / small-format media)

| Business event | Kind | `template_key` | Renderer | Status |
|---|---|---|---|---|
| Product create / republish | product | `product_label` | LabelDoc compiler | WIRED |
| Shelf reprice | shelf | `shelf_label` | LabelDoc compiler | WIRED |
| Lot / batch create | lot | `lot_label` | LabelDoc compiler | WIRED |
| Bin / location create | bin | `bin_label` | LabelDoc compiler | WIRED |
| Receiving / GRN posted | receiving | `receiving_label` | LabelDoc compiler | WIRED |
| Pallet built (WMS) | pallet | `pallet_label` | LabelDoc compiler | WIRED |
| Shipment dispatched | shipping | `shipping_label` | LabelDoc compiler | WIRED |
| Asset tag issued | asset | `asset_label` | LabelDoc compiler | WIRED (template seeded; page dispatch pending) |
| Cycle-count sheet header | count | `count_label` | LabelDoc compiler | WIRED (template seeded; page dispatch pending) |
| Return / RMA tag | return | `return_label` | LabelDoc compiler | WIRED (template seeded; page dispatch pending) |

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
| Cash-drawer float open/close | `drawer_slip` | Line[] AST | PARTIAL — printed on demand only |

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
| Purchase order | `purchase_order` | PdfBuilder | WIRED |
| Bill (vendor invoice) | `bill` | PdfBuilder | WIRED |
| Purchase return | `purchase_return` | PdfBuilder | WIRED |
| Sales return | `sales_return` | PdfBuilder | WIRED |
| Payslip | `payslip` | PdfBuilder (statutory-pinned) | WIRED |
| Employee tax certificate (P9 / eq.) | `tax_certificate` | PdfBuilder (statutory-pinned) | WIRED |
| Statutory return (PAYE/NSSF/NHIF/SHIF/HL) | `statutory_return` | PdfBuilder (statutory-pinned) | WIRED |
| Audit / investigation certificate | `audit_certificate` | PdfBuilder (statutory-pinned) | WIRED |
| GRN / receiving voucher (A4 copy) | `grn` | PdfBuilder | PARTIAL — data path exists, no default policy |
| Stock adjustment voucher | `stock_adjustment` | PdfBuilder | GAP |
| Stock transfer note | `stock_transfer` | PdfBuilder | GAP |
| Vendor return note (A4) | `vendor_return` | PdfBuilder | GAP |

## Cross-cutting invariants

1. **Single entry point.** Every event above prints via
   `PrintClient.print({ documentType, documentId, intent })`
   (ADR-0026). No page calls `generate-document` directly; no page hand-
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

- `asset_label` / `count_label` / `return_label` are now seeded (migration
  2026-07-21). Remaining work: add `PrintClient.print(...)` call sites in
  Fixed-Assets, Warehouse cycle-count, and Sales-return pages plus an
  architecture test asserting each page imports `printClient`.
- Add `document_templates` rows and `generate-document` fetchers for
  `stock_adjustment`, `stock_transfer`, and `vendor_return` so
  Inventory / Warehouse A4 vouchers stop rendering through page-local
  HTML printing.
- Promote the drawer-slip receipt from an on-demand action to an
  automatic print policy on open/close events.

When any of these ship, flip the row's status to `WIRED` in the same PR
that adds the ESLint / architecture test proving it.