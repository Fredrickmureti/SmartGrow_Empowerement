# Vendor Credit Notes — Authoritative Project Status

Domain: Purchases / AP vendor credit notes.

## Current phase

**Phase 6 — in progress.** 6a (lifecycle proof) and 6b (ratchets) closed; 6c–6e open.

## Closed this turn

- **Build unblocked.** Three TS2589 "type instantiation is excessively deep" failures
  (`src/pages/inventory/LotDetail.tsx`, `src/pages/warehouse-mobile/MobilePack.tsx`,
  `src/pages/warehouse/PackStation.tsx`) fixed by widening the nested `.select()` strings to
  plain `string` so supabase-js stops parsing them at the type level. Row shapes stay pinned by
  the existing casts. Full `tsgo` typecheck is clean.

- **Real defect found and fixed (6a).** `_vcn_emit_lifecycle` keys outbox rows on
  `(credit note, state, row_version)`, but `apply_vendor_credit_to_bill_atomic` did not bump
  `row_version`. A second partial application therefore produced an idempotency key identical to
  the first and was silently swallowed by `ON CONFLICT DO NOTHING` — partial applications lost
  their `applied` event. Migration applied: the apply writer now advances `row_version`, so every
  application emits a distinct durable event. All other transitions (submit, approve, reject,
  cancel, dispute, resolve, post, reverse) were verified to bump `row_version` already.

- **Ratchets closed (6b).**
  - `src/test/architecture/document-workspace-canonical.test.ts` — the stale
    "vendor credit notes have no snapshot builder" exclusion is removed; the vendor credit note
    action hook is now held to the Preview / Print / Download vocabulary like every other
    purchases document. Suite green (16 tests).
  - `src/test/architecture/vendor-credit-note-events.test.ts` (new) — asserts every lifecycle
    transition routes through its server RPC in the owning module (reversal through the shared
    reversal engine, the rest through `useVendorCreditNotes.ts`), that the writer module never
    writes `vendor_credit_notes` directly, and that the action hook surfaces the full commercial
    lifecycle. Green (12 tests).

## Pending

- **6c — lineage capture in the forms.** `VendorCreditNoteCreatePage.tsx` / `EditPage.tsx` still
  omit origin, reason code, vendor document number/date and source references (bill / PO / GRN /
  return). The internal number field is editable client-side but ignored by the server — remove it.
  Totals preview math is duplicated across both pages; extract one shared component.
- **6d — record surface.** Linked-records panel for Bill / PO / GRN / Purchase Return lineage;
  dispute state surfaced in analytics tiles.
- **6e — dispute outcome.** `vendor_credit_notes` records `dispute_resolved_by/_at` but no
  outcome column; `vendor_credit_note_resolve_dispute` takes `_outcome` and discards it.

## Known out of scope

`expense` is registered reversible but `resolve_reversal_intent_finance` has no expense branch, so
`reversal-intent-coverage.test.ts` fails on that row. Pre-existing, belongs to Expenses.

Note: the full `src/test/architecture` suite exceeds a 10-minute run in this sandbox; run targeted
files rather than the whole directory.
