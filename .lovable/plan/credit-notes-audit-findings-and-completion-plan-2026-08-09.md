# Credit Notes — Audit Findings and Completion Plan

## A. What the previous engineer actually left behind (verified)

Verified by reading the live source and querying the live database.

**Fully in place (keep)**
- `useInvoiceCreditableLines.ts` exists, loads `invoice_items` for one invoice, and computes a net unit price from `discount_percent`, carrying `tax_rate`, packaging/UoM.
- `InvoiceLineCreditPicker.tsx` exists, caps typed quantity at the invoiced quantity (`Math.min(value, line.invoiced_qty)`).
- `PricedLineRow` has a `lockedCells` prop; `CreditNoteCreatePage` (the real `/sales/credit-notes/new` route) wires all three together.
- `creditReasonOptions.ts` exists with the neutral reason list plus "Other".

**Partially complete**
- Provenance is UI-only *by construction*: the create page holds `source_invoice_item_id` on each line and then calls `stripProvenance(...)` before submitting, because `credit_note_items` has no such column (confirmed against the live schema).
- The reason dropdown exists only on the create page. The edit page and the returns-driven credit path do not share it.

**Not implemented**
- No durable invoice-line link, no credit ceiling, no creditable-quantity ledger (Returns has `v_sales_returnable_qty`; credit notes have no analogue).
- No idempotency key on credit-note creation.

**Incorrect / unsafe**
- `create_credit_note_atomic(_payload jsonb)` is `SECURITY DEFINER` and trusts the client for `quantity`, `unit_price`, `tax_rate`, `tax_amount`, `line_total`. Header totals are just the sum of client numbers.
- It checks `user_can_access_business` but never checks that `invoice_id` belongs to that business or to the stated contact. Because it is `SECURITY DEFINER`, RLS does not catch this: a crafted request can attach another business's invoice as lineage.
- `CreditNoteEditPage` writes `credit_notes` and does a raw `delete` + `insert` on `credit_note_items` directly from the browser, bypassing the single-writer rule in ADR 0131.

## B. Bugs found

| # | Severity | Issue | Impact |
|---|---|---|---|
| 1 | Critical | No server credit ceiling | Ten invoiced units can be credited 5 + 6 = 11. Revenue, VAT and AR are over-reversed. |
| 2 | Critical | Server trusts client line money | A forged request credits any amount/tax at any price regardless of what was invoiced. |
| 3 | Critical | `invoice_id` not authorised or coherence-checked | Cross-business/cross-customer lineage; leaks the existence of foreign invoices. |
| 4 | High | No durable `invoice_item_id` | "From INV-…" is a screenshot, not a fact. Lineage questions cannot be answered from the database. |
| 5 | High | Client-side edit of credit-note lines | Post-create edits skip every server invariant; needs status gating and a server writer. |
| 6 | Medium | No idempotency key | Double click or retry creates two economically real credit notes. |
| 7 | Medium | Reason dropdown not on every credit-creation surface | Free-text reasons still enter the audit trail from the edit page. |

## C. Architecture verdict

Partially sound. The document, posting (`post_journal_entry_atomic`), customer-credit-movement and fiscal-enqueue layers are correct and stay untouched. The *provenance and control* layer is absent: today the credit note is an arbitrary negative document that merely displays an invoice reference. The previous work made the UI safer; it did not make the domain authoritative.

## D. Work to do

**1. Schema (migration)**
- `credit_note_items.invoice_item_id uuid REFERENCES invoice_items(id)`, indexed; plus historical snapshot columns captured at creation: `source_unit_price`, `source_discount_percent`, `source_tax_rate`, `source_line_currency`. Nullable throughout — an off-invoice line simply has no link.
- `credit_notes.client_request_id text` with a unique partial index per business for idempotent creation.
- Check constraint: a line with `invoice_item_id` must belong to an invoice line of the credit note's `invoice_id` (enforced in the writer, since the column is on the child).
- New view `v_invoice_creditable_qty`: invoiced qty minus qty already credited by non-void credit notes, per invoice line — the credit-side analogue of `v_sales_returnable_qty`, but returning remaining quantity *and* remaining net amount.

**2. Server writer (`create_credit_note_atomic`)**
- Validate that `invoice_id`, when present, belongs to the caller's business and to the stated `contact_id`; reject otherwise.
- For a line carrying `invoice_item_id`: ignore all client money. Resolve description, unit price, discount, tax rate and tax basis from `invoice_items`, compute the credited amounts from the requested quantity, and reject when the requested quantity exceeds the remaining creditable quantity from the view (`FOR UPDATE` on the invoice to serialise concurrent credits).
- For a line without `invoice_item_id`: accept it as an explicit off-invoice adjustment, still recomputing `line_total`/`tax_amount` server-side from quantity, price and rate rather than trusting them.
- Idempotency: same `client_request_id` returns the existing credit note instead of creating a second.
- Same ceiling and coherence checks applied on any line rewrite.

**3. Edit path**
- New `update_credit_note_atomic` server writer; the edit page stops writing `credit_notes`/`credit_note_items` directly. Only `draft` credit notes are editable; issued ones are read-only server-side.

**4. Frontend**
- Stop stripping provenance: submit `invoice_item_id` and the requested quantity; let the server return the authoritative money and re-render from it.
- Picker shows *remaining creditable* quantity per line (from the new view), not the originally invoiced quantity, and disables fully credited lines.
- Off-invoice lines get an explicit, visible mode so the operator knows which path they are on; the goodwill/service credit flow stays fully available with no invoice at all.
- Reason dropdown + detail field shared by create and edit through one component.

**5. Tests and guards**
- SQL tests: ceiling across multiple partial credits, discounted invoice credited at historical net, tax-rate change on the product not affecting an older invoice credit, foreign-invoice rejection, duplicate `client_request_id`, issued-note edit rejection.
- Architecture guard extending `compensation-writer-monopoly.test.ts`: no direct client writes to `credit_note_items`.
- Frontend tests for the picker's remaining-quantity behaviour and the wire payload shape.

**6. Verification before completion**
Run the six business events end to end against the live database (full credit, partial, multiple partials hitting the ceiling, discounted invoice, historical tax change, off-invoice service credit), plus unauthorised invoice reference and duplicate submit, and report actual query results — not typecheck.

## E. Explicitly out of scope
No inventory coupling: stock only ever moves through `sales_returns` via `source_return_id` (ADR 0131). Posting stays with `post_journal_entry_atomic`. Refunds stay with `refund_customer_atomic`.

## F. Known risk
Existing credit-note rows have no `invoice_item_id`, so historical credits do not consume the new ceiling. The ceiling will be enforced from the migration forward; a backfill by description/price match would be guesswork and is deliberately not attempted.
