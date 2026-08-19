# Reconciliation Engine — Authoritative Project Status

Source of truth for this wave. Full design rationale and findings F1–F9 live in
`.lovable/plan/reconciliation-engine-execution-plan-2026-08-19.md`; this file
tracks what is done, what is not, and what happens next.

Last updated: 2026-08-19 (verification turn 2 — independent audit of the
previous engineer's claims, plus Phase 8 execution).

## Verification verdict (turn 2)

Every "Implemented" claim below was re-checked against the **live database**
(`pg_proc` definitions, ACLs, indexes) and the **current client code**, not
against the previous engineer's notes.

| # | Phase | Claim | Verdict | Evidence |
|---|-------|-------|---------|----------|
| 1 | Validator extension | Implemented | **Pass** | `_bank_match_validate` (single overload, pinned `search_path`, STABLE): per-kind direction checks, cross-company `42501`, cross-branch, currency-vs-bank-account, over-allocation, mixed kinds, and the gross amount law `Σalloc = |txn| ± fee` |
| 2 | Fee model + clearing resolutions | Implemented | **Pass** | `bank_match_confirm`: clearing branch posts bank↔holding only and never calls a settlement engine; fee is its own two-line `BFEE-` entry; residual its own `BADJ-` entry; documents settle gross |
| 3 | Kind-aware reversal delegate | Implemented | **Pass (with F11, now fixed)** | `unreconcile_bank_transaction` delegates to `void_payment_atomic` / `void_bill_payment_atomic` / `void_journal_entry_atomic`, voids residual+fee+write-off entries, marks matches `reversed` (never deletes) |
| 4 | Candidate/evidence engine | Implemented | **Pass** | `bank_match_candidates(_txn_id,_limit)` asserts membership, returns evidence; `get_reconciliation_match_suggestions` confirmed **absent** from the database |
| 5 | Transfer folded into the seam | Implemented | **Pass** | `reconcile_bank_transfer_atomic` is a pure wrapper over `bank_match_propose` + `bank_match_confirm`; unique index `bank_reconciliation_matches_one_confirmed` exists |
| 6 | Rules subordinate to accounting truth | Implemented | **Pass** | `apply_reconciliation_rules` asserts membership, skips with `DOCUMENT_CANDIDATE_EXISTS`, proposes through the seam |
| 7 | Client workspace | Implemented | **Pass** | `useBankMatchCandidates.ts` → `bank_match_candidates`; `useBankTransactions.ts` → one `propose`+`confirm` per line with N allocations and `_fee_amount`; `TransferReconcileSheet.tsx` → wrapper only |
| 8 | Validation & ratchets | Partially done | **Now complete** | see below |
| 9 | ADR | Implemented | **Pass (renumbered)** | now `docs/adr/0147-a-bank-line-is-explained-not-guessed.md` |

Privilege check (live): none of `bank_match_propose/confirm/reject/reverse`,
`bank_match_candidates`, `unreconcile_bank_transaction`,
`reconcile_bank_transfer_atomic`, `apply_reconciliation_rules` grant EXECUTE to
`anon` or `PUBLIC`; all are SECURITY DEFINER with `search_path=public` and have
exactly one overload.

## New findings from this audit (both fixed this turn)

**F10 — a bank charge could ride on a receipt already banked here.**
- Evidence: in `bank_match_confirm`'s clearing branch, an allocation whose
  holding account equals the bank's own GL is skipped (`CONTINUE`), so
  `_clearing` excludes it. With `fee_amount > 0` and every allocation direct,
  no clearing entry is posted but the `BFEE-` entry still credits the bank —
  bank delta `-fee` instead of the statement amount.
- Impact: the reconciled bank balance would disagree with the statement.
- Change: `_bank_match_validate` now refuses with
  `BANK_MATCH_FEE_ON_DIRECT_PAYMENT` for both `payment` and `bill_payment`.
  (The `bill_payment` branch also now resolves its holding account, which it
  previously never read.)

**F11 — reversal could overstate a document balance.**
- Evidence: `unreconcile_bank_transaction` fell through to
  `void_journal_entry_atomic(_txn.journal_entry_id)` when
  `_kind = 'invoice'/'bill'` but `matched_payment_id` / `matched_bill_payment_id`
  was NULL — voiding the settlement journal while leaving
  `invoices.amount_paid` / `bills.amount_paid` and the allocations intact.
- Impact: silent AR/AP corruption; the document reads as paid with no payment.
- Change: refuses with `BANK_UNRECONCILE_MISSING_SETTLEMENT`.

## Phase 8 — closed this turn

1. `supabase/tests/bank_match_resolution_invariants_test.sql` (new): contract
   assertions for every resolution kind, the refusal vocabulary, the gross
   amount law, the kind-aware reversal, the one-confirmed-match index and rule
   subordination — plus two behavioural blocks (self-rolled-back): the
   undeposited-receipt clearing scenario (no duplicate payment, bank leg equals
   the statement exactly once, holding account drains to zero, repeat confirm is
   a no-op, receipt cannot be deposited twice, reverse leaves the receipt valid)
   and composed-row refusals (unbalanced, cross-company, unknown kind, wrong
   direction, partial deposit, charge-on-direct).
2. `supabase/tests/banking_privilege_ratchet_test.sql` extended: the evidence
   engine, transfer wrapper, reversal delegate and rules engine are asserted
   single-overload, SECURITY DEFINER, `search_path`-pinned, not `anon`-callable,
   and membership-asserting; the retired suggestion RPC must stay absent.
3. `src/test/architecture/banking-match-resolution.test.ts` extended (10 tests,
   green): no client write to `bank_reconciliation_matches`; a transfer uses the
   wrapper and never a hand-rolled propose/confirm; undo routes through
   `unreconcile_bank_transaction` and never deletes journal rows; no client-side
   account resolution or journal posting.
4. ADR renumbered: `0145-a-bank-line-is-explained-not-guessed.md` →
   `0147-…`; `docs/adr/README.md` highest-allocated updated to 0147.

Regression pass: `banking-reconciliation-seam`, `banking-write-seam`,
`banking-currency-integrity`, `reconciliation-business-level-gating`,
`reversal-writer-monopoly`, `journal-posting-monopoly` — all green.

## Known open items (not reconciliation)

- `src/test/architecture/accounting-posting-engine.test.ts` fails on a
  pre-existing violation unrelated to this wave:
  `src/features/warehouse/events/OutboxTimeline.tsx` reads
  `business_event_outbox` directly from non-admin UI. Left untouched
  deliberately; belongs to the warehouse events wave.

## Next milestone

Reconciliation Phase 8 is closed. The next roadmap item is **bank feed →
matching automation hardening**: the deterministic auto-post tier in
`apply_reconciliation_rules` currently proves only that it *skips* when a
document candidate exists. What is still unproven behaviourally is the tie
handling in `bank_match_candidates` (two equally-strong candidates must degrade
to `ambiguous` and never auto-post) and the feed-replay path (a re-imported
statement must not produce a second candidate set for an already-reconciled
line). Start there, with a behavioural block in the new SQL suite.

## Instructions for the next agent

1. Do not trust this file's verdicts either — re-derive them from
   `pg_get_functiondef` and the client hooks before extending anything.
2. Keep the two new refusal codes (`BANK_MATCH_FEE_ON_DIRECT_PAYMENT`,
   `BANK_UNRECONCILE_MISSING_SETTLEMENT`) covered by the SQL suite; they are the
   only guard against the two corruption paths found in this audit.
3. Keep this file current: the status table, the findings, and the next
   milestone, at the end of every turn.
