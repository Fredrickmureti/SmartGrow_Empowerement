# Reconciliation Engine — Controlled Intelligence & Automation Wave

Authoritative status. Update after every implementation.

## Current state

**Active phase: Phase 6 (AI — assistive only) — NOT STARTED. Phases 0–5 implemented and verified.**

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

## Phase 5 — History & explainability — DONE (implemented and verified 2026-08-21)

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

### Delivered (verified against the live database and a typecheck)

1. **Read boundary tightened (F5-3 closed).** The org-wide SELECT policy is gone. `bank_reconciliation_matches` now carries exactly two policies, both business- and branch-scoped:
   - `bank_recon_matches_select_perm_v1` — `business_id IS NOT NULL AND user_can_access_business(auth.uid(), business_id) AND (branch_id IS NULL OR user_can_access_branch(...) OR has_finance_permission(..., 'finance.view_consolidated', business_id))`
   - `bank_recon_matches_write_perm_v1` — as before, plus `finance.reconcile_bank`.
2. **One read authority (DB).** `bank_match_history(p_bank_transaction_id uuid)` and `bank_match_session_history(p_session_id uuid)`. VERIFIED in `pg_proc`: both SECURITY DEFINER, `search_path=public`, EXECUTE to `authenticated`/`service_role` only (no `anon`/PUBLIC), single-overload, and both call `_assert_can_read_bank_history`. Helpers `_assert_can_read_bank_history`, `_bank_history_actor`, `_bank_match_history_row` are SECURITY DEFINER with EXECUTE revoked from `authenticated` — they are reachable only through the two RPCs.
3. **Client seam.** `src/hooks/useBankMatchHistory.ts` — `useBankMatchHistory` / `useBankSessionMatchHistory`, RPC-only, query-only (no `useMutation`, no table select).
4. **UI (F5-4 closed).**
   - `src/components/banking/BankMatchDecisionCard.tsx` — one decision: what it was matched to, the evidence, the rule or the hand, the allocations, and whether it was later corrected.
   - `src/components/banking/BankMatchHistoryPanel.tsx` — per-line timeline.
   - `src/components/banking/BankSessionAuditTrail.tsx` — per-session trail.
   - Wired: `src/pages/BankReconciliation.tsx` opens a read-only "Why is this matched?" / "Decision history" side rail from both the reconciled and unreconciled row menus; `src/components/banking/ReconciliationHistoryTab.tsx` renders the session audit trail inside the expanded session (lazily, only while expanded). No action buttons on either surface.
5. **Ratchets.**
   - `src/test/architecture/banking-match-history-read-seam.test.ts` — 5/5 green. Forbids new browser modules selecting `bank_reconciliation_matches` (allow-list: `useBankPendingMatch`, `useClearableRecordedPayments`), forbids decision/mutation seams in the history hook and UI, and asserts the UI is wired.
   - `supabase/tests/bank_match_history_read_seam_test.sql` — asserts no org-wide read policy returns, the RPCs are hardened/read-only/scope-asserting, and the helpers are not client-callable.
6. **Also fixed this session:** the delete button in `src/features/finance/banking/rules/RulesListPage.tsx` had a duplicate `disabled` prop and no `onClick`; it is now wired to `deleteRule`.

Typecheck: clean.

### Known-unrelated red tests (pre-existing, NOT caused by this phase)
A full `src/test/architecture` run is broadly red across other domains (WMS, POS, payroll, localization). Banking-adjacent pre-existing failures to be triaged in their own wave, not here: `bank-export-template-metadata`, `bank-feeds-business-level-gating` (branch re-fetch assertion), `banking-business-level-gating` (branch filter assertion). None of them touch the match-history seam.

### Residual for Phase 5 closure
- Preview walk-through of a line that was proposed → confirmed → reversed has NOT been executed. UNVERIFIED end-to-end in the browser; the DB and seam facts above are verified.


## Pending

### Phase 6 — AI (assistive only)
- AI may rank server-produced candidates and draft explanations from the Phase 5 history. It must NEVER post and must never ship bulk tenant data — context is retrieved per decision through the scoped RPCs.
- Route through the AI gateway server-side; no duplicate data store.

### Phase 7 — Ratchets
- No client-side matching/auto-posting; single rule table; `match_source` vocabulary; AI cannot call the confirm seam; remove the retired-table entry from `src/lib/businessScopedTables.ts`.

## Instructions for the next agent

1. **Verify before you build.** Phases 0–5 are recorded as implemented above. Independently confirm Phase 5 before starting Phase 6:
   - `select polname, pg_get_expr(polqual, polrelid) from pg_policy p join pg_class c on c.oid=p.polrelid where c.relname='bank_reconciliation_matches'` — both policies must be business- AND branch-scoped; no `user_belongs_to_org` read.
   - `pg_proc` check on `bank_match_history` / `bank_match_session_history` (SECURITY DEFINER, pinned search_path, no anon EXECUTE) and on the three `_bank_*` helpers (no `authenticated` EXECUTE).
   - `bunx vitest run src/test/architecture/banking-match-history-read-seam.test.ts` must stay 5/5.
   - Close the residual: drive the preview through a line that was proposed, confirmed and reversed and confirm the side rail renders all three decisions with actor, rule and evidence.
2. **Then start Phase 6, not something else.** AI is assistive only: it may rank server-produced candidates and draft explanations from the Phase 5 history RPCs, retrieved per decision. It must never call `bank_match_confirm`/`propose`, never post, and never receive bulk tenant data. Route through the AI gateway server-side.
3. Phases 0–4 were independently verified on 2026-08-21 (evidence above). Do not re-litigate them.
2. Bring each phase to a coherent, production-ready state (UI + DB + ratchet) before moving on. No orphaned functionality.
