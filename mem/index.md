# Project Memory

## Core
Receivables/payables come only from finance_ar/ap_open_items, and they must net credit-note applications, not just cash.
Invoice payability = posted document with residual > 0, never a status string. 'sent' is the only post-confirm status.
Document scanning is one shared layer (DocumentLineScanner + useDocumentLineScan + DocumentScanProvider); purchasing lines seed at cost price.

## Memories
- [Open items & payability](mem://features/open-items-and-payability) — AR/AP projection settlement channels, payability predicate, invoice status vocabulary
- [Customer payment allocations](mem://features/customer-payment-allocations) — ADR 0027 allocation-first payments, customer ledger SoT
- [Document scanning layer](mem://features/document-scanning-layer) — shared scanner across Sales/Purchases, cost-vs-selling price rule, requisition exclusion, import-based guards

