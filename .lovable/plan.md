# Reconciliation Engine — Controlled Intelligence & Automation Wave

Authoritative status. Update after every implementation.

## Current state

**Active phase: Phase 5 (History & Explainability) — IN PROGRESS. Phases 0–4 verified.**

### Phase 0 — Discovery & verdict — DONE
Archived at `.lovable/plan/reconciliation-engine-phase-0-verdict-and-phased-plan-2026-08-21.md`.

### Phase 1 — Foundation — DONE (re-verified)
- `apply_reconciliation_rules` writes the valid `'rule'` token to `match_source`.
- Ratchet `supabase/tests/bank_match_source_vocabulary_test.sql` forbids DB functions concatenating tokens into `match_source`.

### Phase 2 — Candidate engine — DONE (re-verified)
- `bank_match_candidates` exists, references `business_id`/`branch_id` and reads `bank_reconciliation_rules`.
- Tiering (`settled` / `proposed` / `deterministic` / `ambiguous` / `none`) per ADR-0148.

### Phase 3 — Manual / bulk matching — DONE (re-verified)
- No client-side shadow matching engine remains in `src/hooks/useBankTransactions.ts`.
- The four seams `bank_match_propose` / `confirm` / `reject` / `reverse` all exist in the database.

### Phase 4 — Rules — DONE (independently verified this session)
Verification evidence:
- FACT: `transaction_categorization_rules` no longer exists in the database (0 rows in `information_schema.tables`); only `src/lib/businessScopedTables.ts` and historical migrations mention the name.
- FACT: `bank_reconciliation_rules.branch_id` exists.
- FACT: `apply_reconciliation_rules` contains the branch predicate and the `AMBIGUOUS_RULE_MATCH` refusal token; `bank_reconciliation_rule_upsert` and `bank_match_candidates` both reference `branch_id`.
- FACT: `bank_transaction_apply_rules` (feed ingestion) reads `bank_reconciliation_rules`, so one rule table serves import and match time.
- FACT: `src/hooks/useTransactionRules.ts` is deleted; `src/test/architecture/banking-rule-authoring-seam.test.ts` passes 5/5.

Residual nit (not a defect): `src/lib/businessScopedTables.ts` still lists the retired table name. Clean up during Phase 7 ratchets.

## Phase 5 — History & explainability (CURRENT)

Findings established this session:

- **VALID EXISTING ARCHITECTURE (F5-1).** `bank_reconciliation_matches` already carries the full decision record: `proposed_by`, `created_by`, `confirmed_by/at`, `rejected_by/at`, `reversed_by/at`, `rule_id`, `match_source` counterpart on the line, `confidence`, `allocations`, `fee_amount`/`fee_account_id`, `exchange_rate`, the fee/adjustment journal ids and an `evidence` jsonb. No new history table is needed.
- **CONFIRMED (F5-2).** `bank_match_reverse` does not delete the match row (no `DELETE FROM ... bank_reconciliation_matches` in its body), so reversal lineage is retained and a history view can render a reversed match as a corrected decision.
- **CONFIRMED DEFECT (F5-3).** The only SELECT policy on `bank_reconciliation_matches` is `user_belongs_to_org(organization_id)`. Its write policy is business- and branch-scoped, but reads are not. Any history UI reading the table directly from the browser would expose another business's (and another branch's) reconciliation decisions inside the same organization. Impact: tenant-isolation breach of the kind Part 10 forbids.
- **MISSING (F5-4).** No application code reads match history: only `useBankPendingMatch` (single pending match) and `useClearableRecordedPayments` (reservation check) touch the table. There is no per-line or per-session audit view.

### Execution steps

1. **Tighten the read boundary (DB).** Replace the org-wide SELECT policy with the same business + branch predicate the write policy uses (`user_can_access_business` AND branch access OR `finance.view_consolidated`). Validation: a query as a user scoped to business A returns zero rows for business B's matches.
2. **Add one read authority (DB).** `bank_match_history(p_bank_transaction_id uuid)` and `bank_match_session_history(p_session_id uuid)`, SECURITY DEFINER, pinned `search_path`, no `anon` EXECUTE, scope asserted internally. They return the decision timeline per match — proposed → confirmed/rejected → reversed — with the rule name, actor display name, allocations, residual/fee/FX, and the journal entry ids, ordered chronologically. Read-only: no writes, no posting.
3. **Client seam.** `src/hooks/useBankMatchHistory.ts` calling those RPCs only (never the table). Never a second candidate or posting path.
4. **UI.** A read-only history panel on the bank line detail in `src/pages/BankReconciliation.tsx` and a session-level audit list on the reconciliation session view. Each entry states what was matched, on what evidence, by whom, when, by which rule (or `manual`), and — when reversed — that it was corrected, linking the reversal to the original decision. No action buttons; explaining is not deciding.
5. **Ratchet.** Extend `src/test/architecture/banking-match-resolution.test.ts` (or a new `banking-match-history-read-seam.test.ts`): no browser module SELECTs `bank_reconciliation_matches` outside the two allowed hooks; the history RPCs contain no INSERT/UPDATE/DELETE; the SELECT policy is business-scoped (SQL test alongside `bank_matching_seam_invariants_test.sql`).

Validation before marking Phase 5 done: typecheck, the new + existing banking ratchets green, and the history panel exercised in the preview against a line that was proposed, confirmed and reversed.

## Pending

### Phase 6 — AI (assistive only)
- AI may rank server-produced candidates and draft explanations from the Phase 5 history. It must NEVER post and must never ship bulk tenant data — context is retrieved per decision through the scoped RPCs.
- Route through the AI gateway server-side; no duplicate data store.

### Phase 7 — Ratchets
- No client-side matching/auto-posting; single rule table; `match_source` vocabulary; AI cannot call the confirm seam; remove the retired-table entry from `src/lib/businessScopedTables.ts`.

## Instructions for the next agent

1. Phases 0–4 were independently verified on 2026-08-21 (evidence above). Do not re-litigate them; do not start Phase 6 before Phase 5 is complete and verified.
2. Bring each phase to a coherent, production-ready state (UI + DB + ratchet) before moving on. No orphaned functionality.
