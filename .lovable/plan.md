# Vendor Credit Notes (ADR 0132) — Implementation Status

## Completed and verified
- **Phase 1 — Writer monopoly & idempotency**: `create/update/delete_vendor_credit_note_atomic`, `client_request_id`, client hooks route all mutations through RPCs, ratchet test enforces no direct table writes.
- **Phase 2 — Lineage & provenance**: header lineage (`source_return_id`, `origin`, `reason_code`, `vendor_document_number`, `exchange_rate`), line `bill_item_id` + price/tax snapshots, `v_bill_creditable_qty` view, server line resolver with credit-ceiling enforcement, `purchase_return_raise_credit` stamps return/GRN.
- **Phase 3 — State machine & governance**: `commercial_status` / `accounting_status` / `settlement_status` + legacy `status` sync trigger, submit/approve/reject/cancel RPCs wired to the approval engine, posting guarded by approval, UI actions + record view updated.
- **Phase 4 — Reversal & voiding** (this phase, now complete):
  - DB: reversal audit columns, `unapply`/`reversal` movement kinds, AP reversal reason codes, `resolve_reversal_intent_vendor_credit_note` (dispatched from `resolve_reversal_intent`), `reverse_vendor_credit_note_atomic`, posted-only guard on credit application.
  - Register: `reversal_register` view now has a Purchases branch for reversed vendor credit notes.
  - Client: `vendor_credit_note` added to both `ReversalDocumentType` unions and `REVERSIBLE_DOCUMENTS`; `reverseVendorCreditNote` writer wrapper in `useTransactionReversal`; `ReverseVendorCreditNoteDialog` (intent → consequence preview → approval notice → shared reason vocabulary); `Reverse` action in `useVendorCreditNoteActions`, wired on the record page.
  - Guards: reversal register coverage and compensation writer-monopoly tests pass; intent-coverage test updated for the new document type.

## Currently active
Phase 4 is closed. Nothing is partially implemented in the VCN reversal path.

## Pending
- **Phase 5 — Document parity / artifact engine** (next): `document_kind` registration for vendor credit notes, immutable snapshot + PDF artifact on posting, artifact regeneration on reversal, and outbox events for every lifecycle transition (submitted / approved / posted / applied / reversed).
- **Known pre-existing defect, out of ADR 0132 scope**: `expense` is listed in `REVERSIBLE_DOCUMENTS` but `resolve_reversal_intent_finance` has no `expense` branch, so `reversal-intent-coverage.test.ts` fails on that row. It failed before Phase 4 and needs an owner in the Expenses module.

## Instructions for the next agent
1. **Verify Phase 4 first.** Confirm end-to-end: post a VCN, apply it to a bill, reverse it, then check that (a) the journal entry is voided, (b) applications are unwound and the bill balance restored, (c) `vendor_credit_movements` nets to zero, (d) the note appears in `reversal_register`, (e) a second reversal returns `already_reversed` rather than double-posting.
2. Only after that, start Phase 5 (documents/events). Do not pick unrelated work or leave the artifact/outbox work half-wired.
