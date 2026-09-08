# Bank Reconciliation — Investigation Verdict and Reconstruction Plan

Single-company, multi-branch microfinance. Investigation completed against the live
database (ref xwxqunklduknceoryrha) and the repository. Every claim below is traced.

## 1. What exists today (verified)

Tables: `bank_accounts` (36 cols, has `branch_id`, `is_shared`, `account_id` GL link,
`lifecycle_status`, `opening_balance_je_id`, `currency`, `bank_reported_balance`),
`bank_transactions` (30 cols: `external_transaction_id`, `balance_after`,
`is_reconciled`, `journal_entry_id`, `branch_id`), `bank_reconciliation_sessions`,
`_items`, `_matches` (34 cols: `allocations` jsonb, `fee_*`, `exchange_rate`,
`evidence`, propose/confirm/reject/reverse actors), `_rules`, `_writeoffs`,
`bank_feed_connections`.

Server engine (all SECURITY DEFINER RPCs, no browser arithmetic):
`bank_statement_import_batch`, `bank_match_candidates` (16.9k chars),
`bank_match_propose/confirm/reject/reverse`, `bank_match_history`,
`bank_reconciliation_session_start/complete/reopen/cancel/writeoff`,
`bank_reconciliation_item_set`, `_bank_reconciliation_gl_tieout`,
`unreconcile_bank_transaction` + `bank_unmatch_preflight`,
`finance_bank_reconciliation_statement` (21.8k chars),
`enforce_bank_txn_scope_matches_account`, closed-period guards.

Frontend: `src/pages/BankReconciliation.tsx` (918 lines, tabs Transactions / Import
History / Reconciliation History / Match Suggestions), `src/pages/Banking.tsx`,
`src/pages/BankFeeds.tsx`, `src/lib/bankStatementParsers/*` (CSV/Excel, OFX, QIF),
`src/hooks/useBankMatchCandidates.ts`, `useReconciliationSessions/Items`,
`src/services/finance/bankReconciliationStatement.ts`, `bankUnmatchPreflight.ts`,
plus ~12 architecture guard tests already pinning the "one engine" rule.

Live data: 1 bank account (branch-scoped), 1 bank transaction (unreconciled),
1 collection banking, 0 sessions, 0 matches, 0 rules, 0 feed connections.

## 2. Verdicts

**Generic and reusable — preserve, do not rebuild.** Statement import with duplicate
detection, session lifecycle with GL tie-out and closed-period refusal, the
propose/confirm/reject/reverse match state machine with server-authored evidence and
un-match pre-flight, the reconciliation statement engine, branch scope enforcement.
This is a sound, falsifiable reconciliation subsystem. Rule 28 applies: reuse it.

**Domain-model defect (the real problem).** `mf_bank_collection_batch`
(migration 20260903193355) posts the banking journal entry *and then inserts a row
into `bank_transactions`* with `external_transaction_id = 'mf-collection-banking-<uuid>'`,
`journal_entry_id` set and `is_reconciled = false`. In this engine
`bank_transactions` is the **statement side** — what the bank says. The microfinance
banking flow is using it as the **book side**. Consequences:
- the line the screenshot shows ("Banking of collection batch") is not a bank
  statement line at all; it is the institution's own posting masquerading as one;
- when the real statement is imported, the same deposit arrives again under the
  bank's own reference, and duplicate detection cannot see the relationship;
- the reconciliation statement and match-rate KPIs count a book entry as an
  unreconciled bank item, so the proof can never balance.

**Matching engine coupling.** `bank_match_candidates`, `_bank_match_validate` and
`bank_match_confirm` search `public.payments`, `public.invoices`, `public.bills`.
They contain no reference to `mf_repayments`, `mf_repayment_batches`,
`mf_collection_bankings` or `mf_loan_disbursements`, and `bank_match_candidates`
never looks at `bank_transactions.journal_entry_id`. So a banked collection deposit
returns tier `unresolved` — the engine is not wrong, it is simply blind to the two
document kinds this product actually banks. This is a coupling/coverage gap, not a
rewrite trigger.

**Terminology.** "invoices, bills, and expenses" in `BankReconciliation.tsx:313`
and `:728` is honest about what the engine queries — it is a symptom of the coverage
gap above, not a stray label. Fix the engine first, then the words.

**Bank feeds.** `bank_feed_connections` + `bank_feed_connection_resolve` +
provider/token columns on `bank_accounts` exist with zero rows; `BankFeeds.tsx` is in
fact a categorisation screen (`handleCategorize`, AI suggestions), not a feed client.
No provider integration exists. Do not build one — statement import plus manual entry
is what a branch microfinance operation needs.

**Multi-branch.** Sound: `bank_accounts.branch_id` + `is_shared` already model both
branch and Head Office / shared accounts, and
`enforce_bank_txn_scope_matches_account` stops a transaction drifting to another
branch. No change required.

**Multi-currency.** `bank_transactions` has no currency column; the account's
currency is implied and `bank_reconciliation_matches.exchange_rate` carries the
booking rate. Acceptable for a single-currency institution; recorded as a known
limitation, not this wave's work.

**Authorization / audit.** `assert_can_reconcile_bank` plus RLS already gate the
domain; matches record proposer, confirmer, rejecter and reverser. Integrate with the
Access Groups work rather than adding anything new.

## 3. Verified data flow (and the break)

```text
Client -> Loan -> Repayment (mf_repayments, posted)
      -> Batch (mf_repayment_batches, closed)
      -> mf_bank_collection_batch
             |-- journal entry (Bank Dr / Cash+MobileMoney Cr)   correct
             |-- mf_collection_bankings row (append-only)        correct
             \-- bank_transactions row  <-- WRONG SIDE of the reconciliation
Real bank statement -> bank_statement_import_batch -> bank_transactions
      -> bank_match_candidates  (searches payments/invoices/bills only)
      -> no candidate for the deposit -> never reconcilable
```

## 4. Terminology map

| Current term | Actual meaning | Verdict | Target | Reason |
| --- | --- | --- | --- | --- |
| Bank Reconciliation | statement-to-ledger proof | Valid | keep | standard accounting |
| Transactions | statement lines | Valid but ambiguous | "Bank statement lines" | must read as bank-side |
| Import History | statement import batches | Valid | keep | |
| Reconciliation History | completed sessions | Valid | keep | |
| Match Suggestions / Auto-Match | candidate engine output | Valid | keep | evidence-based, not a score |
| Rules | pattern -> counterpart account categorisation | Valid, generic | keep, branch-scoped | bank charges, interest |
| Unreconciled / Reconciled | statement line state | Valid | keep | |
| "invoices, bills, and expenses" | literally what the engine queries | Legacy coupling | "banked collections, disbursements, expenses and transfers" — after Wave 2 | wording follows the engine |
| "Banking of collection batch" line | book-side posting in a bank-side table | Legacy/defect | becomes a match candidate, not a statement line | Wave 1 |

## 5. Waves

### Wave 1 — Stop the collection banking from fabricating statement lines
- **Objective**: `mf_bank_collection_batch` records a deposit awaiting the bank, not a bank statement line.
- **Current state**: migration 20260903193355 inserts into `bank_transactions`; 1 such row exists in the live database.
- **DB**: new migration replacing `mf_bank_collection_batch` (single-purpose, per project rule) — drop the `bank_transactions` insert, keep the journal entry and the `mf_collection_bankings` row; a second small migration retires the one existing synthetic line (mark `lifecycle_status`, do not delete history).
- **Backend**: none beyond the RPC. **Frontend**: none.
- **Accounting**: unchanged — the journal entry was always correct.
- **Tests**: SQL guard asserting `mf_bank_collection_batch` never inserts into `bank_transactions`; guard that every `bank_transactions` row has an import batch, feed or manual-entry origin.
- **Acceptance**: banking a batch posts one journal entry and one banking record; the reconciliation screen shows no self-created line.
- **Risks**: the existing row is referenced by `mf_collection_bankings.bank_transaction_id` — retire, don't delete. **Rollback**: re-apply prior function body.

### Wave 2 — Teach the candidate engine the microfinance document kinds
- **Objective**: a real bank deposit matches the collection banking that produced it; a disbursement debit matches its disbursement.
- **Current state**: `bank_match_candidates` / `_bank_match_validate` / `bank_match_confirm` know only payments, invoices, bills; no `mf_*` source; `journal_entry_id` unused.
- **DB**: add candidate kinds `collection_banking` (from `mf_collection_bankings`: amount, `banked_on` +/- tolerance, `reference` = batch number, same branch and bank account) and `disbursement` (from `mf_loan_disbursements`), plus the matching validate/confirm branches that stamp `bank_transactions.reconciled_type/entity_id` and link the existing journal entry instead of posting a new one. One migration per function.
- **Accounting**: confirming links an already-posted entry — no new posting, so idempotent; un-match keeps `link_only` semantics in `bank_unmatch_preflight`.
- **Authorization**: unchanged (`assert_can_reconcile_bank`).
- **Tests**: SQL scenarios — banked batch vs imported deposit (deterministic tier), two same-amount batches (ambiguous), cross-branch deposit (no candidate), re-confirm (idempotent).
- **Acceptance**: importing the branch statement yields a "Certain" candidate naming the batch, and confirming reconciles without a second journal entry.
- **Dependencies**: Wave 1.

### Wave 3 — Split and aggregate cases that this domain really has
- **Objective**: one bank credit settling several banked batches, and a deposit net of a bank charge.
- **Current state**: `bank_reconciliation_matches.allocations` jsonb, `fee_amount`, `fee_account_id` and `residual_amount` already exist and are honoured by confirm; only the new kinds need wiring into them.
- **Tests**: multi-batch deposit; deposit short by a bank charge posting the fee line; partial with residual refused when unexplained.
- **Dependencies**: Wave 2. Small wave — mostly coverage.

### Wave 4 — Terminology and screen alignment
- **Objective**: the page states the model Waves 1-3 established.
- **Frontend**: `src/pages/BankReconciliation.tsx` (lines 307-320, 452-470, 724-740) — subtitle names banked collections, disbursements, expenses and transfers; "Transactions" tab reads as bank statement lines; candidate copy in `src/hooks/useBankMatchCandidates.ts` `TIER_COPY` reviewed; `BankFeeds.tsx` renamed to what it does (categorise imported lines), no feed promise.
- **DB**: none — no table or column renames (project rule).
- **Tests**: extend existing architecture guards; no new engine.
- **Dependencies**: Wave 2 (words follow behaviour).

### Wave 5 — Documented non-work (explicit decisions)
- No bank-feed provider integration; `bank_feed_connections` stays dormant scaffolding, documented as such.
- No currency column on `bank_transactions` while the institution is single-currency.
- No second reconciliation, import, matching or rules engine.
- Orphaned ERP reconciliation artefacts touching this domain (invoice/bill candidate branches) stay in place — they are harmless and shared with the retained payments module; removal belongs to the legacy cleanup wave.

## 6. Handoff state
Investigation is complete; nothing has been changed yet. Unresolved decision for the
user: whether manual bank-transaction entry should exist alongside statement import
for branches whose bank sends paper statements.


=================IMPLEMENTATION PROGRESS==============

## Verified complete (re-checked against the live database, 2026-09-08)

- **Wave 1 — done.** `mf_bank_collection_batch` no longer inserts into
  `bank_transactions`; its body carries the ADR comment stating that
  `bank_transactions` is the statement side only. The journal entry and the
  `mf_collection_bankings` row are unchanged.
- **Wave 2 — done.** `bank_match_candidates` (20.1k) now emits kinds
  `payment`, `collection_banking`, `bill_payment`, `disbursement`, `transfer`,
  `invoice`, `bill`, `account`. Collection-banking candidates require same
  business, same bank account, matching branch, amount within 0.005, banked_on
  in −14/+7 days of the statement date, `bank_transaction_id IS NULL`, and no
  live match already claiming them. `_bank_match_validate`, `bank_match_confirm`,
  `bank_unmatch_preflight` and `unreconcile_bank_transaction` all handle the new
  kinds; confirming links only — no second posting.
- **Wave 4 (wording) — done.** `BankReconciliation.tsx:313` now reads "Match bank
  statement lines with banked collections, loan disbursements, expenses and
  transfers"; the Match Suggestions help text (≈:726) names banked collections and
  loan disbursements instead of invoices/bills/supplier payments.
  `useBankMatchCandidates.ts` carries the full kind union plus
  `CANDIDATE_KIND_LABEL` (single place that turns a machine kind into words).
  `ReconcileTransactionSheet` passes the widened kinds through to the seam.

## Known residue (one row, deliberately left)

The legacy synthetic line `ebc9baec-085e-4ba9-a8b5-c094fe4b50f6` ("Banking of
collection batch BATCH-001") is already `lifecycle_status = 'excluded'`, so it no
longer appears as an unreconciled bank item. Its `mf_collection_bankings` row
(`1f71927a-…`) still points at it, and `mf_collection_bankings_append_only()`
refuses to clear a confirmed `bank_transaction_id` ("This banking is already
confirmed against a bank statement line"). Because `bank_match_candidates`
requires `bank_transaction_id IS NULL`, that single banking can never be matched
to a real imported deposit.

**Next agent action (only if this matters on real data):** one migration relaxing
`mf_collection_bankings_append_only()` so a link may be cleared when the target
`bank_transactions` row is `lifecycle_status = 'excluded'`, then clear the link.
It is one test row today — do not expand scope for it.

## Wave 3 — DONE (verified in the live database, 2026-09-08)

No SQL change was needed: `_bank_match_validate` already loops over
`jsonb_array_elements(_allocations)` and balances their sum against
`abs(bank line) ± fee`, so **one bank credit may settle several banked
collection batches** (each at its full amount, same account, unclaimed,
same branch/company). A bank charge against a banked batch or a disbursement is
deliberately REFUSED (`BANK_MATCH_FEE_ON_DIRECT_PAYMENT`): those journals posted
the gross amount to this bank account, so the charge must be its own statement
line rather than being netted invisibly.

Ratchet added: `supabase/tests/bank_collection_banking_match_invariants_test.sql`
asserts Wave 1 (no statement-line fabrication in `mf_bank_collection_batch`),
Wave 2 (all five seam members handle `collection_banking` / `disbursement`,
candidates read `mf_collection_bankings` / `mf_loan_disbursements` and skip
already-linked bankings) and Wave 3 (allocation iteration, `BANK_MATCH_UNBALANCED`,
full-amount + single-claim + same-account + direction + fee refusals, mixed-kind
and cross-branch/company refusals, link-only un-match).

## Wave 4 — DONE

`BankFeeds.tsx` now says what it does: title "Statement Lines", subtitle
"N imported bank statement lines need review". Nav label "Statement lines"
(`src/apps/finance/nav.ts`), registry name "Statement Lines"
(`src/lib/apps/registry.ts`). Route `/finance/bank-feeds` and the file name are
unchanged on purpose — the architecture guard
(`src/test/architecture/bank-feeds-business-level-gating.test.ts`, 9/9 green)
and all consumers key on them; renaming the route is a separate controlled move.

## Still open
I fixed the reconciliation residue and started the manual statement-line entry, but ran out of room to finish it.

Done and verified:

Collection bankings can now be released from a retired (excluded) statement line — every other field stays append-only, and re-pointing to a different line is still refused.
The leftover test banking is now unlinked (0 of 1 still linked), so the real deposit can be matched when the bank statement arrives.
Started, not finished: a small "Add a statement line" form for branches whose bank only sends paper or PDF statements. It routes through the same server import engine as a file upload, so a typed line gets identical duplicate detection, rules and period checks. The form itself is written and imported into the Bank Reconciliation page, but the button that opens it hasn't been added to the page header yet — so it isn't reachable in the app.

Still open from earlier: the accounting engine compares journal status against voided while the real value is void; that must be corrected before end-to-end repayment testing passes.


