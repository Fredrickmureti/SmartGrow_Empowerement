# Commercial Terms / Payment Terms / Document Notes — authoritative status

Roadmap source: `.lovable/plan/commercial-terms-payment-terms-document-notes-domain-audit-c-2026-08-09.md`
Domain invariants: `mem/features/payment-terms.md`

## The three concepts (settled, do not re-merge)

1. **Payment term** — structured (`payment_terms` row: name + days). Drives `due_date` and AR/AP aging. Lives in `payment_term_id`.
2. **Document terms & conditions** — legal prose. Lives in the `terms` text column where a document has one.
3. **Document notes** — human message to the counterparty. Separate field.

A term *name* must never be written into a prose field, and prose must never be parsed to derive a due date.

## Resolution — one resolver only

`public.resolve_payment_term(org, business, contact, override)`:
document override -> party (customer/supplier) default -> company default (`payment_terms.is_default`) -> **due on receipt (0 days)**.

There is **no other legitimate source** for a credit period. No hardcoded net period is permitted anywhere, ever.

## Status by phase

| Phase | Scope | State |
|---|---|---|
| 0 | Separate payment term / T&C prose / notes | **Done, verified** |
| 1 | `resolve_payment_term` + single client seam `src/services/finance/paymentTerms.ts`; all `+30 day` fallbacks removed (invoice create, `useBills.getDefaultDueDate`, invoice CSV import) | **Done, verified live** (returns `Net 20 / 20 days`) |
| 2 | `bills.payment_term_id` added and persisted (the picker's value was previously discarded) | **Done, verified** |
| 3 | `BEFORE INSERT` triggers on `invoices`, `bills`, `sales_orders` fill `payment_term_id` when null, so every conversion RPC / recurring run inherits. Additive only: explicit terms and historical `due_date` untouched | **Done, verified** |
| 4 | Snapshot + render: `src/services/documents/snapshots/paymentTerm.ts` freezes `{id,name,days}`; invoice / bill / sales-order snapshots carry `payment_term`; PDF prints a **Payment Terms** meta row; thermal receipts print a `Terms:` line | **Done** — 159 document tests + typecheck pass |
| 5 | **Retire the legacy integer column** | **Done, this session** |

### Phase 5 detail (current session)

- `businesses.default_payment_terms` (integer, default 30) was the original source of the
  "30 days" bug. It is **DROPPED from the database** — not deprecated, not kept as a fallback.
  `contacts.default_payment_terms` did not exist; only the `businesses` one did.
- The settings audit trigger `audit_businesses_settings` was recreated without the retired
  column so the audit trail stays valid.
- Verified before dropping: zero application reads/writes, zero SQL functions, zero views depend on it.
- New guard `src/test/architecture/payment-term-single-source.test.ts` fails CI if
  (a) the retired identifier reappears anywhere in `src/`, or (b) a hardcoded net period
  (7/14/15/21/30/45/60/90 days) is used in due-date arithmetic. Quote validity
  (`valid_until`) and roster/report date ranges are deliberately out of scope.

**Retirement rule for every future agent:** when something is retired in this workstream it is
*deleted*. Do not leave it readable, do not COALESCE onto it, do not "keep it for old rows".
A retired field silently rehydrating is exactly how the original bug survived.

## Remaining / next milestone

Phase 5 closes the audit's original scope. Nothing in this workstream is partially implemented.

Optional hardening, in priority order, if this workstream is resumed:

1. **DB-level invariant test** — `supabase/tests/payment_terms_test.sql`: prove the cascade's four
   levels, prove the fill triggers never overwrite an explicit term, prove a document with no
   resolvable term gets `due_date = issue_date`.
2. **Purchase-side parity** — purchase orders and expenses have no `payment_term_id`. Decide
   (ADR) whether a PO carries a commercial term or only inherits it at bill time. Do not add the
   column until that decision is written down.
3. **T&C prose ownership** — `bills`, `sales_orders` and `delivery_notes` have no prose `terms`
   column. If those documents must print T&C, source it from the document template / company
   default, never from the term name.

## Instructions for the next agent

1. **Verify before you build.** Confirm: `businesses.default_payment_terms` no longer exists;
   `resolve_payment_term` still returns the company default for a business with one; the three
   `BEFORE INSERT` fill triggers exist on `invoices`, `bills`, `sales_orders`; and
   `bunx vitest run src/test/architecture/payment-term-single-source.test.ts src/test/documents`
   plus `tsgo --noEmit` are clean.
2. **Then resume at "Remaining / next milestone" item 1** — not unrelated work. Keep the order.
3. Never reintroduce a credit-period constant. Unresolved term = due on receipt.
