# Commercial Compensation Architecture — Credit Notes, Customer Credit, Refunds

## What I verified this turn (live database + source)

- `get_next_credit_note_number(_org_id)` reads `credit_note_prefix` from `public.organizations`. That column **does not exist** on `organizations` (full column list checked), and no `credit_note_prefix` exists on `businesses` either (only `invoice_prefix`, `estimate_prefix`, `bill_prefix`). Every call aborts with an undefined-column error, surfacing as HTTP 400. That is the whole visible failure — but it is a symptom: this is the only document sequence in the platform that is org-scoped, unlocked and blind to business isolation, while the canonical pattern (`get_next_invoice_number`) requires `business_id`, takes an advisory lock, and reads the prefix from `businesses`.
- `credit_notes` holds 0 rows, so nothing has ever been issued end to end.
- Compensation is spread across **three competing writers**: `confirm_credit_note_atomic` + `process_refund_atomic` (JE lines built in the browser by `buildCreditNoteJELines` / `buildRefundJELines`; the refund updates `credit_notes.refund_amount` and never creates a `customer_refunds` row), `refund_customer_atomic` (server-built JE, does create `customer_refunds`, drains customer deposits or AR by source), and `issue_credit_note_for_payment_atomic`. Two refund engines, two refund records, two GL shapes.
- Customer credit is **not modelled**: there is no `customer_credits` table. `useCustomerCredits` derives credit as `credit_notes.total - amount_applied`, and whether that credit sits in AR or in Customer Deposits is decided **client-side** from the invoice's paid status. The same economic balance lands in two different accounts depending on a browser check, which the GL-anchored aging/partner-ledger engine (ADR 0033) cannot reconcile.
- `createCreditNote` inserts from the browser, then performs an "insert as issued → force back to draft → issue" dance; account mappings are resolved client-side, so a missing mapping fails after the row already exists.
- `resolve_reversal_intent` already recommends credit note / refund / reverse payment for a settled invoice, so the recommendation surface is right — the documents behind it are not.

## Enterprise position (what the architecture must express)

A credit note is a **legally numbered commercial document that reduces the receivable and the tax base**. It is not a payment, and by itself it moves neither cash nor stock. Settling it is a separate decision with exactly three outcomes: applied to an open invoice, held as customer credit (a liability), or refunded (cash out). Inventory participates only when a goods-return document exists. Mature ERPs keep these three concerns separate; this platform currently fuses them.

## Plan

### Phase 1 — Numbering under the canonical rule
Replace `get_next_credit_note_number` with the business-scoped, advisory-locked form used by invoices: `(_org_id, _business_id, _branch_id)`, prefix from a new `businesses.credit_note_prefix` (default `CN-`), sequence scoped per business. Same treatment for `get_next_vendor_credit_note_number`. Hooks pass business context. This removes the 400 and the multi-company collision together.

### Phase 2 — One creation/issue writer, server-side
Add `create_credit_note_atomic` (header + lines + number in one transaction) and move issue/refund JE line construction **into the database**, resolved from `default_account_settings`: no `buildCreditNoteJELines` / `buildRefundJELines` in the browser, no draft/issue round trip, no half-created notes. Posting still goes through `post_journal_entry_atomic` (ADR 0123).

### Phase 3 — Customer credit becomes a real balance
Introduce `customer_credit_balances` + `customer_credit_movements` (issue, apply, refund, expire), always posted to the customer-credit **liability** account, never AR. A credit note against a settled invoice credits this balance; applying it to a later invoice consumes it FIFO; refunding drains it. `useCustomerCredits` reads the balance instead of deriving one, so statements, aging and trial balance agree.

### Phase 4 — One refund engine
`refund_customer_atomic` becomes the single refund writer for both sources (payment and credit note); `process_refund_atomic` is retired, not kept as a fallback. Every refund produces a `customer_refunds` row, a bank-side JE and an accounting event, idempotent by `client_request_id`.

### Phase 5 — Inventory and tax boundaries made explicit
`credit_notes.source_return_id` becomes the only trigger for stock and COGS reversal: no return document, no stock movement. Tax reduction follows the credit note's document date, not the refund, and continues through the existing localization/eTIMS enqueue path.

### Phase 6 — Ratchets and ADR
`docs/adr/0131-commercial-compensation-architecture.md` records the model. New architecture tests: no client-side compensation JE builders, no second refund or credit-note writer, every reversal-intent recommendation has a live writer, and credit-note numbering must be business-scoped.

## Technical notes
- Migrations follow create → grant → RLS → policy order; credit movements are append-only.
- Each phase ends with `tsgo --noEmit` plus the reversal/settlement SQL suites green.
- Legacy columns (`credit_notes.refund_amount`, `amount_applied`) stay readable for history but stop being authoritative once movements exist.