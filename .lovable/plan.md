# Payment Terms workstream — verification result and next phase

## Phase 1 — independent verification (done this session)

Every claim in the handover was checked against the live database and the source, not the notes.

Confirmed true:

- `businesses.default_payment_terms` no longer exists anywhere in the schema (0 columns named that in `public`). The drop migration is present.
- `resolve_payment_term(org, business, contact, override)` exists and implements exactly four tiers: document override -> `contacts.payment_term_id` -> business default (`is_default AND is_active`) -> no row (caller treats as due on receipt).
- The three `BEFORE INSERT` fill triggers exist and are enabled on `invoices`, `bills`, `sales_orders`, all calling `_fill_document_payment_term()`. The function returns early when `payment_term_id` is already set, so an explicit choice is never overwritten. (An earlier `information_schema.triggers` lookup returns nothing for these — the body lives in the function, not the trigger statement. They are real; `pg_trigger` confirms them.)
- `payment_term_id` exists on `contacts`, `invoices`, `bills`, `sales_orders`.
- Client code reaches resolution only through `src/services/finance/paymentTerms.ts`. `useBills.getDefaultDueDate` falls back to the bill date, not +30. Invoice create keeps the structured term in `payment_term_id` and leaves the `terms` textarea as prose.
- Snapshots freeze `{id,name,days}` for invoice, bill and sales order via `fetchPaymentTermSnapshot`.
- `bunx vitest run src/test/architecture/payment-term-single-source.test.ts src/test/documents` — 161 tests pass, including both architecture guards.

Nothing claimed complete was found to be fake or superficial. Phases 0-5 stand.

New gaps found during verification (not in the previous engineer's list):

1. **No uniqueness guard on the business default term.** Nothing prevents two `is_default AND is_active` rows for the same business. Today no business has more than one, so this is latent, but the resolver would then pick by `ORDER BY days` — a silent, arbitrary credit period. That is exactly the class of bug this workstream exists to kill.
2. **Historical invoices carry no term.** All 6 existing invoices have `payment_term_id IS NULL`; the fill trigger is insert-only. Their `due_date` is already correct and must not be touched, but the rows are unattributed for reporting.
3. **The party tier is configurable but unexercised.** `contacts.payment_term_id` is wired end to end (form, defaults fetch, resolver tier 2) yet zero contacts have one set. Worth confirming the customer/supplier UI actually persists it before declaring tier 2 proven.

## Phase 2 — work to do next, in order

### 1. DB-level invariant test (`supabase/tests/payment_terms_test.sql`)

Prove in the database, not in TypeScript:

- all four resolution tiers return the expected term, including the empty fourth tier;
- the fill trigger populates a null term on `invoices`, `bills`, `sales_orders`;
- the fill trigger never overwrites an explicit term;
- an inactive term is ignored at every tier;
- a term belonging to another organization is never resolved.

### 2. Single-default integrity

Add a partial unique index so a business can have at most one active default term, then confirm the resolver's `ORDER BY days` tie-break becomes unreachable.

### 3. Attribute historical documents

Backfill `payment_term_id` on existing invoices and bills **only where the stored `due_date` matches what the resolved term would have produced**. Where it does not match, leave the row null — a document's historical due date is truth and must not be rewritten to fit a term. Record the outcome.

### 4. Purchase-side parity decision (ADR, no schema change yet)

Write `docs/adr/` entry deciding whether a purchase order carries a commercial term or only inherits one at bill time, and the same for expenses. Neither table gets a column until the ADR is written down.

### 5. T&C prose ownership

`bills`, `sales_orders` and `delivery_notes` have no prose `terms` column. Decide and document: prose comes from the document template or the company default, never from the payment-term name.

## Technical notes

- Migrations only via the migration tool; the two schema items above (index, backfill) are one migration each so the backfill can be reviewed on its own.
- The architecture guard test already fails CI on any reintroduced credit-period constant; extend its banned-pattern list only if a new violation shape appears.
- Retirement rule stays in force: retired means deleted. No COALESCE onto a dropped field, no "keep it for old rows".

## Explicitly not changing

Accounting posting, AR/AP aging computation, tax, document snapshot format, and the existing `due_date` values on issued documents.
