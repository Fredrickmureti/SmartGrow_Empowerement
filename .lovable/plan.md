# Vendor Credit Note — architecture audit and rebuild

## 1. What a vendor credit note is here

A vendor credit note (VCN) is a **commercial/financial document that records a
reduction of what we owe a supplier**. It is not a purchase return and not a
negative bill.

Three distinct concepts must stay distinct:

- **Purchase return** — the physical event (GRN → return request → governance →
  WMS dispatch → stock movement). Already owned by `purchase_returns` + WMS.
- **Vendor credit note** — the financial consequence and the document. Either
  *internally raised* (debit note we send the supplier) or *supplier-issued*
  (their credit document, which we record).
- **Vendor credit balance** — the unapplied money left over, a subledger
  (`vendor_credit_movements` → `vendor_credit_balances`), not a document column.

Origins the system must support: purchase return, overbilling, invoice/price
correction, quantity discrepancy, damaged/rejected goods, tax-only correction,
rebate, supplier-issued credit, AP adjustment. Only the return-driven origin
touches inventory — and it does so through the return document, never from the
credit note.

## 2. Verdict on the current implementation

Financial core (ADR 0132) is largely right:

- ✅ `create_vendor_credit_note_atomic` is the only creation writer; the browser
  no longer inserts headers or allocates numbers.
- ✅ `issue_vendor_credit_note_atomic` builds journal lines in the database,
  reduces AP only up to the linked bill's open balance, sends the remainder to
  the dedicated vendor-credit account, posts only through
  `post_journal_entry_atomic`, honours the fiscal-period lock, and refuses a
  second posting for the same source.
- ✅ Numbering is business-scoped and advisory-locked; FIFO application reads
  availability from the balance table, not from `total - amount_applied`.
- ✅ Purchase returns own the physical lifecycle and call the credit writer,
  emitting `procurement.return.credited` on the outbox.

Everything around that core is wrong or missing:

| Area | Verdict | Evidence |
| --- | --- | --- |
| Draft edit / delete | ❌ wrong | `useVendorCreditNotes.updateVendorCreditNote` writes `vendor_credit_notes` directly and deletes/re-inserts items from the browser; `deleteVendorCreditNote` deletes directly. No `update_vendor_credit_note_atomic` exists in the database (the sales side has one). Header totals therefore come from the browser. |
| Document lineage | ❌ missing | `vendor_credit_notes` has only `bill_id`. No source return, goods receipt, purchase order, supplier's own credit number, origin/reason code, or FX rate. Items have no `bill_item_id`, so "which invoiced line is being credited" is unanswerable and there is no credit ceiling (the sales side has `invoice_item_id` + a creditable-quantity read model). |
| State machine | ❌ wrong | One `status` text field mixes commercial, accounting and settlement reality (`draft/confirmed/applied/void`), and a legacy RPC `approve_vendor_credit_note` writes a fourth value `approved` that the rest of the system does not understand. |
| Governance | ❌ wrong | No submit/approve/reject action exists in the UI action set; the only control is a module-local self-approval trigger plus that legacy RPC. `submitted_by/approved_by` columns are dead. Issuing (the moment AP changes) is reachable by any user who can see the record. |
| Idempotency | ❌ missing | Creation takes no request key; a retry or double submit creates a second credit note. AP money-out already has this via `client_request_id`. |
| Documents | ❌ missing | `document_kinds` has `sales.credit_note` and `purchases.return`, but no purchases credit-note kind, and there is no snapshot builder. So no print, no download, no artifact, no email to the supplier. |
| Events | ❌ missing | No business event is emitted on issue, apply, reverse or cancel. Only the return emits. |
| Reversal | ❌ missing | No `void_vendor_credit_note_atomic`. The only "undo" is a browser delete of a draft; a posted note has no supported reversal path. |
| Currency / FX | ⚠ | Header currency defaults to `USD` while the balance table defaults to `KES`; the create writer takes no currency or rate, and there is no exchange rate or rate date, so company-currency AP cannot be reconciled for foreign credits. |
| Tax | ⚠ | Tax is a free-typed percentage per line with no link to the bill line it corrects, no tax-code/localization reference, and no period reference for statutory reporting. |
| Surfaces | ⚠ | Two pages render vendor credits (`src/pages/VendorCreditNotes.tsx`, `src/pages/finance/VendorCredits.tsx`). |

Root cause: ADR 0132 fixed *accounting* parity with the sales side but skipped
*document* parity — lineage, provenance, state separation, governance,
idempotency, rendering, events and reversal were never brought across.

## 3. Target architecture

Ownership stays where it already is: returns own the physical event, WMS owns
execution, inventory owns stock, `post_journal_entry_atomic` owns the ledger,
the approval engine owns governance, the document engine owns rendering, the
outbox owns events. The credit note owns **lineage, tax basis and the
financial document**.

Three orthogonal states replace the single field:

```text
commercial:  draft → submitted → approved | rejected | cancelled
accounting:  unposted → posted → reversed
settlement:  open → partially_applied → applied | refunded
```

## 4. Implementation phases

**Phase 1 — writer monopoly and idempotency**
Add `update_vendor_credit_note_atomic` and `delete_vendor_credit_note_atomic`
(draft-only, server-recomputed totals), add `client_request_id` with a unique
index per business, and rewrite the hook to call them. Extend the existing
compensation ratchet test to ban direct `vendor_credit_notes` /
`vendor_credit_note_items` writes from the browser.

**Phase 2 — lineage and provenance**
Add to the header: `source_return_id`, `goods_receipt_id`, `purchase_order_id`,
`vendor_document_number`, `vendor_document_date`, `origin` (return, overbilling,
price correction, quantity, tax, rebate, supplier credit, adjustment),
`reason_code`, `exchange_rate`, `exchange_rate_date`, `row_version`.
Add `bill_item_id` and source-price snapshots to the items, recompute
invoice-referenced lines server-side from the bill line, and enforce a credit
ceiling per bill line via a creditable-quantity read model — mirroring the
sales-side provenance rules already in place. Purchase-return-raised notes
stamp the return, GRN and origin.

**Phase 3 — state machine and governance**
Split the status into commercial / accounting / settlement columns with a
transition guard. Register `vendor_credit_note` create/submit/approve/reject/
issue/apply/reverse/cancel with the canonical approval engine and the
self-action policy; drop the legacy `approve_vendor_credit_note` RPC and the
module-local self-approval trigger. Issuing requires an approved note under
standard/strict modes and stays one click under solo.

**Phase 4 — reversal and edge cases**
Add `void_vendor_credit_note_atomic` (single writer: reverses the journal
entry, unwinds applications and credit movements, refuses to touch closed
periods, idempotent by request key). Cover the edge matrix in contract tests:
credit without return, return-driven credit, partial credit, several credits on
one bill, one credit across many bills, credit exceeding bill balance, credit
after payment, pre-bill credit, tax-only credit, FX credit, duplicate submit,
concurrent issue, retry after network failure.

**Phase 5 — document, supplier communication, events**
Register a purchases credit-note document kind, add a snapshot builder with the
correct field set (issuing entity, supplier, our number, supplier's number,
dates, bill/return/PO references, currency, line basis, taxable amount, tax,
total, reason, terms, journal reference), and wire print / download / email
through the existing artifact engine — email manual and outbox-delivered, never
triggered by a status change alone. Emit durable business events on issued,
applied, reversed and cancelled, keyed for idempotent replay.

**Phase 6 — consolidation**
Fold the two vendor-credit pages into the one record/list surface, and confirm
AP ageing, supplier statements and reconciliation read the credit from the
subledger.

## 5. Technical notes

- All new database work goes through migrations; every migration that creates or
  replaces a public function ends with `NOTIFY pgrst, 'reload schema'`.
- No new engine: no second numbering, approval, posting, inventory, document or
  email path is introduced.
- Ratchets extended: compensation writer monopoly, journal posting monopoly, and
  a new vendor-credit provenance test.
- ADR 0132 gets an addendum (or ADR 0133) recording the document-parity decisions.

## 6. Suggested first step

Phase 1 alone removes the browser's authority over credit-note money and stops
duplicate submissions; Phase 2 is the largest and unlocks everything downstream.
