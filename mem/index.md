# Project Memory

## Core
Currency is stored as an ISO code `text` everywhere; `resolve_exchange_rate` / `require_exchange_rate` are the only FX authorities (ADR 0135/0136).
One client FX lookup: `@/services/fx/rateBook` — display only, missing rate is `null` and renders `—`; never 1:1, never a rate literal (ADR 0136).
Every purchasing document keys `vendor_id → contacts.id` (party), never `suppliers.id` (role) — ADR-0079.
`post_journal_entry_atomic` is the only writer of journal rows (ADR 0123).
Project status lives in `.lovable/plan.md`; verify prior work before continuing.

## Memories
- [Currency & FX](mem://features/currency-and-fx-resolution) — one rate book + precedence, provider publisher, document rate snapshots, realized FX at settlement, single client lookup
- [Supplier / vendor master](mem://features/supplier-vendor-master) — party vs role, purchasability gate, RPC-only supplier writes, Supplier 360
- [Salesperson performance](mem://features/salesperson-performance) — canonical projection and attribution rules