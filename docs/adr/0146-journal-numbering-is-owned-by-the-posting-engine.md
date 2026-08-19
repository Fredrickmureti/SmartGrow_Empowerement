# ADR 0146 — Journal numbering is owned by the posting engine

Status: accepted (2026-08-19)
Related: ADR 0123 (single journal writer), ADR 0145 (bank account is a server-owned identity)

## Context

`journal_entries.entry_number` is `NOT NULL` with no default and no trigger.
`post_journal_entry_atomic` — the only writer of journal rows (ADR 0123) — took
`_entry_number text` as a *required caller-supplied* value and inserted it
verbatim. Every caller therefore had to remember to pre-number its entry.

Callers that forgot failed at runtime with
`23502 null value in column "entry_number"`. This recurred across domains
(employee loan disbursement, stock adjustment posting, and finally bank account
opening balances) and each occurrence was patched at its own call site instead of
at the seam.

Two numbering engines also existed:

- `generate_next_je_number(org, business)` — business-scoped, advisory-locked,
  refuses a NULL `business_id` (multi-company isolation). Canonical.
- `get_next_journal_entry_number(org)` — org-scoped `JE-00001`, no business
  isolation. Two sequences over one column can collide across companies.

## Decision

1. Numbering lives **inside** `post_journal_entry_atomic`. When
   `_entry_number IS NULL` the engine calls `generate_next_je_number(_org_id,
   _business_id)`. Explicit numbers keep working, so no caller changed behaviour.
2. `entry_number` gets **no** column default and **no** trigger. Numbering is
   engine behaviour, not storage behaviour.
3. `get_next_journal_entry_number` is retired. Its callers (POS, inventory,
   sales, manual JE) pass `NULL` and let the engine number.
4. Clients never mint entry numbers. `useGLPosting` and `useJournalEntries` pass
   `null`; the previous `JE-${Date.now()}` fallbacks are removed — a client-minted
   number is a second numbering engine with no isolation and no lock.
5. Entry classification (`is_opening_entry`, closing/adjusting) is passed **into**
   the engine, so entries are born with their final flags. A post-insert `UPDATE`
   is illegal: the immutability trigger refuses to modify a posted entry.

## Consequences

- Numbering cannot be forgotten by a caller, so the 23502 class is closed.
- One sequence per (org, business); no cross-company collisions.
- Ratchet: `supabase/tests/journal_numbering_engine_test.sql` pins that the
  engine self-numbers, refuses to number without a business, that
  `generate_next_je_number` is the only generator, that `entry_number` still has
  no default, and that no caller hardcodes a `JE-` literal.
