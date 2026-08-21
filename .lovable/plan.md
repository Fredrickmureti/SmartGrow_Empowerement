# Reconciliation Engine — Controlled Intelligence & Automation Wave

Authoritative status. Update after every implementation.

## Current state

**Active phase: Phase 4 (Rules) — COMPLETE. Next: Phase 5 (History & Explainability).**

### Phase 0 — Discovery & verdict — DONE
Archived at `.lovable/plan/reconciliation-engine-phase-0-verdict-and-phased-plan-2026-08-21.md`.

### Phase 1 — Foundation — DONE (verified)
- `apply_reconciliation_rules` writes the valid `'rule'` token to `match_source` (was `'rule:<name>'`, which violated the CHECK constraint and aborted every run).
- Ratchet `supabase/tests/bank_match_source_vocabulary_test.sql` forbids DB functions concatenating tokens into `match_source`.

### Phase 2 — Candidate engine — DONE (verified)
- `bank_match_candidates` filters invoices, bills and payments by `business_id` + `branch_id`.
- Tiering (`settled` / `proposed` / `deterministic` / `ambiguous` / `none`) confirmed; a tie is never `deterministic`.

### Phase 3 — Manual / bulk matching — DONE (verified)
- Client-side shadow matching engine and the `ai-assistant` bulk-matching call removed from `src/hooks/useBankTransactions.ts`.
- `autoMatchTransactions` now calls `bank_match_candidates` and only auto-posts the `deterministic` tier through `bank_match_propose` + `bank_match_confirm`.
- `src/pages/BankReconciliation.tsx` reports applied vs. needs-review from the server result.

### Phase 4 — Rules — DONE
- DB: `bank_reconciliation_rules.branch_id` added (AR-6); `apply_reconciliation_rules`, `bank_match_candidates` and `bank_reconciliation_rule_upsert` honour branch isolation (NULL = all branches; a branch rule never explains another branch's line).
- Executor returns `{processed, matched, posted, skipped[]}` with a refusal vocabulary (`DOCUMENT_CANDIDATE_EXISTS`, `LINE_ALREADY_EXPLAINED`, `AMBIGUOUS_RULE_MATCH`, `AMBIGUOUS_NOT_AUTO_POSTED`, `RULE_HAS_NO_COUNTERPART_ACCOUNT`).
- One rule table: `transaction_categorization_rules` and its two upsert/delete RPCs dropped. Feed ingestion's `bank_transaction_apply_rules` now derives its categorization hint from `bank_reconciliation_rules`, so a rule means the same thing at import and at match time.
- UI consolidated onto `useReconciliationRules`: rules list, create and edit pages, `RuleFormBody` (posts-to account, branch scope, auto-post vs. propose; the decorative `auto_action` / `stop_processing` controls are gone). `useTransactionRules.ts` deleted. Bank Feeds "create rule from line" now opens the prefilled rule form instead of writing a rule with no account.
- `FinanceAccountingControls` shows the grouped skip reasons after an apply run.
- Ratchet `src/test/architecture/banking-rule-authoring-seam.test.ts` updated and passing (5/5): browser may not write rule tables, and no app code may touch the retired table.

## Pending

### Phase 5 — History & explainability (NEXT)
- No new history table: `bank_reconciliation_matches` already records who/when/why plus the evidence payload.
- Build a read-only match history / audit view per bank line and per session, sourced from `bank_reconciliation_matches` (+ `rule_id`, `match_source`, confirm/reverse events).
- Surface reversal lineage so a reversed match reads as a corrected decision, not a deletion.

### Phase 6 — AI (assistive only)
- AI may rank existing server-produced candidates and draft explanations. It must NEVER post, and must not ship bulk tenant data.
- Route through the AI gateway from an edge function; no duplicate data store.

### Phase 7 — Ratchets
- Ratchet: no client-side matching/auto-posting; single rule table; `match_source` vocabulary; AI cannot call the confirm seam.

## Instructions for the next agent

1. **Verify before continuing.** Confirm Phase 4 is enterprise-grade: run `npx vitest run src/test/architecture/banking-rule-authoring-seam.test.ts`, typecheck, and exercise the rules pages (`/finance/banking/rules`, `/new`, `/:id/edit`) in the preview. Re-read `apply_reconciliation_rules` and `bank_transaction_apply_rules` in the DB and confirm branch isolation and the skip vocabulary behave as documented above.
2. **Then resume at Phase 5** (history & explainability) — do not jump to Phase 6 or unrelated areas.
3. Bring each phase to a coherent, production-ready state (UI + DB + ratchet) before moving on. No orphaned functionality.
