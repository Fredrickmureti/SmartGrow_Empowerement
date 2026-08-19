# Reconciliation Engine — Authoritative Project Status

Source of truth for this wave. Full design rationale and findings F1–F9 live in
`.lovable/plan/reconciliation-engine-execution-plan-2026-08-19.md`; this file
tracks what is done, what is not, and what happens next.

Last updated: 2026-08-19 (turn 3 — Phase 10 executed).

## Current phase

**Phase 10 — feed → matching automation hardening: implemented, contract-proven,
behavioural proof pending.** Phases 1–9 are closed.

## Roadmap status

| # | Phase | Status | Evidence |
|---|-------|--------|----------|
| 1 | Validator extension (new kinds, branch + currency assertions, gross settlement + named residual) | Closed | `_bank_match_validate`; re-verified live turn 2 |
| 2 | Fee model fix + `payment` / `bill_payment` clearing resolutions | Closed | `bank_match_confirm`; F10 fixed turn 2 |
| 3 | Kind-aware reversal delegate | Closed | `unreconcile_bank_transaction`; F11 fixed turn 2 |
| 4 | Candidate/evidence engine; broken suggestions RPC retired | Closed | `bank_match_candidates`; `get_reconciliation_match_suggestions` absent from the DB |
| 5 | Transfer folded into the seam + single-confirmed-match unique index | Closed | `reconcile_bank_transfer_atomic`; partial unique index |
| 6 | Rules subordinated to accounting truth | Closed | `apply_reconciliation_rules` |
| 7 | Client workspace: one multi-allocation propose/confirm, evidence-led review | Closed | `useBankMatchCandidates.ts`, `ReconcileTransactionSheet.tsx`, `BankReconciliation.tsx` |
| 8 | Validation & ratchets | Closed turn 2 | `bank_match_resolution_invariants_test.sql`, hardened `banking_privilege_ratchet_test.sql`, 10 green Vitest ratchets |
| 9 | ADR | Closed | `docs/adr/0147-a-bank-line-is-explained-not-guessed.md` |
| 10 | Feed → matching automation hardening | **Implemented — contract-proven, behaviour pending** | this turn; see below |

## Turn 2 summary (verification + Phase 8)

Every phase-1–9 claim was re-derived from the live database (`pg_get_functiondef`,
ACLs, indexes) and the current client code. All passed. Two real corruption
paths were found and fixed:

- **F10** — a bank charge could ride on a receipt already banked to this
  account, leaving the bank leg short by the fee. Now refused with
  `BANK_MATCH_FEE_ON_DIRECT_PAYMENT`.
- **F11** — reversing an invoice/bill match whose settlement row was missing
  voided the journal but left `amount_paid` standing. Now refused with
  `BANK_UNRECONCILE_MISSING_SETTLEMENT`.

## Turn 3 — Phase 10, implemented this turn

Investigation focus: what happens the *second* time a line is explained, which
is what a feed and a re-import do. Ingest was found sound (fingerprint +
`ON CONFLICT (bank_account_id, external_transaction_id) DO NOTHING`, zero-amount
and cross-currency rejection, locked-period rejection). The explanation layer
was not. Five defects found and fixed:

- **F12** — `bank_match_candidates` never inspected the line's own match, so an
  already-reconciled deposit still returned a "certain" suggestion to settle the
  invoice again. Now short-circuits to tier `settled`, zero candidates,
  `existing_match_id` and a plain-English reason.
- **F13** — a line already carrying a *proposed* match got a fresh candidate
  set, so one line could accumulate competing proposals. Now tier `proposed`.
- **F14** — only *confirmed* matches removed a document from the pool, so two
  bank lines could each hold an open proposal against the same invoice, receipt,
  bill or mirror transfer line. Reservation now starts at the proposal, asked in
  one place: `_bank_doc_is_spoken_for(kind, id)` (internal — no `anon`, no
  `authenticated` EXECUTE), applied to all five candidate classes.
- **F15** — the multi-receipt deposit query aggregated every valid combination
  into one row and then required exactly two members, so *two* possibilities
  produced no candidate at all. Each combination is now its own candidate, so N
  possibilities tie and the line reads `ambiguous`.
- **F16** — the rules runner re-proposed lines that already had a match and
  resolved a tie between two equally-ranked rules by creation order. It now
  skips matched lines, refuses with `AMBIGUOUS_RULE_MATCH`, skips
  `LINE_ALREADY_EXPLAINED`, and never auto-posts an ambiguous line
  (`AMBIGUOUS_NOT_AUTO_POSTED`).

Client surface completed in the same turn (no orphaned server behaviour): the
two new tiers are typed, given operator copy ("Awaiting review", "Reconciled"),
the badge variant handles them, and the sheet shows the server's reason instead
of an empty suggestion panel. `isExplainedTier()` names the distinction.

Recorded as **ADR-0148 — an automation may only post what is unambiguous**;
`docs/adr/README.md` highest-allocated bumped to 0148.

### Verified this turn

- Both migrations applied clean; `bank_match_candidates` and
  `apply_reconciliation_rules` remain single-overload, SECURITY DEFINER,
  `search_path=public`, `authenticated`-only; `_bank_doc_is_spoken_for` is
  `service_role`-only (the project's default grant to `anon` was explicitly
  revoked — a bare `REVOKE … FROM PUBLIC` was not enough).
- `supabase/tests/bank_match_automation_invariants_test.sql` (new) asserts every
  point above as a contract, plus ingest idempotence and the unique index behind
  it.
- `bunx tsgo --noEmit -p tsconfig.app.json` clean.

### Not yet verified (Phase 10's open work)

Behavioural (pgTAP, live rows) proof for:

- A reconciled line returns `settled` with zero candidates; a proposed line
  returns `proposed`.
- The same invoice cannot be proposed on two bank lines.
- Two receipt combinations for one deposit yield two candidates and tier
  `ambiguous`.
- A rules sweep run twice produces one proposal, not two.
- Two equally-ranked rules matching one line produce `AMBIGUOUS_RULE_MATCH` and
  no posting.

The behavioural blocks belong in
`supabase/tests/bank_match_automation_invariants_test.sql`, following the
self-rolled-back shape used in `bank_match_resolution_invariants_test.sql`
section 6. Note that `read_query` cannot exercise these (the seams assert
membership via `assert_can_reconcile_bank`, and the internal helpers are
`service_role`-only), so they must run through `supabase test db`.

## Known open items (not reconciliation)

- `src/test/architecture/accounting-posting-engine.test.ts` fails on a
  pre-existing violation unrelated to this wave:
  `src/features/warehouse/events/OutboxTimeline.tsx` reads
  `business_event_outbox` directly from non-admin UI. Left untouched
  deliberately; belongs to the warehouse events wave.

## Next milestone (do this next, nothing else)

1. **Close Phase 10 behaviourally** — the five scenarios listed above.
2. Then, and only then, move to the next roadmap item: **reconciliation session
   closure**. The session (`bank_reconciliation_sessions`) currently freezes and
   reports, but it has no proven relationship to the matches inside its window —
   i.e. it is not yet demonstrable that a completed session's computed
   difference equals the bank GL movement for the period, nor that a match
   cannot be created or reversed inside a completed session's window without
   reopening it. Verify those two invariants first, then implement what is
   missing.

## Instructions for the next agent

1. **Verify before you build.** Do not extend Phase 10 or start session closure
   until you have re-derived this turn's claims yourself: read
   `bank_match_candidates`, `_bank_doc_is_spoken_for` and
   `apply_reconciliation_rules` from the live database with
   `pg_get_functiondef`, confirm the short-circuit precedes every candidate
   class, confirm the reservation covers `proposed` as well as `confirmed`, and
   confirm `_bank_doc_is_spoken_for` grants EXECUTE to `service_role` only.
2. **Record the verdict here** (pass/fail per item) before changing code. If
   something fails, repair it to a coherent production state before layering new
   work on top.
3. **Keep the whole workflow intact.** Any new server tier, refusal code or
   candidate kind must reach the operator in `useBankMatchCandidates.ts` and the
   reconciliation sheet in the same turn — no server behaviour without its UI
   surface.
4. **Keep this file current**: status table, findings, open items and next
   milestone, at the end of every turn.
