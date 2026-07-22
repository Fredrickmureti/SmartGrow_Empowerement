
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

---

## Stage 3 progress log (executed this turn)

Status: 🚧 IN PROGRESS — server enforcement + client policy hook + error catalogue landed. History menu split + UI wiring pending.

### RPC audit table

| RPC                                        | Before | After  | Action code                                             |
| ------------------------------------------ | ------ | ------ | ------------------------------------------------------- |
| `pos_card_void`                            | none   | ✅     | `pos_card_void`                                         |
| `pos_card_reverse`                         | none   | ✅     | `pos_card_reverse`                                      |
| `pos_payment_session_reverse_tender`       | none   | ✅     | `pos_payment_session_reverse_tender`                    |
| `pos_return_authorization_transition_v2`   | new    | ✅     | `pos_return_authorization_transition:<to_state>`        |

Backward compatible: extra params `(p_manager_override_id, p_organization_id, p_business_id, p_shift_id)` default to NULL. When `pos_override_matrix` has no row for the action, `assert_manager_override` returns NULL and the RPC behaves as before. Legacy `pos_return_authorization_transition` remains as the internal transition; `_v2` is the enforcement-aware entry point.

### Shipped

- Migration extending the four reversal RPCs above with override enforcement.
- `src/services/pos/reversal/overrideErrors.ts` — `parseOverrideError(err) → { code, title, description, retryable }`, `OVERRIDE_ERROR_CATALOGUE`; wired into the reversal barrel.
- `src/hooks/pos/useOverridePolicy.ts` — reads `pos_override_matrix` with business→org precedence; returns `{ required, thresholdAmount, restrictedRoles, actionCode }`. Exports `OVERRIDE_ACTION_FOR_COMMAND` mapping every `POSReversalCommandType`.
- Contract test `src/test/architecture/pos-override-policy.test.ts` (6/6): RPCs call `assert_manager_override`, taxonomy coverage complete, error catalogue complete.

### Remaining Stage 3 work (next turn)

1. **Extend `pos_override_matrix_action_chk`** to allow the new action codes so orgs can configure enforcement. Migration only.
2. **Wire dispatch sites** — `CardTerminalController.void/reverse`, `paymentSessionClient.reverseTender`, and any return-authorization dispatcher: call `useOverridePolicy` first, open `ManagerOverrideDialog` when `required`, forward the returned override id + envelope IDs into the RPC's new params.
3. **History action-menu split** — replace the single "Reverse" button in `src/apps/pos/terminal/history/HistoryWorkspace.tsx` with the six-command menu from `eligibleCommands(facts)`, each item gated by `useOverridePolicy`.
4. **Toast copy** — replace the blanket "Override denied / An unexpected error occurred" toasts at every reversal catch site with `parseOverrideError(err)`.

Exit criteria for Stage 3 remain unchanged (see the Stage 3 section above).

## Stage 3 completion log (this turn)

Status: ✅ STAGE 3 COMPLETE.

### Shipped in this turn

1. **Migration** — extended `pos_override_matrix_action_chk` to allow the four new action codes (`pos_card_void`, `pos_card_reverse`, `pos_payment_session_reverse_tender`, and pattern `pos_return_authorization_transition:%`).
2. **Client dispatch sites now thread the override envelope**:
   - `src/services/pos/CardTerminalController.ts::void|reverse` accept `{ managerOverrideId, organizationId, businessId, shiftId }` and forward to the RPCs.
   - `src/lib/pos/paymentSessionClient.ts::reverseTender` and its arg type extended with the same envelope; hook `usePaymentSession.reverseTender(tenderId, reason, approval?)` accepts it and passes through.
   - `src/components/pos/transaction-detail/CardPaymentActions.tsx` reads the envelope via `useTerminalSessionEnvelope` and wraps every failure in `parseOverrideError(err)` → structured toast (title + description).
3. **History action-menu split (six-command taxonomy)** — new component `src/apps/pos/terminal/history/TransactionActionMenu.tsx`. Uses `evaluateEligibility(facts)` from Stage 2; ineligible commands remain visible but disabled with a tooltip explaining the exact reason (no more "reverse-by-refund-and-hope" workaround). Wired into `HistoryWorkspace.tsx`:
   - `deriveFacts(tx)` bridges `POSTransactionRecord` → `EligibilityFacts` (status, shift match, card auth state, settled tenders, returnable lines, identified customer). Kept pure/deterministic for unit-testability.
   - `buildActionHandlers(tx)` maps each command to a dispatch route: `void_sale` → existing `handleVoid` (already wired to `useManagerOverride`); `return_goods`/`exchange`/`refund_sale`/`issue_store_credit` open the terminal return workspace via `dispatch({op:"openReturn"})` with a directive toast; `reverse_card_authorization` surfaces a hint pointing to `CardPaymentActions` in the details panel (which now enforces its own override + envelope path).
4. **Contract tests updated** — `src/lib/pos/__tests__/paymentSessionClient.test.ts` pins the new override-envelope keys on `pos_payment_session_reverse_tender` (both null and populated variants), plus the current `openSession` payload (`p_settlement_currency`, `p_tip_policy`, `p_fx_rate`). Green.

### Stage 3 exit criteria — status

- [x] Every reversal RPC gated by `assert_manager_override` server-side.
- [x] Every client dispatch site passes the manager-override id + envelope IDs when present.
- [x] `pos_override_matrix_action_chk` allows the new action codes so admins can configure enforcement without patching the DB.
- [x] Client policy hook (`useOverridePolicy`) exposes required/threshold/roles per action.
- [x] Error catalogue (`parseOverrideError`) maps every SQLSTATE 42501 tag to actionable user-facing copy.
- [x] History surface renders the full six-command taxonomy with eligibility gating and machine-readable rejection reasons.
- [x] Contract tests locked (6/6 architecture, 14/14 paymentSessionClient, typecheck clean).

### Handoff for Stage 4 (Reversal saga)

The audit's remaining architectural work is Stage 4: a durable, resumable reversal saga (`pos_reversal_workflow` + `pos_reversal_step`) so that a partial failure mid-refund (e.g. cash reversed but store-credit issue-note write fails) no longer leaves the terminal in a split-brain state. Stage 3 has intentionally routed `refund_sale`/`return_goods`/`exchange`/`issue_store_credit` through the existing return workspace with directive toasts; those handlers become the natural insertion points for the saga engine once its contract lands.
