# Project Memory

## Core
Receivables/payables come only from finance_ar/ap_open_items, and they must net credit-note applications, not just cash.
Invoice payability = posted document with residual > 0, never a status string. 'sent' is the only post-confirm status.
Document scanning is one shared layer (DocumentLineScanner + useDocumentLineScan + DocumentScanProvider); purchasing lines seed at cost price.
Sales order fulfilment/billing progress is read from so_line_balances only — never re-sum SO, DN, or invoice lines in app code.
Sales order create/edit/cancel/confirm/approve/invoice are DB RPCs; the client never writes sales_orders status, totals, or line deletes directly.
Delivery note status/dates/deletion are DB-owned (atomic RPCs only); clients edit descriptive fields only and must FK-hint contacts embeds.

## Memories
- [Open items & payability](mem://features/open-items-and-payability) — AR/AP projection settlement channels, payability predicate, invoice status vocabulary
- [Customer payment allocations](mem://features/customer-payment-allocations) — ADR 0027 allocation-first payments, customer ledger SoT
- [Document scanning layer](mem://features/document-scanning-layer) — shared scanner across Sales/Purchases, cost-vs-selling price rule, requisition exclusion, import-based guards
- [Sales order lifecycle](mem://features/sales-order-lifecycle) — status vocabulary, atomic creation, DB-owned cancellation, quantity ledger, FX capture, the two invoicing routes
- [Delivery note lifecycle](mem://features/delivery-note-lifecycle) — engine-owned status columns, atomic create/cancel, business-scoped numbering, dual contacts FK embeds
