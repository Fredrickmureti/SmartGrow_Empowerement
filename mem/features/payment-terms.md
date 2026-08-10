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

## Integrity guards
Partial unique index `payment_terms_one_active_default_per_business`: at most one active default term per business, so tier 3 can never tie-break arbitrarily.
DB-level proof of the cascade, the fill triggers and due-on-receipt lives in `supabase/tests/payment_terms_test.sql`.

## Which documents own a term (ADR 0020)
Only documents that create an obligation with a due date: invoices, bills, sales orders (plus `contacts` as the party default). Purchase orders, expenses, estimates, credit notes and delivery notes deliberately have **no** `payment_term_id` — the purchase side resolves at bill time (`supplier -> bill`, not `supplier -> PO -> bill`). T&C prose for documents lacking a `terms` column comes from the document template, never from the term name.

## Historical documents
Backfilling a term onto an already-issued document is allowed **only** when its stored `due_date` already equals date + term days. Legacy invoices with a 30/31-day gap (from the retired default) keep a NULL term rather than being relabelled Net 20 — a due date on an issued document is truth.

## Retired — deleted, not deprecated
`businesses.default_payment_terms` (integer, default 30) was the root cause of the "30 days vs Net 20" bug and has been **dropped**. Do not reintroduce it, read it, or COALESCE onto it. General rule for this workstream: retired means deleted; a retired field used as a fallback recreates the bug.

