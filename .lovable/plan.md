# Vendor Credit Notes — Authoritative Project Status

Domain: Purchases / AP vendor credit notes.

## Current phase

**Phase 6 — complete (6a–6e).** Next active work is Phase 7 (see "Next milestone").

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

## Next milestone — Phase 7: applications, ageing and close

Not started. In order:

1. **7a — application surface.** `apply_vendor_credit_to_bill_atomic` is only reachable via the
   FIFO "apply oldest first" action. Add targeted application (operator picks bill + amount) and
   an unapply path, both server-authoritative, plus an applications table on the record page fed by
   the credit movement rows.
2. **7b — ageing / AP impact.** Surface open (unapplied) vendor credit in aged payables so the
   supplier balance nets correctly, and reconcile against `customer_credit_movements`' vendor
   equivalent.
3. **7c — period close interaction.** Prove posting and reversal respect closed fiscal periods via
   the canonical period guard; add a ratchet test if the guard is not already asserted for VCNs.

## Instructions for the next agent

1. **Verify before extending.** Confirm the Phase 6 claims above independently: re-read
   `vendorCreditNoteLineage.ts` + both form pages for origin-required-reference enforcement, open a
   credit note record page and confirm the linked-records panel resolves, and query
   `vendor_credit_notes` for the `dispute_resolution` column, the two new FKs, and that
   `apply_vendor_credit_to_bill_atomic` increments `row_version`.
2. Then resume at **7a** — do not pick unrelated work.
3. Reuse canonical engines (document record scaffold, reversal engine, approval engine, outbox);
   do not introduce a parallel one.

## Known out of scope

`expense` is registered reversible but `resolve_reversal_intent_finance` has no expense branch, so
`reversal-intent-coverage.test.ts` fails on that row. Pre-existing, belongs to Expenses.

Note: the full `src/test/architecture` suite exceeds a 10-minute run in this sandbox; run targeted
files rather than the whole directory.

