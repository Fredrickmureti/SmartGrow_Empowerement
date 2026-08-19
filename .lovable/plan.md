# Reconciliation Engine — Authoritative Project Status

Source of truth for this wave. Design rationale and findings F1–F19 live in
`.lovable/plan/reconciliation-engine-execution-plan-2026-08-19.md` and
`.lovable/plan/reconciliation-engine-authoritative-project-status-2026-08-19.md`;
this file tracks what is done, what is not, and what happens next.

Last updated: 2026-08-19 (turn 5 — Phase 10 behavioural proof + Phase 11 built end to end).

## Current phase

**Phase 11 — reconciliation session closure: implemented, including the
operator surface (11.5). Phase 10 is now behaviourally proven.** Phases 1–9
were closed earlier.

Next up: **Phase 12 — run the two pgTAP suites in the migration/test harness and
close the ratchet gap** (see "Next milestone").

## Roadmap status

| # | Phase | Status | Evidence |
|---|-------|--------|----------|
| 1 | Validator extension | Closed | `_bank_match_validate` |
| 2 | Fee model + payment / bill_payment clearing | Closed | `bank_match_confirm` |
| 3 | Kind-aware reversal delegate | Closed | `unreconcile_bank_transaction` |
| 4 | Candidate/evidence engine | Closed | `bank_match_candidates` |
| 5 | Transfer folded into the seam | Closed | `reconcile_bank_transfer_atomic` |
| 6 | Rules subordinated to accounting truth | Closed | `apply_reconciliation_rules` |
| 7 | Client workspace: one propose/confirm, evidence-led | Closed | `useBankMatchCandidates.ts`, `ReconcileTransactionSheet.tsx` |
| 8 | Validation & ratchets | Closed | `bank_match_resolution_invariants_test.sql`, `banking_privilege_ratchet_test.sql` |
| 9 | ADR | Closed | `docs/adr/0147`, `docs/adr/0148` |
| 10 | Feed → matching automation hardening | **Closed — contract + behaviour** | `bank_match_automation_invariants_test.sql` §6–§8 |
| 11 | Session closure: a completed session is falsifiable and immutable | **Closed — F17, F18, F19 resolved** | migration `20260819133444_…`, `bank_reconciliation_closure_invariants_test.sql`, client surfaces below |
| 12 | Harness execution + ratchet closure | Open | see below |

## Delivered this turn

### Phase 10.1–10.5 — behavioural proof (was the one honest gap of turn 4)
Appended to `supabase/tests/bank_match_automation_invariants_test.sql` as
self-rolled-back `DO` blocks over real rows:
- §6 — an explained line is not a question: a proposed line answers tier
  `proposed` with `existing_match_id` and zero candidates; after confirm the
  tier is `settled`; the document reserved by that proposal is never offered on
  a second line (10.1 + 10.2).
- §7 — a rules sweep run twice yields one proposal (idempotence), and two
  equally-ranked rules matching one line raise `AMBIGUOUS_RULE_MATCH` and post
  nothing (10.4 + 10.5). The block inserts its own rules because
  `bank_reconciliation_rules` is empty on this branch.
- §8 — a deposit explainable by two distinct receipt combinations surfaces both,
  tier `ambiguous` (10.3).

### Phase 11.1 — F17, the closed window (server)
- `_bank_recon_closed_session(bank_account_id, date)` — the single place that
  asks whether a date falls inside a completed session.
- `_bank_match_closed_window_guard()` and
  `_bank_txn_reconcile_closed_window_guard()` triggers refuse match births,
  confirms, reversals and `is_reconciled` flips inside a closed window, with
  named hints `BANK_MATCH_SESSION_CLOSED` / `BANK_UNRECONCILE_SESSION_CLOSED`.
  Chosen as triggers, not per-RPC asserts, so every writer is caught.
- `_bank_reconciliation_session_freeze()` protects a completed session's
  statement figures.
- EXECUTE on the guard helpers revoked from `PUBLIC`, `anon`, `authenticated`.

### Phase 11.2 — F18, the ledger tie-out (server)
- `_bank_reconciliation_gl_tieout(session_id)` — pure SQL, `STABLE`: cleared
  statement movement vs. the bank GL account's posted movement over the window,
  plus a `cleared_without_posting` count.
- `_bank_reconciliation_recompute` returns it as a nested `gl_tieout` object.
- `bank_reconciliation_session_complete` refuses on divergence > 0.01
  (`BANK_RECON_GL_DIVERGENCE`). A session with no GL account mapped reports
  `checked: false` rather than a false pass.

### Phase 11.3 — audited reopen (server)
`bank_reconciliation_session_reopen(_session_id, _reason)`: reason required,
period-guarded, refused when a later completed session exists, emits a business
event. Closure is undone by a documented act, never a delete.

### Phase 11.4 — F19, the stale `difference` column
Persisted by its single writer: `_bank_reconciliation_recompute` writes it, and
completion records the final figure, so the stored column and the RPC can no
longer give two answers.

### Phase 11.5 — client surface (this turn)
- `src/hooks/useReconciliationItems.ts` — `ReconciliationGlTieout` type;
  `ReconciliationCalc.gl_tieout`.
- `src/components/banking/ReconciliationWorkspace.tsx` — a tie-out row (cleared
  movement, bank ledger movement, divergence), a plain-English explanation
  naming unposted cleared lines, and **Finish Now disabled while diverged** so
  the client never invites a refusal it can predict.
- `src/components/banking/CompletedReconciliations.tsx` (new) — history of
  closed reconciliations with the frozen difference and a **Reopen** dialog that
  demands a reason; permission-gated on `canReconcile`.
- `src/pages/BankReconciliation.tsx` — renders that panel, wired to
  `reopenSession`.
- Hooks already map `BANK_RECON_GL_DIVERGENCE`, `BANK_MATCH_SESSION_CLOSED` and
  the unreconcile refusal to operator copy.

## Validation performed

- `bunx tsgo --noEmit -p tsconfig.app.json` — clean.
- Banking Vitest ratchets green: `banking-reconciliation-seam` (9 tests, two new),
  `banking-write-seam`, `banking-match-resolution`,
  `reconciliation-business-level-gating` — 43 + 2 passing.
- New ratchets assert the workspace shows `gl_tieout` and gates completion on
  `glDiverged`, and that reopening goes through
  `bank_reconciliation_session_reopen` with a mandatory reason and no client
  write to `bank_reconciliation_sessions`.
- `_bank_reconciliation_gl_tieout` exercised against live rows via read queries.

## Not yet done (carry forward)

1. **The two pgTAP suites have not been executed by the harness.**
   `bank_match_automation_invariants_test.sql` §6–§8 and
   `bank_reconciliation_closure_invariants_test.sql` are written but only
   partially exercised: the client API role hits `is_period_open` permission
   errors, so they must run as superuser under `supabase test`. Until they run
   green they are unproven text.
2. Reopen has no behavioural pgTAP proof of the "later completed session"
   refusal path.
3. Pre-existing, unrelated: `src/test/architecture/accounting-posting-engine.test.ts`
   fails because `src/features/warehouse/events/OutboxTimeline.tsx` reads
   `business_event_outbox` from non-admin UI. Warehouse events wave, not this one.

## Next milestone — Phase 12

1. Execute both pgTAP suites in the superuser harness; fix what they falsify.
   Treat a failure as a defect in the engine, not in the test, until proven
   otherwise.
2. Add the reopen ordering/period-lock behavioural blocks.
3. Then, and only then, write the ADR for session closure (immutability +
   GL tie-out as invariants 7 and 8) and close the wave.

## Accounting invariants

1. Journal rows only through `post_journal_entry_atomic` (ADR-0123).
2. Settlement only through `record_multi_invoice_payment` /
   `record_multi_bill_payment`.
3. One bank line is one match; several documents are several allocations.
4. Documents settle gross; the residual is a named charge or explicit write-off.
5. A missing FX rate is an absence, never 1.0.
6. Ambiguity is never automated (ADR-0148).
7. A completed reconciliation is immutable until explicitly reopened (F17).
8. A completed session's cleared movement must agree with the bank GL movement (F18).

## Instructions for the next agent

1. **Verify before you build.** Re-derive this turn's claims from the live
   database (`pg_get_functiondef` for the guards, triggers on
   `bank_transaction_matches` / `bank_transactions` /
   `bank_reconciliation_sessions`, ACLs on the new helpers) and from the client
   files named above. Record the verdict in this file before writing code.
2. Then resume at **Phase 12, step 1** — run the pgTAP suites. Do not start
   unrelated work while an unexecuted test suite is the wave's weakest link.
3. No server behaviour without its client surface in the same turn.
4. Keep this file current: status table, delivered list, carry-forward, next
   milestone.
