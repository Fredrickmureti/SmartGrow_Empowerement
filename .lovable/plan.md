# POS Payment Engine — Verification + Phase 4.c-follow

The previous engineer's `plan.md` claims Phase 4.a/b/d/e/f/g landed and leaves one slice open: rewiring `PaymentDialog.tsx` onto `usePaymentSession`. Rather than trust that, I'll verify every claimed invariant against the codebase first, fix anything I find rotten, then execute the cutover.

## Phase A — Independent verification (no code changes)

For each claim in `plan.md`, confirm against the actual source. Treat every green checkbox as unverified.

1. **Arch guard suite is real, not tautological.** Run:
   ```
   bunx vitest run \
     src/test/architecture/pos-card-fsm.test.ts \
     src/test/architecture/pos-payment-session-lifecycle.test.ts \
     src/test/architecture/pos-legacy-commit-rpcs-server-only.test.ts \
     src/test/architecture/pos-mandatory-idempotency.test.ts \
     src/test/architecture/pos-payment-session-commit-contract.test.ts
   ```
   Read each assertion end-to-end. Any assertion that would pass on an empty file, matches only a comment, or matches unrelated migrations is a loophole — rewrite it before proceeding.

2. **Session RPCs match the guards.** Read the latest migration bodies for `pos_payment_session_open`, `pos_payment_session_record_tender`, `pos_payment_session_commit`, `pos_payment_session_cancel`, `pos_payment_session_sweep_abandoned`. Confirm:
   - Commit routes on `existing_transaction_id` (restaurant → `finalize_table_order`, retail → `process_pos_transaction`); apply-log lookup precedes both.
   - Exactly one insert into `pos_payment_session_apply_log` per commit, before `RETURN`.
   - `open` short-circuits on `(business_id, idempotency_key)` collision.
   - Snapshot columns (`fx_rate`, `settlement_currency`, `tip_policy`) are never mutated by any function body.
   - Sweeper calls `pos_payment_session_cancel` and is `service_role`-only; `pg_cron` job exists at `*/5 * * * *`.

3. **Client callers are gone.** `rg` confirms:
   - Zero `supabase.rpc("process_pos_transaction"` / `"finalize_table_order"` under `src/` outside test fixtures.
   - `POSTerminal.tsx` retail + restaurant + offline replay paths (`TransactionQueue`, `SQLiteSyncManager`) all funnel through `paymentSessionClient` with derived idempotency keys.

4. **`usePaymentSession` surface is sufficient for the dialog cutover.** Read `src/hooks/pos/usePaymentSession.ts`. Confirm rehydration filters on `register_id + idempotency_key + status IN ('open','recording')`, that `allocated`/`remaining`/`change` come from server rows only, and that no client-math helpers leak from its exports. `tsgo` clean.

5. **Deliverables of the verification pass** (recorded in `plan.md` as an appendix, no code touched yet):
   - Table: claim → file/line evidence → verdict.
   - List of loopholes / partial implementations, each promoted into the Phase-B task list.

If verification uncovers regressions, freeze Phase B and address them first in their own commit.

## Phase B — PaymentDialog cutover (Phase 4.c-follow)

Only after Phase A is green.

1. **Prop contract change.** `PaymentDialog` gains required `sessionContext: { registerId; shiftId; cartHash; cashierId? }`. Update every render site in one slice (`POSTerminal.tsx` retail + restaurant, split flow, and any `rg`-found consumer). No partial adoption.

2. **State migration.** Delete the 11 `useState` hooks that track tender math. Replace `payments`, `totalApplied`, `totalTendered`, `totalChange`, `remaining`, `change`, cash-rounding derivations with `usePaymentSession`'s server-authoritative fields. Keep `selectedMethod`, `amount`, `reference`, `cashTendered`, and modal-visibility flags — those are pure UI state.

3. **Recording flow.** `handleAddPayment`, M-Pesa `onConfirm`, card `onAuthorized` all call `session.recordTender(...)`. Errors surface via `session.error`; no local fallback totals. Card FSM metadata (`auth_state`, `auth_id`, `vendor_txn_id`, `authorized_amount`) travels on the tender payload unchanged.

4. **Commit flow.** `onComplete(payments)` becomes `session.commit(envelope)`; parent receives `CommitSessionResult` (`transaction_id`, `receipt_no`, `change`). Restaurant call site passes `existing_transaction_id`; retail omits it. Simplify the retail `POSTerminal` branch that currently repackages payments for `paymentSessionClient.commitSession` — the dialog owns the session end-to-end.

5. **New arch guard** — `src/test/architecture/no-client-payment-math.test.ts`:
   - No `.reduce(` over `payments` / `tenders` inside `PaymentDialog.tsx`.
   - No `useState<PaymentDialogPayment[]>` remaining anywhere.
   - `PaymentDialog.tsx` imports `usePaymentSession`.
   - Assertion strings anchored to real symbols so the test can't pass on an empty file.

6. **Playwright verification (mandatory).** Drive the running preview headlessly, screenshot each step, view the screenshots:
   - Retail cash-only sale end-to-end.
   - Split tender: cash + M-Pesa.
   - Card auth + capture through the FSM.
   - Restaurant table-order finalisation.
   - **Hard refresh mid-payment** — session must rehydrate with the same tender list, same remaining balance.

7. **Do NOT touch** in this slice: session RPCs (locked in 4.g), `paymentSessionClient.ts`, `usePaymentSession.ts` (unless Phase A found a gap), Card FSM internals.

## Phase C — Update `plan.md` and hand off

- Append verification results (evidence table, any loopholes fixed).
- Move Phase 4 to "closed" once 4.c-follow guard is green and Playwright evidence is filed.
- Enumerate follow-ups for the next wave: sweeper cutoff into `pos_settings.session_abandon_minutes`, cashier UX overhaul (numpad, quick-tender, split redesign), tender-driver interface unification, reversal-authorization FSM cross-service unification.

## Explicitly out of scope

Receipts, cash drawer redesign, reporting, loyalty, hardware, promotions, gateway integrations, cashier visual redesign. Phase 5 (cashier UX overhaul) does not start until 4.c-follow lands with green guard + Playwright evidence.

## Technical notes

- Every session RPC call MUST carry a deterministic `p_idempotency_key` (lint rule `no-pos-commit-without-idempotency-key`). Dialog derives per-tender keys as `${sessionKey}:tender:${i}`; commit uses the session's base key. No `|| crypto.randomUUID()` fallbacks.
- Rehydration requires the dialog to know `registerId + shiftId + cartHash` before it mounts — parent must compute `cartHash` deterministically from cart lines (stable stringify + sha256) so refresh reproduces the same session key.
- Restaurant path keeps `existing_transaction_id` on the commit envelope; the routing lives in the SQL (locked by C1), not the client.
