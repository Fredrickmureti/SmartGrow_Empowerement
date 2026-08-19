# Banking → Finance opening-balance posting: root cause and repair

## Verified root cause (proved against the live database)

`bank_account_create` does **not** contain accounting logic; it creates identity,
then delegates the accounting event to `_bank_account_post_opening_balance`,
which correctly calls the canonical writer `post_journal_entry_atomic`.

The defect is in the **contract of the canonical writer**:

- `post_journal_entry_atomic(...)` takes `_entry_number text` as a *required
  caller-supplied* value and inserts it verbatim. It never numbers an entry
  itself.
- `journal_entries.entry_number` is `NOT NULL` with **no default and no trigger**
  (pinned deliberately by `supabase/tests/loan_gl_posting_test.sql`).
- `_bank_account_post_opening_balance` passes `NULL` positionally in the
  `_entry_number` slot (the `OB-BANK-…` string it builds is the *reference*, not
  the number) → `23502 null value in column "entry_number"`.

This is a **recurring class defect**, not a Banking bug. Every caller must
remember to pre-number. Three callers still pass `NULL`, all in Banking:

| Function | Business event | Status |
|---|---|---|
| `_bank_account_post_opening_balance` | bank opening balance | fails 23502 (observed) |
| `bank_reconciliation_session_complete` | reconciliation service charge | latent 23502 |
| `bank_reconciliation_session_writeoff` | reconciliation write-off | latent 23502 |

The same 23502 already hit `employee_loan_disburse` and stock-adjustment posting
in earlier waves; each was patched at its own call site instead of at the seam.

Second finding: **two numbering engines exist.**
- `generate_next_je_number(org, business)` — business-scoped, refuses a NULL
  `business_id` (multi-company isolation), advisory lock per business. Canonical.
- `get_next_journal_entry_number(org)` — org-scoped `JE-00001`, no business
  isolation, still used by `backfill_missing_adjustment_je` and others.
Two sequences over one `entry_number` column can collide across companies.

## Affected business event and canonical owner

- Business event: *bank opening balance recognition* — a real accounting event
  (Cash/Bank debit vs Opening Balance Equity credit), correctly modelled today
  with `source_type = 'opening_balance'`, `is_opening_entry = true`, FX resolved
  via `require_exchange_rate` (ADR 0136), idempotent through
  `bank_accounts.opening_balance_je_id`, event published to the outbox.
- Bank *identity* creation is not an accounting event and must post nothing when
  `opening_balance = 0` — already true.
- Canonical owner of numbering: Finance, inside `post_journal_entry_atomic` via
  `generate_next_je_number`. Banking must not number anything.

## Architectural decision

1. Move numbering **into** the canonical writer: when `_entry_number IS NULL`,
   `post_journal_entry_atomic` calls `generate_next_je_number(_org_id,
   _business_id)`. Explicit numbers keep working, so no existing caller changes
   behaviour. No new engine, no default, no trigger — the loan test's invariant
   ("no column default/trigger; numbering belongs to `generate_next_je_number`")
   stays true.
2. Retire the duplicate `get_next_journal_entry_number`: repoint its callers at
   the canonical engine, then drop it.
3. Leave Banking's opening-balance semantics as they are — they are already
   correct (single GL truth, no shadow balance: `bank_account_positions()` is the
   derived position and `current_balance` is no longer read by
   `useBankAccounts`).

## Implementation phases

**P1 — Finance seam.** Migration: `post_journal_entry_atomic` self-numbers on
NULL `_entry_number`; add a period/scope-safe guard that `_business_id` is
present when numbering.

**P2 — Duplicate numbering engine.** Repoint remaining
`get_next_journal_entry_number` callers to `generate_next_je_number`, drop the
old function.

**P3 — Ratchets.** SQL test asserting (a) `post_journal_entry_atomic` numbers
when the caller omits the number, (b) no `pg_proc` body other than
`generate_next_je_number` derives an entry number from `MAX(entry_number)`,
(c) `entry_number` still has no default/trigger.

**P4 — Simulation A (bank account).** Create *Test Operating Bank – KES* /
Meridian Commercial Bank / 010000000001 / KES / 2026-08-01 / 50,000.00 through
the UI. Verify: identity row scoped to org+business+branch, GL link, one posted
balanced JE dated 2026-08-01 with a canonical `JE-…` number, `is_opening_entry`,
`opening_balance_je_id` set, outbox events emitted, retry posts no second JE,
`bank_account_positions()` = 50,000.00 = GL balance of the linked account.

**P5 — Simulation B (reconciliation).** Fredrick Mureti invoice 00002 KES
1,670.40 → payment to Undeposited Funds → statement import through
`bank_statement_import_batch` → match/reconcile. Verify the match mints no
second payment (ADR 0123), the service-charge and write-off paths now number
correctly, and bank position, GL, reconciliation and cash reporting agree.

**P6 — ADR + memory.** ADR: "journal numbering is owned by the posting engine";
update `mem/features/banking-domain.md` and the Core memory line on ADR 0123.

## Verification evidence required per phase

Phase is complete only with: the SQL/RPC output showing the posted entry, the
position/GL agreement query, and the ratchet test run. HTTP 200 alone is not
evidence.

## Remaining dependencies / open risks

- `post_journal_entry_atomic` performs no fiscal-period lock check; an opening
  entry dated 2026-08-01 will post even into a locked period. To confirm during
  P4 and escalate into Finance if unguarded.
- Six existing `journal_entries` rows use mixed formats (`JE-…` vs others); the
  self-heal `MAX()` scan in `generate_next_je_number` must be checked against
  them in P1.
