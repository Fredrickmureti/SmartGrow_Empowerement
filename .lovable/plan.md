
# POS Refund/Reversal — Verification + Stage 3 Execution

## Verification of prior agent's claims

Spot-checked `.lovable/plan.md` against the tree:

- **Stage 1 (TerminalSessionEnvelope) — CONFIRMED.** `src/services/pos/session/TerminalSessionEnvelope.ts` exists, `useManagerOverride` accepts the envelope, contract test `terminal-session-envelope.test.ts` present, ESLint rule `no-loose-manager-override-args.js` registered. The literal `"Company not selected"` has been purged from runtime code (only appears in the envelope's doc comment and the contract test that pins the purge).
- **Stage 2 (Domain event taxonomy) — CONFIRMED.** `src/services/pos/reversal/{reasonCodes,events,commands,eligibility,index}.ts` exist; `pos-reversal-taxonomy.test.ts` present. Taxonomy is imported nowhere outside `src/services/pos/reversal/` and `src/test/architecture/` — no premature History-menu split (good; the plan explicitly forbids it before Stage 3).
- **`assert_manager_override`** already exists as a security-definer helper with a matrix (`pos_override_matrix`) and IS wired into several server RPCs (void, discount, etc.), but the audit's F3 finding that `pos_card_reverse` and some sibling reversal RPCs bypass it needs a per-RPC re-audit in Stage 3 Step 1 — not a blanket assumption.

Conclusion: no rework required for Stages 1–2. Resume at Stage 3 Step 1.

## Stage 3 — Policy-driven authorization (kills F3)

Goal: every reversal command's RPC enforces `assert_manager_override` server-side; PIN dialog becomes an approval-capture UI, not a gate. History screen splits the single "Reverse" button into the six-command action menu from Stage 2, gated by `evaluateEligibility` + a new `useOverridePolicy` hook.

### Steps

1. **Server-side RPC audit.** Enumerate every RPC that mutates POS state on the reversal paths (`pos_card_reverse`, `pos_void_transaction`, refund/return/exchange/store-credit RPCs, tender-adjustment helpers). Produce a table in `.lovable/plan.md` of `{rpc, currently_calls_assert_manager_override, required_action_code}`. Any RPC missing the call gets it added via migration, keyed off the command's canonical `action_code` (mapped from `POSReversalCommandType`).

2. **Migration — `pos_override_matrix_effective` view.** Resolves the effective policy row for `{command, amount, tender, receipt_age_days, category, role, store, business}` against `pos_override_matrix`, honouring precedence (branch → business → org default). Ships with GRANTs and RLS in the same migration (create → GRANT → ENABLE RLS → POLICY, per the public-schema rules).

3. **Client policy hook — `src/hooks/pos/useOverridePolicy.ts`.** Given a `POSReversalCommand` + facts, calls the view and returns `{required: boolean, reason: string, thresholds}`. When not required, the caller skips the PIN dialog entirely. When required, dialog opens, captures override, inserts into `pos_manager_overrides`, and returns the id to attach to the command envelope.

4. **Error copy.** Replace the blanket "Override denied" / "An unexpected error occurred" toasts with reason-specific copy driven by RPC SQLSTATE / hint codes: `override_required`, `override_expired`, `wrong_role`, `threshold_exceeded`, `invalid_pin`, `wrong_business`, `no_matrix_row`. Central mapping in `src/services/pos/reversal/overrideErrors.ts`.

5. **History action-menu split.** In `src/apps/pos/terminal/history/HistoryWorkspace.tsx`, replace the single "Reverse" button with a menu whose items are computed from `eligibleCommands(facts)` and gated by `useOverridePolicy`. Each item routes to its existing legacy implementation (Void → `pos_void_transaction`, Refund → `useTransactionReversal.refundCustomer`, etc.) — the saga consolidation is Stage 4, not now.

6. **Contract test — `src/test/architecture/pos-override-policy.test.ts`.**
   - Every reversal RPC identified in Step 1 is invoked at least once through a code path that resolves the override via `useOverridePolicy` (grep-based structural test).
   - No feature-code file under `src/apps/pos/` or `src/components/pos/` calls a low-level reversal RPC without either (a) the envelope + `managerOverrideId` shape or (b) an explicit `// eslint-disable-next-line local/no-direct-reversal-rpc` marker.
   - Blanket "Override denied" string is absent from `src/`.

### Exit criteria

- Every reversal RPC provably rejects a call whose override is missing/forged (unit tests on each RPC using pgTAP or vitest against the DB helper).
- History screen renders the six-command menu; each menu item shows a policy-driven reason when disabled.
- Five+ specific override error strings replace the single blanket one.
- Stage 3 row on the status board flipped to ✅ COMPLETE with test path recorded.

### Non-goals (preserved from plan)

- No saga consolidation (Stage 4).
- No offline PIN bundle (Stage 5).
- No deletion of legacy reversal hooks (Stage 6).
- No hand edits to `supabase/migrations/` — use the migration tool.
- No reintroduction of loose scalar IDs on hooks.

## Technical notes

- Migration order for the new view: `CREATE VIEW` → `GRANT SELECT ... TO authenticated` → RLS is inherited from underlying `pos_override_matrix`, but the view is defined `SECURITY INVOKER` so caller's RLS applies.
- `useOverridePolicy` uses `useQuery` with `queryKey: ['pos-override-policy', command.type, businessId, thresholds]` and `staleTime: 5 min`; the shift-open envelope is authoritative for `businessId/branchId/registerId/shiftId/cashierId`.
- Error-code contract between RPC and client: RPCs raise with `ERRCODE = 'P0001'` and a machine tag in the message prefix (`[override_expired]`), parsed centrally.
- Do not modify `src/routeTree.gen.ts` or `supabase/functions/`; this stage is TanStack server-fn + migration only.
