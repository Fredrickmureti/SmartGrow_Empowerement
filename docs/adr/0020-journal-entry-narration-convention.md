# ADR 0020 — Journal Entry Narration Convention

**Status:** Accepted (2026-05-22)
**Related:** audit `docs/audit/2026-05-25-je-description-integrity.md`

## Context

Auto-posted journal entries (sales, COGS, payments, credit notes, POS
shift settlement, stock adjustments, etc.) feed the account register, AR/AP
drawers, and statement exports. Accountants use the narration to identify
the source document without opening it. Raw UUIDs there are unusable.

A 2026-05-22 regression in `approve_stock_adjustment_atomic` exposed the
gap: it stamped `'Stock adjustment ' || p_adjustment_id::text` even though
a human `adjustment_number` already existed on the row.

## Decision

Every auto-posting RPC MUST follow this contract when calling
`post_journal_entry_atomic`:

1. **`_reference`** = the source document's human-readable number
   (`invoice_number`, `adjustment_number`, `receipt_number`,
   `delivery_number`, `shift_number`, `credit_note_number`, …).
2. **`_description`** = `'<Doc kind> <doc number> (<event qualifier>)'`.
   Examples:
   - `Invoice INV-2026-00411 confirmed`
   - `Stock adjustment ADJ-2026-00014 (shrinkage)`
   - `POS-SHIFT-0451 settlement`
3. **`_source_type` / `_source_id`** — UUID FK to the originating row.
   Stays internal. NEVER concatenated into `_description` or `_reference`.

Concretely forbidden in any migration at or after the Wave 12 cutoff
(`20260522222833`):

```sql
_description := '...' || <any>_id::text   -- FORBIDDEN
_reference   := '...' || <any>_id::text   -- FORBIDDEN
```

Enforced by `src/test/architecture/je-description-no-uuid.test.ts`.

## Posted-entry repairs

Narrations on posted entries are normally immutable. ADR-0020 grants one
narrow escape hatch: when the session GUC `app.je_narration_repair = on`
is set, `enforce_journal_entry_immutability` allows an UPDATE that touches
*only* `description` and/or `reference` while every financial, lineage,
and status column stays equal. Used by one-shot backfills like the Wave 12
UUID-narration rewrite. NOT to be enabled from application code.

## Consequences

- New posting RPCs must `SELECT` the source row's human number alongside
  any other fields they need, and must wire it into both `_reference` and
  `_description`.
- The architecture test catches future regressions in every module, not
  just stock adjustments.
- The numbering-engine / narration-DSL redesign that was originally
  proposed is explicitly OUT of scope — eight modules already follow the
  convention; the only fix needed was to keep them honest.
