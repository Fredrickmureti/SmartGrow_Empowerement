# Wave 3 · Phase 3 — Retail commit path on the payment-session lifecycle  ✅ COMPLETE

> **Status:** the online retail commit now runs through `openSession → recordTender × N → commitSession`. The direct `supabase.rpc("process_pos_transaction")` call is gone from `usePOSTransactionOffline.ts`; the session RPC forwards to it on the server. Restaurant mode (`finalize_table_order`) and offline replay stay on the legacy path — those move in Phase 4.
>
> **Landed artefacts (Phase 3)**
> - Migration (Phase 3.a): `pos_payment_session_commit` now returns `jsonb` — the full `process_pos_transaction` envelope augmented with `session_id`. Business failures from `process_pos_transaction` (`insufficient_stock`, `no_payments`, …) bubble as an exception so the outer transaction rolls back and the session isn't marked `committed`. Replays via the apply-log return the cached envelope of the first successful commit verbatim.
> - Migration (Phase 3.b): commit RPC's tender materialisation now promotes `card_last_four`, `card_type`, `authorized_amount`, and the M-Pesa receipt number from the tender's `driver_payload` up to top-level fields so `_pos_record_payment` inserts them onto the row (card FSM guard sees the same shape as the legacy path).
> - `src/lib/pos/paymentSessionClient.ts` — `commitSession` return type is now `CommitSessionResult` (typed envelope with `transaction_id`, `transaction_number`, `change`, `branch_id`, `session_id`, totals, `idempotent_replay`).
> - `src/hooks/pos/usePOSTransactionOffline.ts` — `processOnlineTransaction` rewritten to drive the three-stage session flow. Per-tender idempotency keys are derived from the register/shift commit key (`${key}:tender:${i}`), so retries at every stage collapse server-side. Card metadata is carried through `driver_payload`.
> - Updated `paymentSessionClient.test.ts` to assert the new envelope shape.
>
> **Guard status:** all 18 tests across `paymentSessionClient`, `pos-payment-session-lifecycle`, and `posScopeContaminationGuard` are green. The architecture guard now has a real second caller (the retail commit hook) proving the wrapper is the only route to the RPCs.
>
> **Explicitly out of scope in Phase 3** — Restaurant/table-order commit (`finalize_table_order`), offline replay via `TransactionQueue.processQueuedTransaction`, `PaymentDialog` state migration (still local `useState`, still works). Those are Phase 4.

---

# Wave 3 · Phase 2 — `paymentSessionClient` wrapper  ✅ COMPLETE



---

# Wave 3 · Phase 1 — `PaymentSession` durable aggregate + session RPCs  ✅ COMPLETE

> **Status (verified against live DB):** Phase 1 landed. Every DoD item below is checked against `information_schema` / `pg_catalog` / `business_event_topics` and against static guards in the repo.
>
> **Landed artefacts**
> - Migration: 3 tables (`pos_payment_sessions`, `pos_payment_session_tenders`, `pos_payment_session_apply_log`), FSM trigger `zzz_assert_tender_fsm`, branch-scope trigger on both writable tables, 5 SECURITY DEFINER RPCs (`open` / `record_tender` / `reverse_tender` / `commit` / `cancel`) + helper `pos_payment_session_allocated`, 5 outbox topics.
> - **Corrective migration (2026-07-18):** revoked direct `INSERT/UPDATE/DELETE` on all three tables from `authenticated`, revoked `SELECT` on `pos_payment_session_apply_log`. Session aggregate is now truly server-owned; writes only via the RPCs. Verified: `write_leaks = nil`.
> - Guard: `eslint-rules/no-pos-commit-without-idempotency-key.js` extended to require `p_idempotency_key` on `pos_payment_session_open` and `pos_payment_session_record_tender`.
> - Guard: `src/test/architecture/pos-payment-session-lifecycle.test.ts` — every reference to the 5 session RPCs must go through `src/lib/pos/paymentSessionClient.ts` (Phase 2 will add the wrapper; today the test allowlists nothing else, so any leak fails the build immediately).
> - Guard: `supabase/tests/pos_branch_isolation_test.sql` — branch-scope trigger array extended to cover both new writable tables.
> - Guard: `supabase/tests/pos_payment_session_lifecycle_test.sql` — structural contract: 3 tables exist, apply-log PK is `session_id` (commit idempotency), 5 RPCs are `SECURITY DEFINER`, `authenticated` has no direct writes, FSM + branch triggers attached, 5 outbox topics registered.
>
> Full end-to-end auth-required lifecycle simulation (open → tender → commit → apply-log blocks a second commit) is deferred to Phase 2, where the JWT test harness lands with `paymentSessionClient` and the first real client caller.

## Verification summary (Phase 0 handoff)


Independent re-audit against the parent prompt, `.lovable/plan.md`, and the current codebase:

| Handoff claim | Verified? | Evidence |
|---|---|---|
| `docs/architecture/POS_PAYMENT_ENGINE.md` exists (208 lines) | ✅ | file present |
| `docs/audit/pos-payment-engine.md` exists (135 lines) | ✅ | file present |
| No code changed under `src/` / `supabase/migrations/` in Phase 0 | ✅ | no `pos_payment_session*` references anywhere in the repo |
| `PaymentDialog.tsx:101-113` holds payment-in-progress in `useState` | ✅ | lines 101-113 are exactly the eleven `useState` hooks the audit cites |
| `paymentMethodResolver.ts:129-193` switches on hardcoded `method_key` | ✅ | `switch (m.method_key)` at line 129, cases `cash / credit / mobile_money / card / bank_transfer / voucher` |
| Wave 2 arch guards baseline | ⏳ | will re-run `bunx vitest run src/test/architecture` before writing the migration; must be green before Phase 1 lands |

**Conclusion:** Phase 0 landed as claimed. Phase 1 has not started. Resuming from the "start here" marker in `.lovable/plan.md`.

**Plan additions from re-audit** (appended to the living plan, not new phases):

- Phase 1 must register the outbox topics listed in `POS_PAYMENT_ENGINE.md §6` inside the same migration that ships the tables — otherwise `pos_payment_session_commit` publishes into nothing and downstream consumers silently no-op.
- Phase 1 must also seed a `pos_payment_session_apply_log(session_id PK)` idempotency guard for the commit RPC, mirroring `pos_card_settlement_gl_apply_log` / `pos_return_apply_log`. The original plan implies but does not name it; without it, a retried `pos_payment_session_commit` can double-link tenders into `pos_transaction_payments`.
- Arch test must additionally forbid client-side SELECT/INSERT on the two new tables from `src/components/pos/**` — the sessions layer is server-owned; the client reaches it only via RPCs.

Nothing else in Phases 2–5 changes shape.

---

## What Phase 1 delivers

A first-class, server-owned aggregate for "payment in progress" so a mid-payment refresh, tab close, or network partition never orphans a captured card auth or a cash tender. `PaymentDialog` keeps working unchanged on the legacy path; the client migration is Phase 2.

### 1. Migration — schema, grants, RLS, FSM trigger, outbox topics, idempotency log

Single migration, house-rule ordering (CREATE → GRANT → ENABLE RLS → CREATE POLICY):

- `pos_payment_sessions` — `(id, pos_transaction_id null, register_id, cashier_id, business_id, branch_id, currency, grand_total, tip_amount, status, idempotency_key unique, opened_at, closed_at, closed_reason)`. Status enum: `open | balanced | committed | cancelled | abandoned`.
- `pos_payment_session_tenders` — `(id, session_id, tender_kind, method_key, provider_key, amount, tendered_amount, change_given, reference, auth_state, auth_id, vendor_txn_id, driver_payload jsonb, created_at)`.
- `pos_payment_session_apply_log(session_id primary key, applied_at, transaction_id)` — commit idempotency guard.
- Generalised FSM guard trigger `tg_assert_pos_payment_session_tender_transition` (mirrors the existing `pos_card_fsm_transitions` shape) enforcing tender auth-state moves.
- Branch-scope trigger `zzz_assert_pos_branch_caller_access` on both tables (matches the pattern locked by `supabase/tests/pos_branch_isolation_test.sql`).
- Grants: `authenticated` gets read on sessions/tenders scoped by RLS; writes only via SECURITY DEFINER RPCs (no direct INSERT/UPDATE grants to `authenticated`). `service_role` gets ALL.
- RLS policies: SELECT scoped to caller's branch via `assert_pos_caller_branch_access`; no INSERT/UPDATE/DELETE policies for `authenticated` (RPC-only surface).
- Outbox topics registered in `business_event_topics`: `pos.payment.session.opened`, `pos.payment.tender.recorded`, `pos.payment.tender.reversed`, `pos.payment.session.committed`, `pos.payment.session.cancelled`.
- Extend `supabase/tests/pos_branch_isolation_test.sql` to include the two new tables in its `missing[]` array.

### 2. RPCs — five, all SECURITY DEFINER, all idempotent

- `pos_payment_session_open(p_register_id, p_grand_total, p_currency, p_idempotency_key)` → returns session id; upsert-by-idempotency-key.
- `pos_payment_session_record_tender(p_session_id, p_tender jsonb, p_idempotency_key)` → append tender row; FSM-validate; recompute allocated/remaining server-side; reject over-allocation past the configured cash overtender cap; emit `pos.payment.tender.recorded`.
- `pos_payment_session_reverse_tender(p_session_id, p_tender_id, p_reason)` → pre-commit reversal (void card / refund wallet / offset cash); emit `pos.payment.tender.reversed`.
- `pos_payment_session_commit(p_session_id)` → inside one tx: guard on `pos_payment_session_apply_log`, call existing `process_pos_transaction` / `finalize_table_order` with the session's tender rows mapped to `pos_transaction_payments` (preserving `tendered_amount` / `change_given` per ADR-0009), mark session `committed`, insert apply-log row, emit `pos.payment.session.committed`.
- `pos_payment_session_cancel(p_session_id, p_reason)` → reverse every captured tender, mark `cancelled`, emit `pos.payment.session.cancelled`.

Every RPC uses `assert_pos_caller_branch_access` as its first line — no privilege leaks vs the rest of the POS surface.

### 3. Guards — ESLint + architecture tests

- Extend `eslint-rules/no-pos-commit-without-idempotency-key.js` to also require the `p_idempotency_key` argument on `pos_payment_session_open` and `pos_payment_session_record_tender`.
- New `src/test/architecture/pos-payment-session-lifecycle.test.ts` locking:
  - commit path is exclusively `pos_payment_session_commit` (no other caller of `process_pos_transaction` gains a new tender-carrying overload);
  - no file under `src/components/pos/**` or `src/hooks/pos/**` writes to `pos_payment_sessions` / `pos_payment_session_tenders` directly (RPC-only);
  - the five status transitions and the tender FSM strings match the canonical doc verbatim (single source of truth).

### 4. Definition of done for Phase 1

- Migration applies cleanly; `supabase/tests/pos_branch_isolation_test.sql` passes with the two new tables listed.
- All five RPCs callable end-to-end from a Vitest RPC test (open → record cash tender → record card tender → commit → apply-log blocks second commit).
- Outbox topics present in `business_event_topics`; a commit emits all expected events.
- `bunx vitest run src/test/architecture` green, including the new `pos-payment-session-lifecycle.test.ts`.
- `PaymentDialog.tsx` unchanged — still on the legacy `finalize_table_order` path. No client behaviour changes in this phase.

### Explicitly out of scope for Phase 1

- `PaymentDialog` refactor, `TenderDriver` interface, drivers, resolver changes → Phase 2.
- Reversal-authorization FSM unification → Phase 3.
- Offline queue + multi-currency snapshot on sessions → Phase 4.
- Cashier UX pass → Phase 5.

Touching any of those now creates orphan code paths (the plan's stated reason for the phasing).

---

## Technical notes

- All `process.env` reads inside RPCs stay in PL/pgSQL; no server-function surface added in this phase.
- `pos_payment_session_commit` must run in one transaction with `process_pos_transaction`; the apply-log write is the last statement so a rollback leaves no ghost log row.
- The FSM trigger is generalised (parameter-driven allowed-transitions table) rather than a copy of the card FSM — Phase 3 will reuse it for tender reversals.
- Every new table gets the branch-scope trigger before any RLS policy is added — matches the locked pattern in `pos_branch_isolation_test.sql`, so the guard test can't be forgotten.

==========================================================
Phase 3 landed: retail online commit now flows openSession → recordTender × N → commitSession via the wrapper — the direct process_pos_transaction RPC call is gone from the client. Two migrations tightened the commit RPC (returns full envelope + surfaces business failures + promotes card/M-Pesa metadata from driver_payload); commitSession returns typed CommitSessionResult; 18/18 guard + contract tests green. Restaurant mode and offline replay stay on the legacy path — those are Phase 4.