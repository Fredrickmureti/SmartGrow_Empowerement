# Reconciliation Engine — Authoritative Project Status

Source of truth for this wave. Full design rationale and findings F1–F9 live in
`.lovable/plan/reconciliation-engine-execution-plan-2026-08-19.md`; this file
tracks what is done, what is not, and what happens next.

Last updated: 2026-08-19 (turn 4 — handover verification + Phase 11 scoped).

## Current phase

**Phase 10 — feed → matching automation hardening: contract-proven (re-verified
this turn). Behavioural proof still pending.**
**Phase 11 — reconciliation session closure: NOT started. Three real defects
found this turn (F17–F19).** Phases 1–9 are closed.

## Roadmap status

| # | Phase | Status | Evidence |
|---|-------|--------|----------|
| 1 | Validator extension (new kinds, branch + currency assertions, gross settlement + named residual) | Closed | `_bank_match_validate` |
| 2 | Fee model fix + `payment` / `bill_payment` clearing resolutions | Closed | `bank_match_confirm` |
| 3 | Kind-aware reversal delegate | Closed | `unreconcile_bank_transaction` |
| 4 | Candidate/evidence engine; broken suggestions RPC retired | Closed | `bank_match_candidates` |
| 5 | Transfer folded into the seam + single-confirmed-match unique index | Closed | `reconcile_bank_transfer_atomic` |
| 6 | Rules subordinated to accounting truth | Closed | `apply_reconciliation_rules` |
| 7 | Client workspace: one multi-allocation propose/confirm, evidence-led review | Closed | `useBankMatchCandidates.ts`, `ReconcileTransactionSheet.tsx` |
| 8 | Validation & ratchets | Closed | `bank_match_resolution_invariants_test.sql`, `banking_privilege_ratchet_test.sql` |
| 9 | ADR | Closed | `docs/adr/0147`, `docs/adr/0148` |
| 10 | Feed → matching automation hardening | Contract-proven; behaviour pending | `bank_match_automation_invariants_test.sql` |
| 11 | **Session closure: a completed session must be falsifiable and immutable** | **Open — F17, F18, F19** | this turn |

## Turn 4 — independent verification verdict (handover)

Re-derived from the live database (`pg_proc`, `pg_get_functiondef`, ACLs) and
current client code. No claim taken on trust.

| Claim (turn 3) | Verdict |
|---|---|
| `bank_match_candidates` short-circuits on the line's own match, emits `settled` / `proposed` + `existing_match_id` | PASS |
| Reservation covers proposed **and** confirmed, asked in one place, all 5 candidate classes | PASS — 5 `_bank_doc_is_spoken_for` call sites in the body |
| `_bank_doc_is_spoken_for` is SECURITY DEFINER, `search_path=public`, EXECUTE to `service_role` only (no `anon`, no `authenticated`) | PASS |
| `bank_match_*`, `apply_reconciliation_rules`, `unreconcile_bank_transaction`, `reconcile_bank_transfer_atomic` single-overload, SECURITY DEFINER, pinned search_path, `authenticated`-only | PASS |
| Rules runner carries `AMBIGUOUS_RULE_MATCH`, `LINE_ALREADY_EXPLAINED`, `AMBIGUOUS_NOT_AUTO_POSTED` | PASS |
| Client surfaces both new tiers with operator copy and `isExplainedTier()` | PASS (`src/hooks/useBankMatchCandidates.ts:17-132`) |
| `supabase/tests/bank_match_automation_invariants_test.sql` asserts the above | PASS — but it is a **contract** test only (reads `pg_get_functiondef`); it exercises no rows |

Conclusion: turn 3's work is genuinely implemented, not superficial. The one
honest gap it declared (behavioural proof) is still a gap.

## Critical findings opened this turn

### F17 — a completed session's basis can still be changed
- **Evidence:** none of `bank_match_propose`, `bank_match_confirm`,
  `bank_match_reverse`, `unreconcile_bank_transaction` reference
  `bank_reconciliation_sessions` at all (checked `prosrc` for each). Only
  `bank_reconciliation_session_complete` / `_cancel` / `_writeoff` /
  `_item_set` / `_recompute` do.
- **Impact:** after a session is completed, a match on a line dated inside that
  session's window can still be confirmed or reversed. The session's stored
  `reconciled_balance` and its "balanced" verdict then describe a state that no
  longer exists, and `unreconcile_bank_transaction` can clear `is_reconciled`
  on a line a completed session marked reconciled. A closed reconciliation is
  supposed to be a fact.
- **Required change:** the four seams must assert that the line's
  `transaction_date` does not fall on or before the `statement_date` of any
  `completed` session for that bank account, refusing with a named hint
  (`BANK_MATCH_SESSION_CLOSED` / `BANK_UNRECONCILE_SESSION_CLOSED`). Reopening
  is an explicit, audited act (see Required changes 11.3), never a side effect.
- **Dependencies:** none.
- **Validation:** pgTAP behavioural — confirm and reverse both refused inside a
  completed window; allowed after an explicit reopen.

### F18 — the session is reconciled against itself, not against the ledger
- **Evidence:** `_bank_reconciliation_recompute` derives
  `reconciled_balance` solely from `_bank_account_movement`, which sums
  `bank_transactions.amount` — statement observations. No path compares it to
  `journal_entry_lines` on `bank_accounts.account_id`.
- **Impact:** a completed session proves statement ≡ statement. It cannot
  detect a cleared line whose settlement posted to the wrong GL account, or a
  bank GL movement with no statement line behind it. This is precisely the
  falsifiability ADR-0141 demands of a balance.
- **Required change:** extend the session report with the GL leg — cleared
  statement movement vs. the bank GL account's posted movement over the same
  window (reusing `bank_account_positions`, not a new balance calculator) — and
  refuse completion when the two disagree beyond tolerance
  (`BANK_RECON_GL_DIVERGENCE`).
- **Dependencies:** F17 (an immutable window is what makes the tie-out mean
  anything).
- **Validation:** pgTAP — a session whose cleared lines are fully settled
  completes; the same session with one settlement posted to another account is
  refused.

### F19 — `bank_reconciliation_sessions.difference` is never written
- **Evidence:** no function in the schema updates that column
  (`prosrc ~* 'bank_reconciliation_sessions.*set.*difference'` → none);
  `_bank_reconciliation_recompute` writes only `reconciled_balance` and returns
  `difference` in its jsonb payload.
- **Impact:** any reader of the stored column (reports, history list, exports)
  shows a stale or null difference while the RPC shows the true one — two
  answers to one question.
- **Required change:** either persist it in `_bank_reconciliation_recompute`
  (single writer) or drop the column and force readers through the RPC.
  Decide by auditing readers first; prefer dropping a derived column
  (ADR-0141: a balance is derived, never stored) unless a completed session
  needs a frozen historical figure — in which case persist it **only** at
  completion and freeze it in `_bank_reconciliation_session_freeze`.
- **Dependencies:** none.
- **Validation:** architecture ratchet — no client read of a stale column;
  pgTAP — the persisted/derived value agrees with the RPC.

## Accounting invariants (unchanged, restated)

1. Journal rows only through `post_journal_entry_atomic` (ADR-0123).
2. Settlement only through `record_multi_invoice_payment` /
   `record_multi_bill_payment`; the matching seam never mints a payment.
3. One bank line is one match; several documents are several allocations.
4. Documents settle gross; the residual is a named bank charge or an explicit
   write-off, never an adjustment of the document.
5. A missing FX rate is an absence (`require_exchange_rate`), never 1.0.
6. Ambiguity is never automated (ADR-0148).
7. A completed reconciliation is immutable until explicitly reopened (new, F17).
8. A completed session's cleared movement must agree with the bank GL movement
   (new, F18).

## Required changes (ordered)

**10.x — close Phase 10 behaviourally** (in
`supabase/tests/bank_match_automation_invariants_test.sql`, self-rolled-back
shape of `bank_match_resolution_invariants_test.sql` §6):
1. Reconciled line → tier `settled`, zero candidates; proposed line → `proposed`.
2. The same invoice cannot be proposed on two bank lines.
3. Two receipt combinations for one deposit → two candidates, tier `ambiguous`.
4. A rules sweep run twice produces one proposal.
5. Two equally-ranked rules → `AMBIGUOUS_RULE_MATCH`, nothing posted.

**11.x — session closure:**
1. F17 guard in all four seams + `unreconcile_bank_transaction`, with named
   hints and an `assert`-style helper so the question is asked in one place.
2. F18 GL tie-out in `_bank_reconciliation_recompute`'s payload and a
   completion refusal on divergence; surfaced in the session report UI.
3. `bank_reconciliation_session_reopen(_session_id, _reason)` — audited,
   period-guarded, refuses when a later completed session exists; emits a
   business event. Reversal of a closure is a documented act, not a delete.
4. F19 resolution per the reader audit.
5. Client: the reopen action, the GL-divergence explanation, and the
   "closed window" refusal must all reach the operator in the same turn.

## Validation

- `supabase/tests/bank_match_automation_invariants_test.sql` (contract + new
  behavioural blocks).
- New `supabase/tests/bank_reconciliation_closure_invariants_test.sql`.
- `src/test/architecture/banking-reconciliation-seam.test.ts` extended: no
  client write to session status, no client read of a stale difference column.
- `bunx tsgo --noEmit -p tsconfig.app.json` clean; banking Vitest ratchets green.

## Execution status

- [x] Phases 1–9
- [x] Phase 10 implementation + contract proof (re-verified turn 4)
- [ ] Phase 10 behavioural proof (10.1–10.5)
- [ ] Phase 11.1 — closed-window guard (F17)
- [ ] Phase 11.2 — GL tie-out at completion (F18)
- [ ] Phase 11.3 — audited reopen
- [ ] Phase 11.4 — stale `difference` column (F19)
- [ ] Phase 11.5 — client surface

## Known open items (not reconciliation)

- `src/test/architecture/accounting-posting-engine.test.ts` fails on a
  pre-existing violation unrelated to this wave:
  `src/features/warehouse/events/OutboxTimeline.tsx` reads
  `business_event_outbox` directly from non-admin UI. Belongs to the warehouse
  events wave.

## Instructions for the next agent

1. Verify before you build; record the verdict in this file before changing code.
2. No server behaviour without its client surface in the same turn.
3. Keep this file current: status table, findings, execution status, next steps.
