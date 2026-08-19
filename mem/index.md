# Project Memory

## Core
Currency is stored as an ISO code `text` everywhere; `resolve_exchange_rate` / `require_exchange_rate` are the only FX authorities (ADR 0135/0136).
One client FX lookup: `@/services/fx/rateBook` — display only, missing rate is `null` and renders `—`; never 1:1, never a rate literal (ADR 0136).
Every purchasing document keys `vendor_id → contacts.id` (party), never `suppliers.id` (role) — ADR-0079.
`post_journal_entry_atomic` is the only writer of journal rows (ADR 0123) and the only journal numberer — callers/clients pass a NULL entry number (ADR 0146).
Cost layers are the single valuation truth; AVCO is always derived from them, never computed independently.
Year-segmented document numbers parse the trailing counter segment only, under a per-org advisory lock.
Project status lives in `.lovable/plan.md`; verify prior work before continuing.

## Memories
- [Currency & FX](mem://features/currency-and-fx-resolution) — one rate book + precedence, provider publisher, document rate snapshots, realized FX at settlement, single client lookup
- [Supplier / vendor master](mem://features/supplier-vendor-master) — party vs role, purchasability gate, RPC-only supplier writes, Supplier 360
- [Salesperson performance](mem://features/salesperson-performance) — canonical projection and attribution rules
- [Journal Voucher](mem://features/journal-voucher) — finance.journal_entry printing pipeline, action parity, draft stamping
- [Vendor statement engine](mem://features/vendor-statement-engine) — AP ledger source, atomic upsert, durable send queue, download vs print, statement template routing
- [Banking domain](mem://features/banking-domain) — bank account seam RPCs + lifecycle, single statement ingestion engine (fingerprint, rules, period/lifecycle gates), and the server-owned reconciliation lifecycle + arithmetic

- [Supplier purchasing terms](mem://features/supplier-purchasing-terms) — conditions owned by supplier_item_terms; server price/tier/MOQ authorities, governed writes, PO price provenance
- [WMS handling units](mem://features/wms-handling-units) — plate vs product packaging, mandatory row_version on every plate RPC, server-side UoM conversion, container capacity policy, quantity display seam
- [Sales fulfilment warehouse](mem://features/sales-fulfilment-warehouse) — warehouse_id recorded on SO/invoice/DN, resolve_sales_warehouse authority, warehouse-scoped availability seam
- [Sale-time tax](mem://features/sales-sale-time-tax) — resolve_sales_line_tax single authority, document-dated rates, validated line/free-text rates, tax_rate_id audit snapshot, preview-only client seam
- [Document numbering](mem://features/document-numbering) — trailing-counter parse, advisory locks, immutable numbers on posted documents
- [Landed cost across warehouses](mem://features/landed-cost-warehouse-behaviour) — warehouse-scoped layers, lineage tracing, reversal inventory/COGS split, merged-layer spread
