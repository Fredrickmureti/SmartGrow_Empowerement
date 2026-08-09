# Credit Note Domain — Server-Authoritative Rebuild

Status date: 2026-08-09. This file is the authoritative status for the credit note workstream.

## Active phase

Phase 3 (writer monopoly) is complete. **Phase 4 — lineage visibility and voiding — is the next milestone.**

## Phase 1 — Forensic audit (COMPLETE, VERIFIED)

- The line picker existed but protected nothing: `credit_note_items` had no link to the invoice line, and the server accepted client totals verbatim.
- The edit page wrote credit note lines straight from the browser, bypassing the writer monopoly.
- Conclusion confirmed: provenance and money were UI-only concerns.

## Phase 2 — Provenance and the credit ceiling (COMPLETE, VERIFIED)

Implemented:

- `credit_note_items.invoice_item_id` plus historical snapshot columns
  (`source_unit_price`, `source_discount_percent`, `source_tax_rate`, `source_currency`,
  packaging / UoM / eTIMS codes).
- `v_invoice_creditable_qty`: invoiced, credited and remaining quantity and net amount per invoice line.
- `_resolve_credit_note_line`: recomputes every invoice-referenced line from the invoice itself,
  prorates tax from the invoice line's own tax amount, and rejects over-credits and foreign lines.
- `credit_notes.client_request_id` with unique index `(business_id, client_request_id)`.

Verified against live data (invoice INV-00001):

- A payload sending `unit_price: 999999, description: "HACKED"` resolved to 50.00 x 10 = 500.00 with the
  invoice's own description — client values discarded.
- 150 of 150 accepted; 151 rejected ("only 150.00 remain creditable").
- A line belonging to another invoice rejected with SQLSTATE 42501.
- Idempotency index present; create writer reads `client_request_id`; update writer is draft-only.

## Phase 3 — Writer monopoly across the whole lifecycle (COMPLETE, VERIFIED)

- Create → `create_credit_note_atomic(_payload jsonb)` (single named envelope).
- Edit → `update_credit_note_atomic(_payload jsonb)`; draft-only, re-applies the ceiling excluding itself.
- Issue → `issue_credit_note_atomic`.
- Delete → `delete_credit_note_atomic(_credit_note_id uuid)`, new: draft only, nothing applied, nothing
  refunded, no customer credit movements, no posted journal entry, business access checked. `EXECUTE`
  revoked from PUBLIC and granted to `authenticated` / `service_role` (confirmed: an unauthenticated call
  is refused).
- `useCreditNotes` no longer updates or deletes `credit_notes` rows directly; the generic mutator forwards
  only descriptive fields (reason, notes, issue date) to the server writer.
- The create form holds one deterministic request id per attempt, so retries cannot duplicate economics.
- Reasons come from one shared `CreditReasonField`.

Guards: `src/test/architecture/credit-note-provenance.test.ts` (7 tests) and
`src/services/finance/createCreditNote.test.ts` (2 tests) — all passing. Typecheck clean.

## Known debt (not introduced by this phase)

`compensation-writer-monopoly.test.ts` has one failing assertion: 46 migration files dating from
2026-08-08 onward do not end with `NOTIFY pgrst, 'reload schema'`. Applied migration files cannot be
edited, so the schema reload was issued as a follow-up migration. The API cache is current; the ratchet
stays red until the backlog is addressed deliberately.

## Phase 4 — NEXT: lineage visibility and voiding

Not started. Scope:

1. Surface lineage in the UI: the credit note record page and peek sheet should show, per line, the
   invoice and invoice line it reverses, plus the historical price/discount/tax actually used.
2. Show remaining creditable quantity on the invoice record page, so an operator sees at a glance how much
   of an invoice is still creditable.
3. Voiding: confirm `void` reverses the GL and the customer credit movements atomically, and that a voided
   credit note releases its consumed ceiling (the view already excludes `void`; the behaviour needs an
   end-to-end check).
4. End-to-end authenticated proof: create, edit, issue and attempt an over-credit through the browser as a
   signed-in operator, and assert the resulting rows and journal entry.

## Phase 5 — Later

Vendor credit notes: apply the same provenance, ceiling and idempotency treatment against bill lines.

## Instructions for the next agent

1. **Verify before extending.** Re-run `src/test/architecture/credit-note-provenance.test.ts` and
   `src/services/finance/createCreditNote.test.ts`, then re-check the server behaviour directly by calling
   `public._resolve_credit_note_line` with (a) an inflated client price, (b) a quantity one above the
   remaining ceiling, and (c) an invoice line from a different invoice. All three must behave as recorded
   in Phase 2 above. Confirm `delete_credit_note_atomic` refuses a non-draft credit note.
2. **Then resume at Phase 4, item 1** — do not start Phase 5 or unrelated modules while Phase 4 is open.
3. Any migration you write must end with `NOTIFY pgrst, 'reload schema'`.
4. Keep the rule: the browser expresses intent, the database resolves money.
