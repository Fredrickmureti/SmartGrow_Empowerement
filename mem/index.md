# Project Memory

## Core
Receivables/payables come only from finance_ar/ap_open_items, and they must net credit-note applications, not just cash.
Invoice payability = posted document with residual > 0, never a status string. 'sent' is the only post-confirm status.
Document scanning is one shared layer (DocumentLineScanner + useDocumentLineScan + DocumentScanProvider); purchasing lines seed at cost price.
Sales order fulfilment/billing progress is read from so_line_balances only — never re-sum SO, DN, or invoice lines in app code.
Sales order create/edit/cancel/confirm/approve/invoice are DB RPCs; the client never writes sales_orders status, totals, or line deletes directly.
Delivery note status/dates/deletion are DB-owned (atomic RPCs only); clients edit descriptive fields only and must FK-hint contacts embeds.
Every settlement RPC takes a request key derived from the payment intent — never crypto.randomUUID(); one customer money-in dialog only.
Credit notes: money and the per-invoice-line credit ceiling are resolved server-side from the invoice; clients never write credit_notes/credit_note_items.
Open items sum `base_residual_amount` (currency-converted), never raw `residual_amount`; aging takes an explicit as-of date.
Collections overlays (collector, dunning level, promise-to-pay) are server-derived from finance_ar_net_position — never computed in the browser.
Customer/vendor statements project ONE dataset folded from customer_ledger_entries / vendor_ledger_entries (screen, PDF, CSV, email); never re-derive from source documents.
contacts has NO contact_type column — customer selection = type in (customer,both) OR customer_rank > 0, via services/finance/customerIdentity.ts.
Customer balance = Σ(debit − credit) over customer_ledger_entries. No doc_type switch, no clamps — reversals and journals count.
Salesperson metrics come only from get_salesperson_performance; attribution inherits from the invoice, never from created_by.
Treasury ids (bank_accounts.id) and GL ids (accounts.id) are distinct: settlement RPCs take _bank_account_id AND _credit_account_id separately.



## Memories
- [Collections & open-items invariants](mem://features/collections-open-items) — currency-aware projections, as-of aging, statement idempotency, single email/activity ledger
- [Collections overlays](mem://features/collections-overlays) — dunning ladder view, promise-to-pay RPCs/idempotency, server-owned kept/broken evaluation, AR disputes (never reduce AR, pause dunning), SQL-scored collections work queue
- [Open items & payability](mem://features/open-items-and-payability) — AR/AP projection settlement channels, payability predicate, invoice status vocabulary
- [Customer payment allocations](mem://features/customer-payment-allocations) — ADR 0027 allocation-first payments, customer ledger SoT
- [Vendor payment allocations](mem://features/vendor-payment-allocations) — ADR 0028 allocation-first AP, supplier advances (record vs apply accounting), vendor_unapplied_advances SoT
- [Money-in idempotency](mem://features/money-in-idempotency) — settlement request keys, client_request_id unique indexes, the single RecordCustomerPaymentDialog

- [Document scanning layer](mem://features/document-scanning-layer) — shared scanner across Sales/Purchases, cost-vs-selling price rule, requisition exclusion, import-based guards
- [Sales order lifecycle](mem://features/sales-order-lifecycle) — status vocabulary, atomic creation, DB-owned cancellation, quantity ledger, FX capture, the two invoicing routes
- [Delivery note lifecycle](mem://features/delivery-note-lifecycle) — engine-owned status columns, atomic create/cancel, business-scoped numbering, dual contacts FK embeds
- [Sales return tax basis](mem://features/sales-return-tax-basis) — invoice-line tax/discount/eTIMS snapshot on returns, document-level rounding, credit note as sole fiscal exit
- [Credit note provenance](mem://features/credit-note-provenance) — invoice_item_id lineage, v_invoice_creditable_qty ceiling, server-resolved money, idempotency, draft-only edits
- [Payment terms](mem://features/payment-terms) — resolve_payment_term cascade, fill-on-insert triggers, snapshot freezing, one-default-per-business index, ADR 0020 document ownership, historical backfill rule, no hardcoded credit periods
- [Customer statement engine](mem://features/customer-statement-engine) — AR+AP ledger-sourced datasets, mirrored builders, period-end aging, retired raw-table/fallback paths
- [Contact identity vocabulary](mem://constraints/contact-identity-vocabulary) — contacts.type vs the contact_type enum name, customer_rank, commercial_partner_id family rollup
- [Salesperson performance](mem://features/salesperson-performance) — server projection + drill-down RPCs, invoice-inherited attribution, POS de-duplication, metric source table
- [Sales Overview cockpit](mem://features/sales-overview-cockpit) — dashboard RPC is a projection: net-position receivables/aging, allocation-based cash, so_line_balances fulfilment, converted quotes count as won
