# Project Memory

## Core
Receivables/payables come only from finance_ar/ap_open_items, and they must net credit-note applications, not just cash.
Invoice payability = posted document with residual > 0, never a status string. 'sent' is the only post-confirm status.

## Memories
- [Open items & payability](mem://features/open-items-and-payability) — AR/AP projection settlement channels, payability predicate, invoice status vocabulary
- [Customer payment allocations](mem://features/customer-payment-allocations) — ADR 0027 allocation-first payments, customer ledger SoT
