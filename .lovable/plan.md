# Reconciliation Engine — Controlled Intelligence & Automation Wave

## Status snapshot

- **Active phase:** Phase 6 — Assistive AI (implemented this turn, awaiting independent verification)
- **Next milestone:** Phase 7 — Hardening & rollout (see below)

## Fully implemented and verified

- **Phase 0-3 — Discovery, consolidation, rule authoring.** `transaction_categorization_rules`
  dropped; `bank_reconciliation_rules` is the single rule table and carries `branch_id`.
  `apply_reconciliation_rules`, `bank_transaction_apply_rules`,
  `bank_reconciliation_rule_upsert` and `bank_match_candidates` are branch-scoped;
  ambiguity surfaces as `AMBIGUOUS_RULE_MATCH` instead of a silent pick.
- **Phase 4 — Rule authoring seam.** Retired `useTransactionRules` gone; authoring flows only
  through `useReconciliationRules`. Ratchet: `src/test/architecture/banking-rule-authoring-seam.test.ts` (5/5).
  Delete action on `RulesListPage` wired to `deleteRule` (was inert).
- **Phase 5 — History & explainability.** Org-wide SELECT policy on
  `bank_reconciliation_matches` replaced with business+branch scoped policy. History served
  only by hardened `SECURITY DEFINER` RPCs `bank_match_history` and
  `bank_match_session_history`; internal helpers revoked from public. Client seam
  `useBankMatchHistory`; UI `BankMatchDecisionCard`, `BankMatchHistoryPanel`,
  `BankSessionAuditTrail`, wired into `BankReconciliation.tsx` and `ReconciliationHistoryTab.tsx`.
  Ratchets: `banking-match-history-read-seam.test.ts` + `bank_match_history_read_seam_test.sql`.

## Phase 6 — Assistive AI (implemented this turn, needs verification)

Principle held: **the AI advises, it cannot change the books.**

- `supabase/functions/reconciliation-assistant/index.ts` — deployed. Two actions:
  - `rank_candidates` — comments on and orders candidates the *database* produced.
  - `explain_history` — narrates the Phase 5 decision record.
  Guarantees: no service-role client (reads on the caller's JWT only), 401 on anonymous
  (verified live), no write seam / journal / insert-update-delete reachable, reads only
  `bank_match_candidates` and `bank_match_history` (no direct table access), model output
  restricted to server-produced indices with omitted candidates re-appended, ids stripped
  before the upstream call, free text treated as data not instructions, settled/proposed
  lines declined, and a degraded (`ai_available: false`) answer when the gateway is absent.
- `src/hooks/useReconciliationAssistant.ts` — query-only, `enabled` defaults to `false`
  (never fires on a worklist), one bank line per call.
- `src/components/banking/ReconciliationAiAdvisory.tsx` — `CandidateAdvisoryPanel` and
  `HistoryNarrativePanel`. Both are opt-in ("ask" button), labelled "advisory only, no action
  taken", carry no mutation, and state plainly what to do when unavailable.
- Wiring: advisory panel in `ReconcileTransactionSheet.tsx` beside (not instead of) the
  engine's candidate list, and only when more than one candidate and the line is unexplained;
  narrative at the top of `BankMatchHistoryPanel`.
- Ratchet: `src/test/architecture/reconciliation-ai-advisory-boundary.test.ts` (9/9 passing).
- Typecheck clean.

### Pending in Phase 6

- Authenticated browser walk-through of both panels against a real ambiguous line and a
  reversed line (not yet run in any turn).
- Gateway failure-mode check with `LOVABLE_API_KEY` unset (degraded copy renders).

## Phase 7 — Hardening & rollout (next)

1. Rate/cost guard on `reconciliation-assistant` (per-user throttle) before wide exposure.
2. Operator-facing docs on what the assistant may and may not do.
3. Full-suite triage: unrelated pre-existing failures observed (`wms-rpc-grants`,
   `bank-feeds-business-level-gating`, `banking-business-level-gating`,
   `bank-export-template-metadata`, `pos-statement-gl-cutover`,
   `post-payroll-gl-simulation-boundary`). None caused by this wave — confirm and schedule.

## Instructions for the next agent

1. **Verify Phase 6 before building anything.** Re-read the edge function and confirm each
   guarantee above holds in code, not just in comments. Run
   `bunx vitest run src/test/architecture/reconciliation-ai-advisory-boundary.test.ts` and
   the Phase 4/5 ratchets. Confirm the deployed function still rejects anonymous calls.
2. Complete the two pending Phase 6 items (browser walk-through, degraded-mode check) so the
   phase is coherent before moving on.
3. Then resume at **Phase 7 item 1**. Do not start unrelated work, and do not widen the AI's
   authority: any change that lets the assistant write, post, or read outside the two RPCs is
   a breach of this wave's architecture and the ratchet exists to stop it.
