# Make GL cross-references human-readable (no UUID fragments)

## My take: you are right, and it is a systemic slip, not a one-off

Journal entries carry two identifiers: their own number (`JE-00008`, sequential
and correct everywhere) and a **reference** — the string an accountant uses to
tie the entry back to the document that caused it. On the good paths that
reference is the source document's real number:

| Entry | Reference | Verdict |
|---|---|---|
| JE-00006 payment | `PMT-RCP-000001` | correct — quotes the receipt number |
| JE-00005 delivery | `COGS-DN-2026-0002` | correct |
| JE-00002 invoice | `00001` | correct (invoice number) |
| JE-00008 bank deposit | `BDEP-7534e575` | wrong — first 8 hex chars of the match UUID |
| JE-00007 bank opening balance | `OB-BANK-cf817a72` | wrong — first 8 hex chars of the bank account UUID |

Two database functions build those two strings: `bank_match_confirm`
(`'BDEP-' || substr(match_id::text,1,8)`) and
`_bank_account_post_opening_balance` (`'OB-BANK-' || left(account_id::text,8)`).
The same habit exists in three more GL writers — `expense_submit` (`EXP-`),
`disburse_employee_advance` (`ADV-`), `record_vendor_advance_payment`
(`VADV-`) — and in one branch of `approve_stock_adjustment_atomic` (`ADJ-`),
even though `expenses.expense_number` and `stock_adjustments.adjustment_number`
already exist and would read properly.

Why it matters beyond looking odd: a hex slice is unpronounceable on a phone
call, unsearchable ("was it cf81 or cf18?"), sorts meaninglessly, and — being
truncated — can collide, so two unrelated entries can share a reference.

The project already owns the fix: `get_next_document_number(...)` — advisory
locked per org, trailing-counter parse, collision retry — which the whole
commercial and warehouse side uses.

## Plan

### 1. Let the shared authority mint hyphenated prefixes
`get_next_document_number` currently rejects any prefix that is not a single
run of uppercase letters. Relax it to allow internal hyphens (`OB-BANK`) so the
existing `PREFIX-YYYY-NNNN` output and the trailing-counter parse stay exactly
as they are. No existing caller changes behaviour.

### 2. Bank deposit clearing reference
`bank_match_confirm` mints `BDEP-2026-0001` from the shared authority
(`journal_entries.reference`, scoped by organization + business) instead of the
match UUID slice.

### 3. Bank opening balance reference
`_bank_account_post_opening_balance` mints `OB-BANK-2026-0001`. The bank account
name already appears in the entry description ("Opening balance - Equity Bank"),
so the reference carries the sequence and the description carries the identity.

### 4. Prefer an existing document number where the source already has one
- `expense_submit` → `EXP-<expenses.expense_number>`
- `approve_stock_adjustment_atomic` → `ADJ-<adjustment_number>` on both branches
- `disburse_employee_advance` / `record_vendor_advance_payment` → the advance's
  own number where present, otherwise a minted sequence (`ADV-2026-0001`,
  `VADV-2026-0001`)

### 5. Stop it coming back
Extend the existing numbering ratchet (`supabase/tests/document_numbering_no_clock_test.sql`)
to fail when any function builds a reference from a UUID slice, `md5`, or an
epoch — with an explicit allow-list for machine-only barcodes/licence plates.
Add a pgTAP assertion that a confirmed bank match and a posted bank opening
balance both produce `PREFIX-YYYY-NNNN`.

### History
Existing entries keep their current references — posted GL text is repaired
forward, never rewritten. That leaves JE-00007 and JE-00008 with their old hex
strings; say the word if you want those two demo rows relabelled by hand as a
separate data fix.

## Technical notes
All of steps 1–4 are database migrations against existing functions; no frontend
change is needed because every surface (register, drawer, journal list) already
renders `journal_entries.reference` verbatim. Step 5 is a SQL test file edit.
