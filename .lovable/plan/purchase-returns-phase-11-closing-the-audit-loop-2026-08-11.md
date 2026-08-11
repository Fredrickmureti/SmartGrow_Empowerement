# Purchase Returns — Phase 11: closing the audit loop

## Phase 10 verification (done before planning)

Checked directly against the database and the code, not against the notes.

Confirmed true:
- The system-scope return template exists: one row in `document_template_ast`
  with `kind_code = 'purchases.return'`, `scope = 'system'`.
- `purchase_return` is a legal email document type — it is in the
  `document_emails` document-type check constraint, and in the client
  `DocumentType` union and label map.
- Dispatch really does publish the outbox event. `purchase_return_dispatch`
  calls `_pret_emit_outbox(v_pr, 'dispatched', ...)` after logging the
  lifecycle event, so the notification is server-side and not page-driven.
- The record view already carries meaningful traceability: return kind, reason
  code, RMA reference, per-line receipt basis / lot / serial / condition,
  links to goods receipt, purchase order and vendor debit note, plus the
  lifecycle event list with the governance mode on each decision.

Corrections to the previous engineer's status notes:
- Not verifiable end to end right now: the tenant has zero rows in
  `purchase_returns` and zero `goods_receipt_items`, so no dispatched return
  exists to send a test email from. The template, constraint and code path are
  confirmed by inspection; the live send stays unproven until real data exists.
- `purchase_return_raise_credit` emits no outbox event. It updates the return
  to `credited` and logs the lifecycle row, but never calls `_pret_emit_outbox`.
  This was listed as "optional" — it is not optional, it is the one lifecycle
  transition with no downstream signal.

New defects found during verification (added to Phase 11):
- Dead link. The record view links a receipt to `/purchases/goods-receipts/:id`.
  That route does not exist anywhere in the purchases route table — receipts are
  only reachable through the purchase order's receipts section and the warehouse
  receiving session. The single most important provenance link on the record is
  broken.
- No supplier bill link. `purchase_returns.bill_id` is populated by the server
  but the record view never shows it, so the return cannot be walked to the
  liability it reduces.
- No acknowledgement surface. `acknowledged_at` / `acknowledged_by` exist as
  columns and are not rendered anywhere.
- Actors are user ids only. The lifecycle list shows the governance mode but
  never resolves who submitted, approved, dispatched or closed the return.

## Phase 11 — work to do

### 1. Fix and complete provenance on the return record
- Point the receipt link at a route that exists (the source purchase order's
  receipts section, deep-linked to the receipt), and fall back to plain text
  when there is no order.
- Add the supplier bill link driven by `bill_id`, and show the debit note's
  application against that bill (amount applied, remaining) using the existing
  vendor credit allocation read — no new allocation logic.
- Add an acknowledgement row: acknowledged date, actor, and the RMA reference
  the supplier returned.

### 2. Name the actors
- Resolve `submitted_by / approved_by / dispatched_by / acknowledged_by /
  closed_by / cancelled_by` and the lifecycle event actors to display names via
  the existing profile lookup, so the audit answers "who" without a database
  query. Keep the governance mode next to the approval, as today.

### 3. Returned-quantity ledger on the receipt
- Surface, per receipt line, received / already returned / still returnable,
  derived from the existing server-side `purchase_return_returnable_lines`
  function — the same source the create page clamps against, never a second
  calculation. Render it in the purchase order's goods receipts section, which
  is where a receipt is actually visible today.

### 4. Emit `procurement.return.credited`
- Call `_pret_emit_outbox(v_pr, 'credited', ...)` from inside
  `purchase_return_raise_credit`, idempotent per return, carrying the debit note
  id, credited amount and bill reference, so AP/notification consumers see the
  financial leg the same way they see dispatch.

### 5. Ratchet the new invariants
- Extend the pgTAP lifecycle test: raising credit inserts exactly one
  `credited` outbox row, and a second `raise_credit` inserts none.
- Extend the architecture guard test so the returned-quantity ledger cannot be
  reimplemented client-side.

## Technical notes
- One database migration (the credit outbox emission); everything else is
  read-only UI plus tests.
- No new engines: allocations, documents, governance, outbox and the returnable
  ledger all stay canonical and server-owned.
- The record view remains a projection of server columns; nothing added here
  computes a business value in the browser.

## After Phase 11
Once a real return exists in a tenant, run the deferred Phase 10 live check:
send a dispatched return, confirm the attachment is the canonical artifact and
that a `document_emails` row lands with `document_type = 'purchase_return'`.
