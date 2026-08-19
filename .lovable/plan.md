# Reconciliation Engine — Authoritative Project Status

Source of truth for this wave. Full design rationale and findings F1–F9 live in
`.lovable/plan/reconciliation-engine-execution-plan-2026-08-19.md`; this file
tracks what is done, what is not, and what happens next.

Last updated: 2026-08-19.

## Current phase

**Phase 8 — Validation & ratchets** is the active phase. Phases 1–7 and 9 are
implemented; behavioural (pgTAP) proof for the new seam paths is the open work.

## Roadmap status

| # | Phase | Status | Evidence |
|---|---|---|---|
| 1 | Validator extension (new kinds, branch + currency assertions, gross settlement + named residual) | Implemented | `_bank_match_validate` in DB |
| 2 | Fee model fix + `payment` / `bill_payment` clearing resolutions | Implemented | `bank_match_confirm` rewritten |
| 3 | Kind-aware reversal delegate | Implemented | `unreconcile_bank_transaction` delegates to `void_payment_atomic` / `void_bill_payment_atomic` / `void_journal_entry_atomic` |
| 4 | Candidate/evidence engine; broken suggestions RPC retired | Implemented | `bank_match_candidates(_txn_id, _limit)`; `get_reconciliation_match_suggestions` dropped; `anon` revoked |
| 5 | Transfer folded into the seam + single-confirmed-match unique index | Implemented | `reconcile_bank_transfer_atomic` wraps the seam; partial unique index on `bank_reconciliation_matches` |
| 6 | Rules subordinated to accounting truth | Implemented | `apply_reconciliation_rules` skips with `DOCUMENT_CANDIDATE_EXISTS`; auto-post limited to deterministic tier |
| 7 | Client workspace: one multi-allocation propose/confirm, evidence-led review | Implemented | `useBankMatchCandidates.ts`, `ReconcileTransactionSheet.tsx`, `BankReconciliation.tsx`; `useReconciliationSuggestions.ts` deleted |
| 8 | Validation & ratchets | **Partially done — active** | Vitest ratchet `src/test/architecture/banking-match-resolution.test.ts` green; pgTAP behavioural suite NOT written |
| 9 | ADR | Implemented | `docs/adr/0145-a-bank-line-is-explained-not-guessed.md` |

## Verified

- Build green; `src/test/architecture/banking-match-resolution.test.ts` green
  (no retired RPC calls, no per-document `onReconcile` loop, both clear-vs-mint
  resolutions reachable, fee treated as residual not a netting-off).
- Structural review of the migrated functions and of the client seam usage.

## Not yet verified

Everything below is implemented but has **no behavioural proof**:

- Undeposited-funds clearing produces exactly one payment row, AR credited once,
  clearing account nets to zero.
- Bank GL delta equals `|txn|` exactly once on a fee-bearing match, document
  settled gross.
- Kind-aware reverse restores `invoices.amount_paid` from live allocations.
- Aggregate 3→1, split 1→3, partial with named residual.
- Refusals: wrong business, wrong branch, wrong currency, locked period,
  double confirm, concurrent confirm, duplicate import, FX without a rate.
- Rule auto-post refusal when a document/payment candidate exists.

## Known debt to resolve inside Phase 8

- ADR number collision: `docs/adr/0145-a-bank-line-is-explained-not-guessed.md`
  and `docs/adr/0145-bank-account-is-a-server-owned-identity.md` share 0145.
  Renumber the newer one and fix references.

## Next milestone (do this next, nothing else)

**Phase 8 — complete the validation layer.**

1. Add `supabase/tests/bank_match_resolution_invariants_test.sql` (pgTAP)
   covering every scenario listed under "Not yet verified", following the shape
   of the existing `bank_matching_seam_invariants_test.sql`.
2. Extend `banking_privilege_ratchet_test.sql` so `bank_match_candidates` and
   the rewritten reversal delegate are asserted to have no `anon`/`public`
   EXECUTE and to be `SECURITY DEFINER` with `search_path=public`.
3. Extend the Vitest seam-monopoly ratchet to the new writers (transfer wrapper,
   reversal delegate) so no future code can write reconciled state off-seam.
4. Renumber the duplicate ADR 0145.
5. Regression pass: AR/AP payment, void, session complete, bank balance
   derivation, control-account reconciliation report.

Only after Phase 8 closes green does the wave move on to the next roadmap item
(bank feed → matching automation hardening).

## Instructions for the next agent

1. **Verify before you build.** Do not start new work until you have confirmed
   Phases 1–7 and 9 were implemented correctly and to enterprise standard. At
   minimum: read the current definitions of `_bank_match_validate`,
   `bank_match_confirm`, `bank_match_candidates`, `unreconcile_bank_transaction`,
   `reconcile_bank_transfer_atomic` and `apply_reconciliation_rules` from the
   live database; check each against the nine accounting invariants in the
   execution plan; confirm `anon` has no EXECUTE on any of them; confirm the
   client calls the seam exactly once per confirmation with N allocations.
2. **Record the verdict** in this file (a short "Verification verdict" section
   with pass/fail per phase) before changing code. If a phase fails, repair that
   phase to a coherent, production-ready state first — do not layer new work on
   a broken seam.
3. **Then resume at the next milestone above**, in order. Do not jump to
   unrelated domains, do not leave a phase half-done, and do not introduce
   functionality that has no complete workflow behind it.
4. **Keep this file current.** Update the status table, the verified /
   not-yet-verified sections and the next milestone at the end of every turn.
