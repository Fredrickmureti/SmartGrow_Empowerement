# Vendor Credit Notes — Verification Result and Phase 5 Plan

## Phase 1 — What I verified (evidence, not claims)

I checked the previous engineer's four "complete" phases directly against the database and the code.

Confirmed genuinely implemented:

- **Writers & idempotency.** `create/update/delete_vendor_credit_note_atomic`, `issue_vendor_credit_note_atomic`, `apply_vendor_credit_to_bill_atomic`, `apply_vendor_credit_fifo_atomic` all exist as database functions; `vendor_credit_notes.client_request_id` exists; the writer-monopoly test greps for direct table writes and for the retired legacy writers, and those legacy writers are gone.
- **Lineage.** Header carries `source_return_id`, `goods_receipt_id`, `purchase_order_id`, `bill_id`, `origin`, `reason_code`, `vendor_document_number`, `vendor_document_date`, `currency`, `exchange_rate`, `exchange_rate_date`. Lines carry `bill_item_id`, `source_unit_price`, `source_tax_rate`, packaging/UoM snapshots. Line resolution is server-side (`_resolve_vendor_credit_note_line(s)`).
- **State machine.** `commercial_status`, `accounting_status`, `settlement_status` all exist alongside legacy `status`, with a sync trigger and a state guard trigger. Submit/approve/reject/cancel exist as server commands and an SoD guard trigger is attached.
- **Reversal.** `resolve_reversal_intent_vendor_credit_note` and `reverse_vendor_credit_note_atomic` exist, reversal audit columns are present, and the `reversal_register` view does contain a vendor-credit-note branch. Client side has the reversal dialog, the writer wrapper and the record-page action.

So the log is accurate: Phases 1–4 are real, not superficial. I am not redoing them.

Newly found gaps the previous engineer did not record (added to scope below):

- **No document identity at all.** `document_kinds` has `sales.credit_note`, `purchases.bill`, `purchases.return`, `purchases.statement` — but **no vendor credit note kind**. There is no snapshot builder, and the record page has no Print, Download or Email action. A posted AP credit currently produces no document artifact.
- **No lifecycle events.** None of the eight vendor-credit-note server functions emit a business event. Every other posting surface in Purchasing publishes to the outbox; this one is silent, so no downstream consumer can react.
- **Reason capture uses browser prompts.** Reject, cancel and FIFO apply use `window.prompt` / `window.confirm`. Reasons bypass the shared reason-code vocabulary used everywhere else, and FIFO apply commits with no preview of which bills it will consume.
- **No supplier dispute state.** A supplier rejecting our credit claim has nowhere to live.

## Phase 5 — Document parity, events, and interaction hardening

### 5a. Document identity and artifact
- Register a `purchases.credit_note` document kind (purchases domain, party required, PDF) through a migration, following the existing registration pattern.
- Add a snapshot builder mirroring the purchase-return builder: legal entity, supplier, internal credit-note number, supplier's own document number and date, issue date, source bill / PO / GRN / return references, currency and rate, lines with quantity, unit basis, taxable amount, tax and total, reason and reason code, and the journal reference once posted.
- Freeze the snapshot on posting into `document_records`; regenerate a distinct artifact (not a mutation) on reversal so the reversed state is its own immutable document.
- Wire Print, Download and Email as three distinct actions on the record page and the list row menu, through the existing print intent / artifact / email engines. No new renderer, no direct PDF work, no automatic send on status change — email stays a deliberate operator act consuming the canonical artifact.

### 5b. Lifecycle events on the outbox
- Register a topic prefix for the vendor credit note in `business_event_topics`, producer domain purchases.
- Emit from inside the existing server writers only (never the browser), on: submitted, approved, rejected, cancelled, posted, applied, reversed. Payload carries the credit note id, business, supplier, amount, currency, source lineage ids and the journal entry id.
- Events are durable and retryable through the existing outbox; each carries the credit note's `row_version` so consumers stay idempotent and duplicates cannot double-apply.

### 5c. Interaction hardening
- Replace the reject / cancel prompts with proper dialogs using the shared reversal-style reason vocabulary, so reasons are coded and auditable.
- Replace the FIFO apply confirm with a preview sheet listing the bills and amounts the allocation will consume before committing.
- Add a supplier-dispute state on the commercial track (supplier rejected our credit claim) with its own server transition and audit entry, distinct from our internal reject.

### 5d. Ratchets
- Extend the document-parity architecture test so a vendor credit note without a registered kind, snapshot builder, or Print/Download/Email trio fails CI.
- Add an event-coverage test asserting each of the seven transitions has an emitter in its writer.
- Keep the existing writer-monopoly and reversal-register tests green.

## Out of scope, tracked

`expense` is listed as reversible but `resolve_reversal_intent_finance` has no expense branch, so the intent-coverage test fails on that row. It predates this work and belongs to the Expenses module; I will not fold it into ADR 0132.

## Technical notes

Migrations: one for the document kind, one for the event topic plus emitters inside the existing writer functions, one for the dispute state and its transition. Each migration touching a public function ends with a PostgREST schema reload. No new engine is introduced anywhere: documents go through the existing kind/snapshot/artifact chain, events through the existing outbox, approvals through the existing governance resolver, numbering stays with the server sequence function already in place.
