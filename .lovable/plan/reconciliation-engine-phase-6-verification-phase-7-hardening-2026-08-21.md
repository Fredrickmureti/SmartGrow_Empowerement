# Reconciliation Engine — Phase 6 verification & Phase 7 hardening

## Verification of the previous engineer's claims (done this turn)

| Claim | Verdict | Evidence |
| --- | --- | --- |
| `reconciliation-assistant` edge function exists | CONFIRMED | `supabase/functions/reconciliation-assistant/index.ts` (370 lines) |
| Runs on caller's JWT, 401 on anonymous, no service-role client | CONFIRMED in code | `auth.getUser()` + two `401` returns; no service-role reference in the file |
| Degrades when the AI gateway key is absent | CONFIRMED in code | falls back to server order when `LOVABLE_API_KEY` is unset |
| Ids stripped before the upstream call | CONFIRMED in code | comment + shaping at line ~98 |
| Client seam is query-only and opt-in | CONFIRMED | `src/hooks/useReconciliationAssistant.ts`, `src/components/banking/ReconciliationAiAdvisory.tsx` |
| Panels wired beside the candidate list and the audit record | CONFIRMED | `ReconcileTransactionSheet.tsx:535`, `BankMatchHistoryPanel.tsx:69` |
| Ratchets pass | CONFIRMED | advisory-boundary 9/9, rule-authoring-seam 5/5, match-history-read-seam 5/5 — 19/19 green |

Gaps found that the previous engineer did not record:

- **G1 (risk).** `reconciliation-assistant` has **no entry in `supabase/config.toml`**, unlike the
  functions with explicit config. It inherits defaults rather than declaring `verify_jwt`
  intentionally — the boundary is real but undeclared.
- **G2 (defect, cost/audit).** The assistant logs **nothing to `ai_usage_logs`**, while
  `ai-assistant` and `ai-generate-email` both do. AI spend on the reconciliation path is invisible
  and unattributable per tenant.
- **G3 (pending).** No throttle of any kind — Phase 7 item 1 is genuinely unstarted.
- Still pending as recorded: authenticated browser walk-through and degraded-mode check.

Runtime behaviour of the panels remains UNVERIFIED — code review is not a walk-through.

## Work to do, in order

### Step 1 — Verify Phase 6 at runtime (no code changes)
1. Authenticated Playwright walk-through: an ambiguous bank line (>1 candidate, unexplained) —
   confirm the advisory panel appears, is opt-in, renders ranked commentary, and exposes no
   action/mutation control.
2. A reversed/settled line — confirm the advisory panel is **absent** and the history narrative
   renders on the audit record.
3. Degraded mode: call the function with `LOVABLE_API_KEY` unset and confirm `ai_available: false`
   with the server-produced ordering intact and honest copy in the UI.
4. Confirm the deployed endpoint still returns 401 unauthenticated.

Any failure here is fixed before Step 2.

### Step 2 — Close G1 and G2
- Declare `reconciliation-assistant` in `supabase/config.toml` with `verify_jwt = true`.
- Log every invocation to `ai_usage_logs` (business, user, action, tokens, degraded flag),
  reusing the `ai-assistant` logging shape rather than inventing a second one.

### Step 3 — Phase 7 item 1: per-user throttle (G3)
- Bounded rate limit per user per business (e.g. N calls / rolling window), enforced
  **server-side in the edge function**, before any upstream call.
- Reject with a typed `429` payload; the UI states plainly that the advisory is temporarily
  unavailable and that reconciliation is unaffected — the deterministic candidate list keeps working.
- Extend `reconciliation-ai-advisory-boundary.test.ts` with a ratchet asserting the throttle and
  the usage log cannot be removed, and that the advisory still carries no mutation.

### Step 4 — Phase 7 item 2: operator documentation
Short ADR (`docs/adr/`) stating what the assistant may do (rank, narrate) and may never do
(post, write, read outside the two RPCs, cross a tenant/branch boundary), plus the throttle and
degraded-mode contract.

### Step 5 — Phase 7 item 3: full-suite triage
Run the suite, confirm the six failures the previous engineer listed (`wms-rpc-grants`,
`bank-feeds-business-level-gating`, `banking-business-level-gating`,
`bank-export-template-metadata`, `pos-statement-gl-cutover`,
`post-payroll-gl-simulation-boundary`) are pre-existing and unrelated to this wave, and record
each as either out-of-scope with an owner or in-scope with a fix.

## Boundaries held throughout

The assistant advises; it cannot change the books. No new write seam, no service-role access,
no reads outside `bank_match_candidates` and `bank_match_history`, no AI-owned copies of ERP data,
no widening of scope into unrelated domains.
