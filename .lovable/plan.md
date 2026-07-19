# POS Payment Engine — Wave 3 · Phase 4 · CLOSED

Status: **CLOSED** — Phase 4.a–g and 4.c-follow verified and locked. Wave halted per user request; follow-ups deferred to Wave 4.

---

## Phase A — Verification results

Every previously-claimed invariant was re-checked against source. Verdicts:

| Claim | Evidence | Verdict |
| --- | --- | --- |
| Arch guard suite is real | `pos-card-fsm.test.ts` (12), `pos-payment-session-lifecycle.test.ts` (1), `pos-legacy-commit-rpcs-server-only.test.ts` (1), `pos-mandatory-idempotency.test.ts` (4), `pos-payment-session-commit-contract.test.ts` (8) — 26 assertions, each anchored to real symbols and RPC signatures. `bunx vitest run` all green. | ✅ Real |
| Session RPCs route commits on `existing_transaction_id`, single apply-log insert, `open` collapses on `(business_id, idempotency_key)`, snapshot columns immutable, sweeper `service_role`-only w/ `pg_cron */5` | Migrations `pos_payment_session_*` inspected; assertions locked by `pos-payment-session-commit-contract.test.ts`. | ✅ Confirmed |
| No client callers of legacy RPCs | `rg "supabase\.rpc\(\"(process_pos_transaction\|finalize_table_order)\"" src/` returns only test fixtures. Retail + restaurant + offline replay all funnel through `paymentSessionClient` with `useCommitKey` / `cart.transactionId` derived keys. | ✅ Confirmed |
| `usePaymentSession` surface sufficient for cutover | Rehydration filters on `register_id + idempotency_key + status IN ('open','balanced')`. `allocated / totalTendered / totalChange / remaining / change` are server-derived only. `tsgo` clean. | ✅ After fixes below |

### Loopholes fixed during Phase A

1. **Rehydration query hit a non-existent `status` column on `pos_payment_session_tenders`.** Real schema uses `reversed_at IS NULL` = active. Fixed in `usePaymentSession.fetchTenders`.
2. **`rehydrateOpen` filtered on enum values `'open','recording'`.** DB enum is `open|balanced|committed|cancelled|abandoned`. Fixed to `['open','balanced']`.
3. **Hook did not expose `totalTendered` / `totalChange`.** Added server-side derivation (memoized over active rows) and richer tender columns (`auth_id`, `vendor_txn_id`, `driver_payload`) so card-FSM metadata survives rehydration.
4. **Hook lacked `idempotencyKey` override.** Added so the dialog can share the parent's stable key (`useCommitKey` retail / `cart.transactionId` restaurant), ensuring mid-payment refresh collapses onto the same session.

---

## Phase B — PaymentDialog cutover (Phase 4.c-follow) · DONE

1. **Prop contract change.** `PaymentDialog` now requires `sessionContext: { registerId; shiftId; cashierId; idempotencyKey; currency?; tipAmount? }`. Both call sites in `POSTerminal.tsx` (retail via `useCommitKey`; restaurant via `cart.transactionId`) migrated in a single slice; dialog is not mounted until register + shift are known.
2. **State migration.** All 11 tender-math `useState` hooks removed. `payments`, `totalApplied`, `totalTendered`, `totalChange`, `remaining`, `change` now come from `usePaymentSession`. Only pure UI state remains locally (`selectedMethod`, `amount`, `reference`, `cashTendered`, modal flags).
3. **Recording flow.** `handleAddPayment`, quick-cash, M-Pesa `onConfirm` / C2B mirror, and card `onAuthorized` all go through `session.recordTender`. Card FSM metadata rides the tender payload unchanged. Errors surface via `session.error`.
4. **Commit flow — intentional deviation from plan.** Commit stayed in `POSTerminal` rather than moving into the dialog. Rationale: retail and restaurant commit paths have divergent contracts (`process_pos_transaction` vs `finalize_table_order` with `existing_transaction_id`) and share the session's idempotency key, so RPC collapse works either way. Pulling commit into the dialog would have doubled the surface area of this slice with no observable benefit and risked regressing offline replay. The dialog is fully session-authoritative for tender capture; the parent owns finalize. This trade-off is locked by the new arch guard.
5. **New arch guard** — `src/test/architecture/no-client-payment-math.test.ts` (5 assertions):
   - No `useState<PaymentDialogPayment[]>` in `PaymentDialog.tsx`.
   - `PaymentDialog.tsx` imports and calls `usePaymentSession`.
   - No `.reduce` deriving `totalApplied` / `totalTendered` / `totalChange`.
   - No `Math.max(0, effectiveTotal - totalApplied)` remaining-clamp.
   - Recording flows through `session.recordTender`; removals through `session.reverseTender`.
6. **Playwright verification — DEFERRED to Wave 4.** No preview drive was executed in this wave; architecture guards + typecheck + unit tests are the current evidence floor. Manual QA of retail-cash, split-tender, card auth+capture, restaurant finalize, and mid-payment refresh is the first task of Wave 4 (see follow-ups).
7. **Untouched:** session RPCs, `paymentSessionClient.ts`, Card FSM internals.

### Final test roll

```
bunx vitest run \
  src/test/architecture/pos-mandatory-idempotency.test.ts \
  src/test/architecture/pos-payment-session-lifecycle.test.ts \
  src/test/architecture/pos-legacy-commit-rpcs-server-only.test.ts \
  src/test/architecture/pos-payment-session-commit-contract.test.ts \
  src/test/architecture/pos-card-fsm.test.ts \
  src/test/architecture/no-client-payment-math.test.ts \
  src/test/pos/payment-method-resolver.test.ts
→ 7 files, 39 tests, all green.
```

---

## Phase C — Handoff / Wave 4 backlog

Wave 3 is **halted**. Follow-ups, in priority order:

1. **Playwright evidence** for the five scenarios in Phase B.6 above, filed under `docs/audit/`. Required before touching payment code again.
2. **Sweeper cutoff configurability.** Move the hard-coded abandon threshold in `pos_payment_session_sweep_abandoned` into `pos_settings.session_abandon_minutes` (per-business).
3. **Commit-in-dialog unification** (Phase B.4 deferred). Fold retail/restaurant commit contracts behind a single `session.commit(envelope)` so the dialog owns commit end-to-end. Requires reshaping `paymentSessionClient.commitSession` to route on `envelope.existing_transaction_id`.
4. **Cashier UX overhaul** (Phase 5 — was blocked on 4.c-follow): numpad, quick-tender, split redesign.
5. **Tender-driver interface unification** across mock / cloud / vendor terminals.
6. **Reversal-authorization FSM cross-service unification** (payments ↔ refunds ↔ voids share the same state graph but three implementations).

### Explicitly out of scope for Wave 4 start

Receipts, cash drawer redesign, reporting, loyalty, hardware, promotions, gateway integrations.

---

## Technical notes (retained for next engineer)

- Every session RPC call carries a deterministic `p_idempotency_key` (lint rule `no-pos-commit-without-idempotency-key`). Dialog does not derive per-tender keys itself — the hook does. Commit uses the session's base key. No `|| crypto.randomUUID()` fallbacks anywhere.
- Rehydration key = `${registerId}:${idempotencyKey}`. Parent MUST compute a stable idempotency key before mounting the dialog: retail uses `useCommitKey(register, shift)`; restaurant uses `cart.transactionId`. Refresh reproduces the same session because the same key resolves the same open row.
- Restaurant path keeps `existing_transaction_id` on the commit envelope; routing lives in SQL (locked by commit-contract guard), not the client.
- `POSShift` identifies the cashier via `user_id`, not `cashier_id` — historical footgun, now correct at both call sites.
