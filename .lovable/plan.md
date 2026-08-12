# Vendor Credit Notes — Phase 5 Verification Result & Phase 6 Plan

## Phase 1 — Verification of the previous engineer's Phase 5 claims

Checked directly against the live database and the code, not against the log.

### Confirmed true

- `document_kinds` contains `purchases.credit_note` (domain `purchases`, intents `view, download, print, email`).
- `business_event_topics` contains `purchases.vendor_credit_note.` with producer domain `purchases`.
- Trigger `tg_vcn_emit_lifecycle` exists on `vendor_credit_notes` and calls `_emit_vcn_outbox`, which writes to
  `business_event_outbox` with idempotency key
  `purchases.vendor_credit_note:<id>:<state>:<row_version>` and `ON CONFLICT DO NOTHING`.
- Dispute state is real: `commercial_status` check constraint includes `disputed`, and
  `vendor_credit_note_dispute` / `vendor_credit_note_resolve_dispute` exist as server functions.
- Three-track state machine is genuinely separate: `commercial_status`, `accounting_status`,
  `settlement_status`, each with its own check constraint. `origin` has a ten-value enumerated taxonomy.
- Snapshot builder `purchasesVendorCreditNote.ts` is registered in `resolveSourceDocumentRecord.ts`; Print,
  Download, Email and Preview are wired through the shared hooks and the `send-document-email` edge function.
- No direct client writes to `vendor_credit_notes` / `vendor_credit_note_items` anywhere; every lifecycle
  command is an RPC wrapper in `useVendorCreditNotes.ts`. No `window.prompt` / `window.confirm` remain.

### Claims that do not hold

- **Log says `dispute_resolution` column.** The table actually has `dispute_resolved_by`; there is no
  resolution-outcome column, so the resolve outcome passed to `vendor_credit_note_resolve_dispute` is not
  durably recorded on the row. Either the log or the schema is wrong; the schema is the one that matters.
- **"Runtime proof pending" understates it.** `vendor_credit_notes` has **zero rows** and
  `business_event_outbox` has **zero** `purchases.vendor_credit_note%` rows. Nothing in Phase 5 has ever
  executed. The emitter is unexercised code.
- **Document parity is not actually enforced — it is actively suppressed.**
  `src/test/architecture/document-workspace-canonical.test.ts` excludes `VendorCreditNote*` from the
  purchases action-vocabulary check with the comment "Vendor credit notes have no document snapshot builder
  yet". That comment is now false, and the exclusion means the new Print/Download/Email wiring is
  unprotected by CI while appearing green.

### Newly found gaps the previous engineer did not record

- **The lineage model built in Phases 1–4 is unreachable from the create UI.**
  `VendorCreditNoteCreatePage.tsx` captures only vendor, bill, date, notes, currency and lines. It never
  captures `origin` (the hook hardcodes `"adjustment"`), `reason_code`, `vendor_document_number`,
  `vendor_document_date`, `source_return_id`, `goods_receipt_id`, `purchase_order_id`, `exchange_rate` or
  `exchange_rate_date`. Every credit note a user can create today is an origin-less AP adjustment — the
  audit questions "why does this credit exist" and "what caused it" cannot be answered for any real record.
- **Credit-note number is a free-text field** pre-filled from `get_next_vendor_credit_note_number`. The
  create RPC does not accept a number, so what the operator types is silently discarded — a misleading
  field on a legal document.
- **Currency is a free-typed form field** rather than derived from the source bill / canonical business
  currency, and there is no FX rate capture at all despite the columns existing.
- **Totals preview math is duplicated verbatim** in the create and edit pages. It is display-only (the
  server recomputes), but two hand-maintained copies of tax math on a financial document is exactly the
  drift risk the architecture forbids.
- **No linked-records panel** on the record page for Bill / PO / GRN / Purchase Return lineage.
- **Dispute state is absent from analytics tiles / KPI cards.**

### Verdicts

| Area | Verdict |
|---|---|
| Writers, idempotency, server authority | Correct |
| State machine separation (commercial / accounting / settlement) | Correct |
| Governance, SoD, reversal | Correct |
| Document identity, snapshot, Print / Download / Email | Correct in code, unproven at runtime |
| Lifecycle events / outbox | Implemented, never executed |
| CI ratchets for document + event parity | Missing, and one existing ratchet is stale and suppressing coverage |
| Create / Edit lineage, origin, supplier document, FX capture | Architecturally wrong — model exists, UI cannot reach it |
| Record-page lineage panel, dispute analytics | Missing |

## Phase 6 — Plan

Ordered so proof comes before more building.

### 6a. Prove the lifecycle at runtime

Exercise one scratch credit note end to end — create, submit, approve, post, apply, reverse — and assert:
one `business_event_outbox` row per transition; re-running a transition produces no duplicate; the
idempotency key changes when and only when the state or `row_version` changes. Specifically confirm
`row_version` is bumped by every server command, since the key depends on it: if two different transitions
ever share a `row_version`, the `ON CONFLICT DO NOTHING` will silently swallow a real event. Then Print and
Email that note and confirm a `document_records` + `document_artifacts` pair exists and no legacy
`generate-document` fallback was hit. Fix whatever this uncovers before anything else.

### 6b. Close the ratchets

Remove the stale vendor-credit-note exclusion in `document-workspace-canonical.test.ts` and make the
purchases action-vocabulary check apply to credit notes. Add an event-coverage architecture test asserting
every lifecycle state in the commercial/accounting vocabulary has an emitter branch in `_vcn_emit_lifecycle`,
and a document-parity test asserting any kind registered in `document_kinds` under `purchases` has a
snapshot builder plus Print/Download/Email wiring.

### 6c. Make the create and edit forms speak the lineage model

Rebuild the create form around origin-first capture: choose the credit's origin from the server's ten-value
taxonomy, and let that choice drive which lineage fields are required — a `purchase_return` origin requires
a source return (and inherits its GRN/PO/bill), a `supplier_credit` origin requires the supplier's own
document number and date, a `tax_correction` or `price_correction` origin requires the source bill and has
no physical lineage. Reason code comes from the shared reason vocabulary, not free text. The internal
number becomes a read-only server-assigned display. Currency is derived from the source bill or the
business's canonical currency, with FX rate and rate date captured from the canonical rate engine when the
document currency differs. The duplicated preview totals math collapses into one shared, clearly-labelled
preview helper used by both create and edit.

### 6d. Complete the record surface

Add a linked-records panel to the record page showing Bill, Purchase Order, Goods Receipt and Purchase
Return lineage using the shared linked-records primitive, and add the disputed state to the credit-note
analytics tiles so a disputed credit is visible without opening the list filter.

### 6e. Record the dispute outcome

Add the missing resolution-outcome column so `vendor_credit_note_resolve_dispute` persists *how* the dispute
ended, not merely that it did, and surface it in the activity feed.

## Technical notes

Migrations: one for the dispute-resolution outcome column, plus whatever 6a proves is wrong in the emitter.
Each migration touching a public function ends with `NOTIFY pgrst, 'reload schema'`. No new engine anywhere:
numbering stays with `get_next_vendor_credit_note_number`, events with the existing outbox, documents with
the existing kind/snapshot/artifact chain, approvals with the canonical governance resolver, FX with the
existing rate engine.

## Out of scope, still tracked

`expense` is listed as reversible but `resolve_reversal_intent_finance` has no expense branch. It predates
this work and belongs to the Expenses module.

## Unrelated pre-existing build error

`src/pages/inventory/LotDetail.tsx:123` fails typecheck with TS2589 (excessively deep type instantiation on the
`stock_lots` select with four nested relations). It is untouched by this work; the one-line fix is to type the
query result explicitly instead of letting the generated types recurse. I will fix it first on approval.
