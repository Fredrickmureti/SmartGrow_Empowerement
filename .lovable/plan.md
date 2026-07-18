
# Wave 3 — POS Payment Engine: Enterprise Architecture Audit & Re-engineering

Wave 2 (checkout commit, card FSM, settlement→GL, drawer/shift lifecycle, return FSM) is shipped and green. This wave takes ownership of the **payment subsystem itself** — the layer between "cart ready to charge" and "transaction committed / accounted" — and lifts it to the standard set by Dynamics 365 Commerce, Oracle Retail, LS Central, and Square.

Scope is deliberately narrow: **payment lifecycle, tender orchestration, authorization/capture, split & partial tender, refund/void, settlement handoff, and the events they emit.** Receipts, drawer UX, loyalty, promotions, hardware, and reporting are only touched where they consume payment events.

---

## Status dashboard

| Phase | Title | Status |
|---|---|---|
| 0 | Canonical lifecycle & audit deliverables | ✅ **Complete & verified** |
| 1 | `PaymentSession` durable aggregate + session RPCs | ⏭️ **Next up — start here** |
| 2 | `TenderDriver` interface + `PaymentSessionController` | ⏳ Pending |
| 3 | Unified refund / void / reverse FSM across tenders | ⏳ Pending |
| 4 | Offline & multi-currency posture for sessions | ⏳ Pending |
| 5 | Cashier UX pass over the rebuilt domain | ⏳ Pending |

**Currently active phase:** none — Phase 0 landed, Phase 1 not yet started.
**Next phase to tackle:** Phase 1 (schema + RPCs for `pos_payment_sessions`).

---

## Phase 0 — Canonical lifecycle & audit deliverables ✅ COMPLETE

Two artifacts shipped and cross-referenced. No code changes, per plan.

**Delivered:**

- `docs/architecture/POS_PAYMENT_ENGINE.md` — canonical lifecycle (10-stage flow diagram), ownership contract per stage, tender-capability matrix, failure taxonomy, event topics with idempotency keys, explicit non-goals.
- `docs/audit/pos-payment-engine.md` — 10-section stage-by-stage grading (Owned / Duplicated / Leaked / Missing) with file+line citations, ending in a gap→phase table.

**Key findings that shape Phases 1–5 (do not re-litigate; verify against the docs):**

1. **`pos_payment_sessions` is the highest-impact gap.** A payment in progress lives entirely in `PaymentDialog` `useState` (lines 101-113). Refresh, partition, or accidental close orphans captured card authorisations. Fixed in Phase 1.
2. **`paymentMethodResolver.ts:129-193` violates the Phase B catalog-driven contract** by switching on hardcoded `method_key` strings. The existing extensibility guard (`pos-payment-method-extensibility.test.ts`) only covers the dialog file. Fixed in Phase 2 (switch on `tender_kind`; extend arch guard to the resolver).
3. **`capabilities` (allowsChange / allowsPartial / allowsOffline / refundable) is missing everywhere.** Every consumer re-derives from `tender_kind`/`capture_mode` inline. Belongs on the catalog row + `ResolvedPaymentMethod`.
4. **MPESA STK and MPESA C2B are two code paths for one tender.** Collapse behind a single `MobileMoneyDriver` with two `authorize()` strategies in Phase 2.
5. **Gift cards, vouchers, credit notes, store credit are not first-class tenders** despite backing tables existing.
6. **Card FSM, commit idempotency, settlement→GL, offline sale replay are all Owned.** Wave 3 must not regress them.

---

## Phase 1 — Domain model: `PaymentSession` as durable, idempotent aggregate ⏭️ NEXT

Introduce a first-class server-side aggregate so a payment in progress is a real record, not UI state.

**Schema (new tables, both in `public`, both need `GRANT` + RLS + policies per house rules):**

- `pos_payment_sessions(id, pos_transaction_id NULL, register_id, cashier_id, business_id, branch_id, currency, grand_total, tip_amount, status, idempotency_key UNIQUE, opened_at, closed_at, closed_reason)` — status ∈ `open | balanced | committed | cancelled | abandoned`.
- `pos_payment_session_tenders(id, session_id, tender_kind, method_key, provider_key, amount, tendered_amount, change_given, reference, auth_state, auth_id, vendor_txn_id, driver_payload jsonb, created_at)` — one row per authorised/captured tender **before** commit. FSM enforced via a trigger that generalises the shape used by `pos_card_fsm_transitions`.

**RPCs (SECURITY DEFINER, service_role, all idempotent):**

- `pos_payment_session_open(p_register_id, p_grand_total, p_idempotency_key)` — returns session id; idempotent on the key.
- `pos_payment_session_record_tender(p_session_id, p_tender jsonb, p_idempotency_key)` — appends a tender row; FSM-validated; totals recomputed server-side; refuses over-allocation beyond the configured cash overtender cap.
- `pos_payment_session_reverse_tender(p_session_id, p_tender_id, p_reason)` — pre-commit reversal (void for card, refund for wallet, offset for cash) with matching outbox event.
- `pos_payment_session_commit(p_session_id)` — atomically links session to the sale via `process_pos_transaction` and marks committed. Tender rows are copied into `pos_transaction_payments` in the same tx so existing card-FSM guards keep working.
- `pos_payment_session_cancel(p_session_id, p_reason)` — reverses every captured tender, marks cancelled.

**Guards:**

- Extend ESLint rule `no-pos-commit-without-idempotency-key.js` to also cover `pos_payment_session_open` and `pos_payment_session_record_tender`.
- New arch test `src/test/architecture/pos-payment-session-lifecycle.test.ts` locking: (a) commit only via `pos_payment_session_commit`, (b) no client-side writes to either new table, (c) status transitions match the FSM in the canonical doc.

**Definition of done for Phase 1:** migrations applied, RPCs callable from a test, outbox events registered in `business_event_topics`, arch guards green. `PaymentDialog` continues to work unchanged (still on the legacy path) — the migration to sessions happens in Phase 2.

---

## Phase 2 — Client architecture: `TenderDriver` interface + `PaymentSessionController` ⏳

Refactor `PaymentDialog` from an 842-line god component to a thin orchestrator over a domain service.

- **New `src/domain/pos/payment/`**
  - `PaymentSession.ts` — immutable value object: totals, remaining, allocations, `isBalanced()`, `changeDue()`, `canAcceptTender(kind, amount)`. Pure, unit-testable, no React, no supabase.
  - `TenderDriver.ts` — interface `{ kind, capabilities: { allowsChange, allowsPartial, allowsOffline, refundable }, prepare(session), authorize(input), capture(authId), void(authId), refund(authId, amount) }`. Mirrors the electron `IPaymentTerminalDriver` shape.
  - `drivers/CashDriver.ts` — overtender + rounding; no server auth.
  - `drivers/CardDriver.ts` — thin wrapper around existing `CardTerminalController`.
  - `drivers/MobileMoneyDriver.ts` — collapses `MpesaPaymentModal` + `MpesaC2BLookupModal` (STK vs C2B become two strategies of one driver's `authorize()`).
  - `drivers/CustomerCreditDriver.ts`, `drivers/StoreCreditDriver.ts` — first-class tenders instead of PaymentDialog specials.
  - `drivers/GiftCardDriver.ts` — uses existing `pos_gift_cards` tables via a new authorize/capture RPC pair.
  - `PaymentSessionController.ts` — opens session, drives selected driver, records tenders, reverses on error, commits when balanced. What `PaymentDialog` calls.
- **PaymentDialog** shrinks to layout + tender picker + amount input; every `if method === "cash" | "card" | ...` branch disappears.
- **`paymentMethodResolver`** — switch on `tender_kind` (not `method_key`), and grow a `capabilities` field. Extend `pos-payment-method-extensibility.test.ts` to cover the resolver file, not just the dialog.

---

## Phase 3 — Unify refund / void / reverse across tenders ⏳

Today only card has a real FSM; cash/mobile-money reversals write directly. Extend the Wave 2 return-authorization pattern to every tender:

- New table `pos_tender_reversal_authorizations(id, session_id NULL, transaction_id NULL, tender_id, requested_by, approver_id, kind ∈ 'void'|'refund'|'reverse', state, reason_code_id, manager_pin_verified_at, applied_at)` with the same `requested → approved → applied` FSM used by `pos_return_authorizations`.
- Every reversal routes through `TenderDriver.void|refund` → RPC → FSM → outbox `tender.reversed`. Dispatcher posts the reversing JE (mirror of the original tender's posting) keyed on `pos_tender_reversal_apply_log(authorization_id PK)`.
- Delete direct UPDATEs on `pos_transaction_payments` outside the RPC surface; add arch guard `pos-tender-reversal-single-path.test.ts`.

---

## Phase 4 — Offline & multi-currency posture ⏳

Sales commit is already offline-capable; the payment layer isn't:

- `pos_payment_sessions.status = 'open'` rows synced through the existing offline queue → `pos_payment_session_open` called with offline-generated `idempotency_key`, then tenders replay in order.
- Drivers self-declare offline support: `capabilities.allowsOffline` — card/MPESA refuse offline; cash + customer credit + gift card allow it.
- Session carries `currency` + `fx_rate_snapshot`; multi-tender across currencies computes per-tender applied amount in the sale's home currency at capture-time rate, stored on the tender row.
- Extend `pos-offline-replay-uses-rpc.test.ts` to cover the session RPC path.

---

## Phase 5 — Cashier UX pass (only after 1-4 land) ⏳

With the domain rebuilt, redesign `PaymentDialog` for the enterprise cashier: numeric-keypad-first fast-path, always-visible "Balance due / Change due" ledger driven by `PaymentSession`, one-key split (`S`), one-key reverse-last-tender (`R`), resumable sessions surfaced in `HeldOrdersBar` alongside held carts. Zero new business logic — pure presentation over the Phase 1-2 domain.

---

## Definition of done (whole wave)

- Phase 0 docs merged and referenced from `docs/audit/pos-transaction-lifecycle-canonical.md`. ✅
- `pos_payment_sessions` + tenders table live; all commits go through `pos_payment_session_commit`; legacy "assemble array + call finalize" path removed from `PaymentDialog`.
- Every tender (cash, card, mobile money, customer credit, store credit, gift card) implements a `TenderDriver`; no `method_key === "..."` branch survives in `src/components/pos/` **or** `src/lib/pos/`.
- Every reversal (void/refund/reverse) goes through the unified authorization FSM; no direct writes to `pos_transaction_payments`.
- All Wave 2 arch guards remain green; new guards added: `pos-payment-session-lifecycle`, `pos-tender-driver-contract`, `pos-tender-reversal-single-path`, `pos-payment-session-idempotency`.
- ESLint rule `no-pos-commit-without-idempotency-key` covers session RPCs.
- Every "Duplicated / Leaked" row in `docs/audit/pos-payment-engine.md` resolves to "Owned".

## Not in scope

Payment gateway integrations beyond what already exists (MPESA, sim card driver). Receipts, drawer/shift UX, loyalty accrual, promotions, fiscal device, physical hardware. Those wait for their own waves.

---

## Handoff — instructions for the next agent

**Before writing any code, verify Phase 0 was completed to enterprise standard:**

1. Read `docs/architecture/POS_PAYMENT_ENGINE.md` end-to-end. Confirm the lifecycle diagram, ownership table, capabilities matrix, failure taxonomy, and event-topic table are internally consistent and cite real tables/RPCs that exist in this repo.
2. Read `docs/audit/pos-payment-engine.md`. Spot-check three cited file:line references (e.g. `PaymentDialog.tsx:101-113`, `paymentMethodResolver.ts:129-193`, `CardTerminalController.ts`) and confirm the grading (Owned / Duplicated / Leaked / Missing) matches what's actually in those files today.
3. Confirm no code was changed under `src/`, `supabase/migrations/`, or `electron/` in the Phase 0 turn — Phase 0 is docs-only by design.
4. Run `bunx vitest run src/test/architecture` and confirm all Wave 2 arch guards are still green (baseline: 30/30 passing). Any red before Phase 1 starts is a regression to fix first.

**If verification passes, resume with Phase 1 in this order** (do not skip ahead, do not pick from later phases):

1. Write the migration for `pos_payment_sessions` and `pos_payment_session_tenders` — include `GRANT` + RLS + policies in the same migration (house rule), and the generalised FSM guard trigger.
2. Write the five session RPCs (`open`, `record_tender`, `reverse_tender`, `commit`, `cancel`) as SECURITY DEFINER, all idempotent, all emitting the outbox topics listed in `POS_PAYMENT_ENGINE.md` §6. Register the topics in `business_event_topics`.
3. Extend ESLint rule `no-pos-commit-without-idempotency-key.js` to cover `pos_payment_session_open` and `pos_payment_session_record_tender`.
4. Add arch test `src/test/architecture/pos-payment-session-lifecycle.test.ts` per the Phase 1 spec above.
5. Verify: migrations apply cleanly, arch tests green, `PaymentDialog` still works on the legacy path (no behaviour change yet — the client migration is Phase 2).

**Do not** touch `PaymentDialog.tsx`, the resolver, the MPESA modals, or introduce driver classes in this phase. Those belong to Phase 2 and doing them now creates orphaned code paths (the sessions table would have no client writer, or drivers would have no session to write to). Keep each phase in a coherent, production-ready state before moving to the next.

If the audit's findings do not match what you see in the code, **stop and re-scope Phases 1–5** before writing migrations — the audit is the source of truth for what's broken and its accuracy gates every downstream phase.
