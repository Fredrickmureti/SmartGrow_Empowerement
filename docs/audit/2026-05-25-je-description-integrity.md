# Audit — Journal Entry Narration Integrity (2026-05-25)

**Status:** Closed. Fix shipped in migration `wave_12_je_narration_integrity`
(2026-05-22) and codified by ADR-0020.

## Symptom

Accountants saw rows like
`Stock adjustment a59edeec-7453-4816-9858-a3b6542ef5cd` in the journal-entry
ledger, the account register, and the AR/AP transaction drawer. The raw
UUID is unusable as a business reference.

## Root cause

A regression in `approve_stock_adjustment_atomic`. The function already
generates a human `adjustment_number` (sequence `get_next_adjustment_number`)
and stamps it on the `stock_adjustments` row, but the JE-posting block at
the bottom of the RPC ignored it and concatenated `p_adjustment_id::text`
instead.

Git archaeology:

| Migration | `_description` value | Status |
|---|---|---|
| 20260517193543 | `'Stock adjustment approved'` | OK (no UUID) |
| 20260521011736 | `'Stock adjustment approved (' \|\| reason \|\| ')'` | OK |
| 20260522152054 | `'Stock adjustment ' \|\| p_adjustment_id::text` | REGRESSED |
| 20260522154328 | same | REGRESSED |
| 20260522160049 | same | REGRESSED |

The 2026-05-22 trio added the `adjustment_number` sequence but forgot to
wire it into the JE narration.

## Scope sweep

`rg -n "_description\s*:=" supabase/migrations/` shows every other
auto-posting RPC already uses the source document's human number:

- `confirm_invoice_atomic` → `Invoice <invoice_number>`
- `confirm_delivery_atomic` → `COGS for delivery <delivery_number>`
- `issue_credit_note_atomic` → `Credit Note <credit_note_number>`
- `apply_payment_atomic` / `unapply_payment_atomic` → `<receipt_number>` + `<invoice_number>`
- `refund_customer_atomic` → `Customer refund — <reason>`
- `post_pos_shift_atomic` → `POS-SHIFT-<shift_number>`

Stock adjustments were the only non-conformant module. Payroll, depreciation,
opening stock, transfers, bank, and expense paths were inspected and clean.

## Fix

Migration **wave_12_je_narration_integrity** (2026-05-22 22:28 UTC):

1. **`approve_stock_adjustment_atomic`** — `SELECT` now fetches
   `adjustment_number`; `post_journal_entry_atomic` is called with
   `_reference := adjustment_number` and
   `_description := 'Stock adjustment <adjustment_number> (<reason>)'`.
2. **`backfill_missing_adjustment_je`** — same pattern.
3. **`enforce_journal_entry_immutability`** — extended with an opt-in
   "narration repair" mode. When `app.je_narration_repair = on` is set
   for the transaction, an UPDATE that touches *only* `description` /
   `reference` (every financial, lineage and status column equal) is
   permitted. All other paths still refuse.
4. **One-shot UPDATE** under that GUC rewrites every historical JE whose
   description matches the UUID regex
   `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`,
   replacing it with the readable form. Amounts, dates, lines, and
   `source_id` are untouched, so trial balance and reconciliation totals
   are unaffected.

## Architecture guard

`src/test/architecture/je-description-no-uuid.test.ts` scans every
migration timestamped at or after the Wave 12 cutoff for the pattern
`_description|_reference := ... || *_id::text`. Build fails on any
future regression in any module — not just stock adjustments.

## Out of scope (and why)

The user's original brief suggested a centralised "numbering engine" and a
"narration templating engine". The audit shows that infrastructure already
exists and is consistent — eight modules with `get_next_*_number` sequences
and a stable narration convention. Building a meta-engine to replace eight
working call sites would be net-negative churn and would force a rewrite
of historical posters. Explicitly excluded.

## Verification

- Linter warnings emitted by the migration tool are all pre-existing,
  project-wide `0010_security_definer_view` and `0011_function_search_path_mutable`
  noise that predates this work. The two functions changed here both
  carry `SET search_path TO 'public'`.
- Manual SQL to confirm the backfill:
  ```sql
  SELECT count(*) FROM journal_entries
  WHERE source_type = 'stock_adjustment'
    AND description ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  -- expected: 0
  ```
