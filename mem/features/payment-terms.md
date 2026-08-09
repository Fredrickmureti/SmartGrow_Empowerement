---
name: Payment terms, document T&C and notes
description: Three separate concepts, the resolve_payment_term cascade, fill-on-insert triggers, snapshot freezing, retired columns and the ban on hardcoded credit periods
type: feature
---

## Three distinct concepts — never merge them
1. **Payment term** — structured `payment_terms` row (name + days), referenced by `payment_term_id`. Drives `due_date` and AR/AP aging.
2. **Document terms & conditions** — legal prose in a `terms` text column.
3. **Document notes** — human message to the counterparty.

Never write a term name into a prose field; never parse prose to derive a due date.

## Resolution cascade — one resolver
`public.resolve_payment_term(org, business, contact, override)`:
document override -> party default (`contacts.payment_term_id`) -> company default (`payment_terms.is_default`) -> **due on receipt (0 days)**.

Client code reaches it only through `src/services/finance/paymentTerms.ts`.
**Banned:** any hardcoded credit period (`addDays(..., 30)` etc.). Unresolved term = due on receipt.
Guarded by `src/test/architecture/payment-term-single-source.test.ts`.

## Inheritance
`BEFORE INSERT` triggers (`_fill_document_payment_term`) on `invoices`, `bills`, `sales_orders` fill `payment_term_id` when null, so every conversion RPC and recurring run inherits. They never overwrite an explicit term and never rewrite historical `due_date`.

## Snapshots
`src/services/documents/snapshots/paymentTerm.ts` freezes `{id, name, days}` into document snapshots, so renaming a term never rewrites printed history. PDFs print a **Payment Terms** meta row; thermal receipts print a `Terms:` line — neither touches the T&C prose block.

## Retired — deleted, not deprecated
`businesses.default_payment_terms` (integer, default 30) was the root cause of the "30 days vs Net 20" bug and has been **dropped**. Do not reintroduce it, read it, or COALESCE onto it. General rule for this workstream: retired means deleted; a retired field used as a fallback recreates the bug.
