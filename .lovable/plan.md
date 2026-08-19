# Bank Statement Import — 23514 investigation and repair

## Observed failure

`POST /rest/v1/rpc/bank_statement_import_batch` → 400, `23514`,
`new row for relation "bank_statements" violates check constraint "bank_statements_status_check"`.
Frontend renders the generic "Some of the information you entered is not valid."

## Root cause (proven, not inferred)

Database constraint (live):

```
bank_statements_status_check
CHECK (status = ANY (ARRAY['imported','reconciling','completed']))
```
Column default: `'imported'`, NOT NULL.

RPC `public.bank_statement_import_batch` (live definition):

- header INSERT passes `'processing'` literally, and the `ON CONFLICT ... DO UPDATE` sets `'processing'`
- the post-loop UPDATE sets `CASE WHEN rejected>0 AND inserted=0 THEN 'failed' ELSE 'completed' END`

So the RPC uses a four-value lifecycle (`processing → completed | failed`) while the table
enforces a three-value one (`imported → reconciling → completed`). `'processing'` fails on the
first INSERT; `'failed'` would fail immediately after any fix that only addresses `'processing'`.

Corroborating evidence: `select status, count(*) from bank_statements` returns **zero rows** —
no statement has ever been imported through this path since the constraint and the RPC diverged.

This is Possibility B/D from the brief (constraint and caller written against different lifecycle
revisions), not a mapping, preview, or reconciliation problem.

## Scope assessment: Outcome A (narrow), with two small adjacent defects

Checked and found **sound**, so out of repair scope:

- **Amount derivation is deterministic, not heuristic.** `applyColumnMapping` uses explicit
  semantic slots (`amount`, `credit`, `debit`, `balance`). With no Amount column mapped it takes
  `credit` when `credit > 0`, else `|debit|`; `balance` is a separate slot and is never treated as
  an amount. There is no fuzzy header matching and no auto-guessing anywhere in the wizard — the
  operator maps every column by hand, and the wizard refuses to continue without date, description
  and (amount or credit). Column labels like "Money In"/"Withdrawal" therefore work by mapping,
  not by inference. Nothing unsafe to remove.
- **Import performs no accounting.** The RPC inserts `bank_transactions` only
  (`lifecycle_status='for_review'`, `is_reconciled=false`) and publishes
  `banking.statement.imported`. There is **no active subscriber** on any `bank*`/`statement*` event
  type, so importing the Fredrick Mureti credit cannot create a second customer payment. The
  Undeposited Funds → Bank settlement stays a reconciliation-stage decision.
- Preview/import operate on the same normalized array (`finalTransactions`); no re-derivation.

Two real defects found alongside the status mismatch, repaired in the same wave:

1. **Zero-amount rows are importable.** `applyColumnMapping` keeps rows with `amount >= 0`, so an
   "Opening balance" line (Balance populated, Credit and Debit blank) becomes a `0.00` debit
   transaction and the RPC accepts it (`v_amount = 0` is not NULL). Cash is not double-counted
   (0.00), but the reconciliation workspace gets a meaningless line that can never be matched.
2. **Preview overstates readiness.** "N transactions ready" means only "parsed and mapped"; the
   only backend validation before Import is a duplicate-hash probe. Statement-level validation
   happens exclusively inside the RPC.

## Repair plan

**1. Settle the lifecycle (single source of truth).**
`bank_statements` is an *import batch header*, not a reconciliation session (reconciliation has its
own `bank_reconciliation_sessions`). Canonical lifecycle:

```text
imported  -> reconciling -> completed
   \-> failed (terminal: batch landed no rows)
```

`processing` is not observable — the RPC runs in one transaction — so it is removed rather than
legalised.

**2. Migration.** Add `'failed'` to `bank_statements_status_check` (documented terminal state) and
rewrite `bank_statement_import_batch` so the header INSERT/`DO UPDATE` writes `'imported'` and the
post-loop UPDATE writes `'completed'` or `'failed'`. No constraint is dropped or weakened; the
allowed set only gains the terminal failure state the engine genuinely needs.

**3. Zero-amount rows.** Reject them at both ends: `applyColumnMapping` filters rows whose derived
amount is `0` (the opening-balance line becomes statement metadata, not a transaction), and the RPC
rejects `amount = 0` into `rejected_rows` with a clear reason, so a feed cannot slip one in.

**4. Preview honesty (copy only).** Label the preview count "N transactions parsed" and show the
rejected-row reasons the RPC already returns on the done step.

Not touched: reconciliation, journal posting, transfer classification (transfers stay unclassified
bank observations matched at reconciliation time — correct as-is), date semantics
(`transaction_date` from the file, `posting_date` optional and currently unmapped — a single-date
model is intentional for CSV and is fine for the 19-Aug-2026 test).

## Regression tests

- `supabase/tests/bank_statement_ingestion_invariants_test.sql`: every status literal in
  `bank_statement_import_batch` must be a member of `bank_statements_status_check`'s allowed set
  (derived from `pg_constraint`, not hardcoded) — this class of drift can never return silently.
- Same file: engine rejects a zero-amount row rather than inserting it.
- `src/lib/bankStatementParsers/csvParser.test.ts`: an opening-balance row (Balance only) produces
  no transaction; Debit/Credit, Withdrawal/Deposit, Money Out/Money In and signed single-Amount
  layouts all normalize to the same signed model; Balance never becomes the amount.

## Verification evidence to produce after the repair

Import the Meridian file for account `010000000001` (KES) with the 19-Aug-2026 KES 1,670.40
Fredrick Mureti credit, then show: the created `bank_statements` row with `status='completed'` and
its counts; the 3 `bank_transactions` rows (opening balance excluded) with correct signs; the
Mureti row as `credit 1670.40, is_reconciled=false, lifecycle_status='for_review'`; and that no new
`payments`/journal rows were created by the import.

## Reconciliation implications

The Mureti receipt is already `Dr Undeposited Funds / Cr AR`. After import it exists once as a
bank-side observation. Settlement into Bank must come from the reconciliation stage, matching the
imported credit against the undeposited payment — the import path must stay non-posting, which the
tests above lock in.
