# Business Reversal & Compensation Convergence

Authoritative status. Update after every implementation.

## Active phase
Phase 2 — Consequence Preview (backend done, UI pending).

## Phase 0 — Restore reversal capability — DONE, VERIFIED
- `void_journal_entry_atomic` now stamps `organization_id` (and scope columns) on mirrored reversal lines.
- `default_je_line_context_from_parent` backfills scope columns from the parent entry.
- Verified: single overload, zero rogue writers into `journal_entry_lines`, posting-monopoly suite 11/11 green, `supabase/tests/journal_reversal_scope_test.sql` added.

## Phase 1 — Reversal intent policy — DONE, VERIFIED
- `payment_is_bank_reconciled(uuid)`, `resolve_reversal_intent(text, uuid)` — single authority on which reversal operation is legal.
- `void_invoice_atomic` refuses settled / bank-reconciled / closed-period voids and hard-errors on `_cascade_payments = true`.
- `useTransactionReversal.ts`: `resolveReversalIntent`, no client-side credit-note or cascade logic.
- `VoidInvoiceDialog.tsx`: shows blockers, offers only legal alternatives (credit note, refund, payment reversal wizard).
- 12 guard tests in `src/test/architecture/reversal-intent-policy.test.ts`.
- Runtime verification against a real settled invoice: `blockers = [settled]`, `recommended = credit_note`, 4 operations returned.
- Fix applied during verification: blocker array append was untyped (`text[] || 'settled'`) and raised 22P02 for every blocked document; each append is now `::text`.

## Phase 2 — Consequence preview — IN PROGRESS
Done:
- `preview_reversal_consequences(text, uuid)` — STABLE, read-only projection of GL impact (inverted legs), stock restoration lines, settlement releases, and business warnings (fiscalized invoice, linked delivery notes, existing credit notes).
- Verified live: returns GL total reversed and warnings for a real invoice.

Pending (next work):
1. `previewReversalConsequences` in `src/hooks/useTransactionReversal.ts`.
2. New `src/components/reversal/ReversalConsequencePreview.tsx` rendering GL / stock / money / warnings.
3. Mount the preview in `VoidInvoiceDialog.tsx` (and the payment reversal wizard) so no reversal is confirmed blind.
4. Architecture guard test: every reversal confirmation surface must render the preview.

## Phase 3 — Purchases / AP / GRN landed-cost reversal — NOT STARTED
## Phase 4 — Warehouse tasks & bank reconciliation participation — NOT STARTED
## Phase 5 — Unified governance, audit outbox, ADR consolidation — NOT STARTED

## Instructions for the next agent
1. Verify first, then build. Confirm Phase 0–2 backend claims independently: `resolve_reversal_intent` and `preview_reversal_consequences` against a settled invoice, an unsettled invoice, and a payment; confirm `void_invoice_atomic` rejects a settled void; run the architecture suites.
2. Then resume at Phase 2 pending item 1 and finish Phase 2 end-to-end (hook → component → both dialogs → guard test) before touching Phase 3.
3. Stay chronological. Do not start Phase 3+ work, do not leave a dialog half-wired, and keep every reversal path routed through the canonical writers and the intent policy.
