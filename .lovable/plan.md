# Vendor Credit Notes — Authoritative Project Status

Domain: Purchases / AP vendor credit notes.

## Current phase

**Phase 7 — in progress. 7a complete and verified; 7b is the next task.**

## Completed and verified

### 6a — lifecycle proof (done)

Real defect found and fixed. `_vcn_emit_lifecycle` keys outbox rows on
`(credit note, state, row_version)`, but `apply_vendor_credit_to_bill_atomic` did not bump
`row_version`, so a second partial application produced a duplicate idempotency key and was
silently swallowed by `ON CONFLICT DO NOTHING`. Migration applied: the apply writer now advances
`row_version`. All other transitions (submit, approve, reject, cancel, dispute, resolve, post,
reverse) were verified to bump it already.

Build also unblocked: three TS2589 "type instantiation is excessively deep" failures
(`LotDetail.tsx`, `MobilePack.tsx`, `PackStation.tsx`) fixed by widening the nested `.select()`
strings to plain `string`; row shapes stay pinned by the existing casts.

### 6b — ratchets (done, green)

- `document-workspace-canonical.test.ts` — stale "no snapshot builder" exclusion removed; vendor
  credit notes are held to the Preview / Print / Download / Email vocabulary. 16 tests green.
- `vendor-credit-note-events.test.ts` (new) — every lifecycle transition must route through its
  server RPC, the writer module must never write `vendor_credit_notes` directly, reversal must go
  through the shared reversal engine. 12 tests green.

### 6c — lineage capture in the forms (done)

- `vendorCreditNoteLineage.ts` — canonical origin vocabulary (matching the DB check constraint),
  reason codes, `toLineagePayload`, `originLabel` / `reasonCodeLabel`, and a `lineageError` guard
  that blocks submit when an origin's required upstream reference is missing.
- `VendorCreditNoteLineageFields.tsx` — shared fieldset (origin, reason, bill / PO / GRN / return,
  supplier document number + date) used by both Create and Edit.
- `useVendorGoodsReceipts.ts` — vendor-scoped goods receipts for provenance selection.
- `VendorCreditNoteTotalsPreview.tsx` — the duplicated subtotal / tax / total math extracted once.
- Create and Edit rebuilt on those pieces; the editable "Credit Note #" field is gone — numbering is
  server-owned and shown read-only.

### 6d — record surface (done)

- `useVendorCreditNoteRecord.ts` embeds `bill`, `purchase_order`, `goods_receipt`, `source_return`.
- `VendorCreditNoteLinkedRecords.tsx` — "Linked records" panel on the record page walking back to
  bill / PO / GRN / return and forward to the posted and reversal journal entries. The goods
  receipt is shown as text, not a link: no standalone GRN record route exists yet.
- Record detail fields now show origin, reason, supplier document number + date, and dispute
  state (open since / resolved — outcome). The list page already filters and badges `disputed`.

### 6e — dispute outcome (done)

Migration: `vendor_credit_notes.dispute_resolution` (`accepted` | `withdrawn`, checked),
`vendor_credit_note_resolve_dispute` now persists the outcome in the same transaction that closes
the dispute, and the previously unconstrained lineage columns `goods_receipt_id` /
`purchase_order_id` got real foreign keys (`ON DELETE SET NULL`) plus indexes.

Verification: `tsgo` clean; `vendor-credit-note-events.test.ts` + `document-workspace-canonical.test.ts`
green (28 tests).

### 7a — application surface (done, verified)

Real defect found and fixed. The Phase 6a `row_version` migration had replaced the credit-ledger
movement insert inside `apply_vendor_credit_to_bill_atomic` with a call to
`public.vendor_credit_balance_apply` — a function that does not exist in this database. Applying a
vendor credit therefore failed at runtime with "function does not exist" and no movement was ever
written. The writer now inserts the `apply` movement directly again.

Also shipped in the same migration:

- `vendor_credit_note_applications.journal_entry_id` + `reversal_journal_entry_id` (FK to
  `journal_entries`, `ON DELETE SET NULL`), backfilled from the matching `apply` movements, plus
  indexes on `credit_note_id` and `bill_id`. Applications now carry their own accounting linkage
  instead of it being inferable only through the ledger.
- `unapply_vendor_credit_from_bill_atomic(_application_id, _reason)` — one transaction that voids
  the application's journal entry through `void_journal_entry_atomic`, restores `bills.amount_paid`
  and the bill status, writes the `unapply` credit movement, stamps `reversed_at/by/reason` +
  reversal JE on the application row, and recomputes `amount_applied` / `settlement_status` /
  `row_version` on the note. Guards: business access, not-already-reversed, open period.
  `authenticated`-only execute.

Client:

- `useVendorCreditNotes.applyToBill` no longer fakes a targeted apply by calling FIFO with one bill
  — it calls `apply_vendor_credit_to_bill_atomic` with the operator's amount. New
  `unapplyCreditApplication(applicationId, reason)`. Both audit-logged and toast-reporting.
- `useVendorCreditNoteApplications.ts` — read-only projection of the settlement ledger (with bill
  numbers and reversal state).
- `useVendorOpenBills.ts` — the supplier's outstanding bills for the picker (advisory; the server
  re-validates).
- `VendorCreditNoteApplications.tsx` — "Applications" section on the record page: every application
  with its bill link, amount, unapplied badge, per-row Unapply, and an "Apply to a bill" dialog
  (bill + amount, capped by the lower of unapplied credit and bill balance). FIFO "apply oldest
  first" stays on the action menu, unchanged.

Verification: `tsgo` clean; `vendor-credit-note-events.test.ts` (now 16 tests, including new
settlement ratchets: writer never writes `bills` / `vendor_credit_note_applications` /
`vendor_credit_movements` directly, the panel mutates only through the writer hook, the read hook
stays read-only) + `document-workspace-canonical.test.ts` — 32 tests green.

## Next milestone — Phase 7 remaining

1. **7b — ageing / AP impact (next).** Surface open (unapplied) vendor credit in aged payables so
   the supplier balance nets correctly, and reconcile the aged-payable figure against
   `vendor_credit_balances` / `vendor_credit_movements` rather than against document columns.
2. **7c — period close interaction.** Prove posting, application, unapply and reversal all respect
   closed fiscal periods via the canonical period guard (`is_period_open` is already called in the
   apply and unapply writers — assert it for post/reverse too) and add a ratchet test.

## Instructions for the next agent

1. **Verify before extending.** Confirm 7a independently: check
   `apply_vendor_credit_to_bill_atomic` inserts a `vendor_credit_movements` row (not the
   nonexistent `vendor_credit_balance_apply`), confirm
   `unapply_vendor_credit_from_bill_atomic` exists with `authenticated` execute, and exercise a
   scratch posted credit note end to end: apply part of it to a bill, confirm the bill's
   `amount_paid`, the application row + its `journal_entry_id`, the `apply` movement and
   `settlement_status = partially_applied`, then unapply and confirm every one of those is undone
   (reversal JE present, `unapply` movement written, `settlement_status = open`).
2. Then resume at **7b** — do not pick unrelated work.
3. Reuse canonical engines (document record scaffold, reversal engine, approval engine, outbox,
   period guard); do not introduce a parallel one.

## Known out of scope

`expense` is registered reversible but `resolve_reversal_intent_finance` has no expense branch, so
`reversal-intent-coverage.test.ts` fails on that row. Pre-existing, belongs to Expenses.

Note: the full `src/test/architecture` suite exceeds a 10-minute run in this sandbox; run targeted
files rather than the whole directory.

