
# Wave 3 — POS Payment Engine: Enterprise Architecture Audit & Re-engineering

Wave 2 (checkout commit, card FSM, settlement→GL, drawer/shift lifecycle, return FSM) is shipped and green. This wave takes ownership of the **payment subsystem itself** — the layer that sits between "cart ready to charge" and "transaction committed / accounted" — and lifts it to the standard set by Dynamics 365 Commerce, Oracle Retail, LS Central, and Square.

Scope is deliberately narrow: **payment lifecycle, tender orchestration, authorization/capture, split & partial tender, refund/void, settlement handoff, and the events they emit.** Receipts, drawer UX, loyalty, promotions, hardware, and reporting are only touched where they consume payment events.

---

## Phase 0 — Canonical lifecycle & audit deliverables (no code changes)

Produce two written artifacts that everything else is measured against:

1. `docs/architecture/POS_PAYMENT_ENGINE.md` — the canonical payment lifecycle:

    ```text
    resolve tenders → open payment session → select tender →
    validate (amount, currency, customer, provider readiness) →
    authorize (tender-specific driver) → capture →
    apply to session (split/partial/overtender/change) →
    session balanced? ──no──▶ next tender
                   └─yes──▶ commit sale (atomic) →
    emit payment.captured + sale.committed → settlement handoff →
    (later) settle → GL → reconcile
    Failure paths: decline, timeout, cancel, reverse, void, refund.
    ```

    For every stage: owner, inputs, outputs, invariants, idempotency key, failure/retry policy, downstream events.

2. `docs/audit/pos-payment-engine.md` — a stage-by-stage gap table (mirrors `pos-transaction-lifecycle-canonical.md`) grading each stage: **Owned / Duplicated / Leaked / Missing**, with file citations. This audit drives phases 1-4.

Known suspects to grade (seeded from the file survey; each still gets a live read before assertions land in the audit):

- `PaymentDialog.tsx` (842 lines) mixes tender selection, split-tender math, cash-rounding, tip capture, provider modals, and payment-row construction. Likely violates SRP; likely re-implements amount/change math that should live in a `PaymentSession` domain object.
- Three tender modals (`CardPaymentModal`, `MpesaPaymentModal`, `MpesaC2BLookupModal`) each own their own auth/state — no common `TenderDriver` interface on the client side (contrast with the vendor-agnostic `IPaymentTerminalDriver` already established in `electron/hardware/payment/`).
- `CardTerminalController` is the only tender that has a proper client-side FSM wrapper; cash/mobile-money/credit have none.
- `paymentMethodResolver` correctly gates readiness but does not model tender **capabilities** (change-giving, partial capture, offline queueing, refund method) — routing decisions elsewhere have to re-derive them.
- No `pos_payment_sessions` table: a "payment session" today is implicit state inside `PaymentDialog`. Nothing durable exists between "cashier started paying" and "sale committed", so an interrupted split-tender (crash, refresh, terminal timeout) loses all captured auths.
- Refund/void paths for non-card tenders are not first-class — only `pos_card_*` RPCs enforce transitions; cash/mpesa reversals write directly.

The audit's grading is what ships in Phase 0; the phases below are the **hypothesised** remediation and will be re-scoped once the audit is written.

---

## Phase 1 — Domain model: `PaymentSession` as durable, idempotent aggregate

Introduce a first-class server-side aggregate so a payment in progress is a real thing, not UI state.

- **New tables**
  - `pos_payment_sessions(id, pos_transaction_id NULL, register_id, cashier_id, business_id, branch_id, currency, grand_total, tip_amount, status, idempotency_key UNIQUE, opened_at, closed_at, closed_reason)` — status ∈ `open | balanced | committed | cancelled | abandoned`.
  - `pos_payment_session_tenders(id, session_id, tender_kind, method_key, provider_key, amount, tendered_amount, change_given, reference, auth_state, auth_id, vendor_txn_id, driver_payload jsonb, created_at)` — one row per authorized/captured tender **before** commit. FSM enforced by trigger reusing the existing `pos_card_fsm_transitions` shape, generalised.
- **RPCs (SECURITY DEFINER, service_role)**
  - `pos_payment_session_open(p_register_id, p_grand_total, p_idempotency_key)` — returns session id; idempotent on the key.
  - `pos_payment_session_record_tender(p_session_id, p_tender jsonb, p_idempotency_key)` — appends a tender row; FSM-validated; totals recomputed server-side; refuses over-allocation beyond configured overtender cap (cash only).
  - `pos_payment_session_reverse_tender(p_session_id, p_tender_id, p_reason)` — reverses a captured tender pre-commit (void for card, refund for mobile money, offset row for cash) with a matching outbox event.
  - `pos_payment_session_commit(p_session_id)` — atomically links session to the sale via `process_pos_transaction` and marks committed. All existing card-FSM guards keep working because the tender rows are copied into `pos_transaction_payments` in the same tx.
  - `pos_payment_session_cancel(p_session_id, p_reason)` — reverses every captured tender then marks cancelled.
- **Idempotency**: `idempotency_key` is required by the ESLint rule `no-pos-commit-without-idempotency-key.js` — extend that rule to also cover `pos_payment_session_*` calls.

Result: browser refresh, network retry, or terminal reboot mid-split-tender resumes the same session instead of double-charging or losing captured auths.

---

## Phase 2 — Client architecture: `TenderDriver` interface + `PaymentSessionController`

Refactor `PaymentDialog` from a 842-line god component to a thin orchestrator over a domain service.

- **New `src/domain/pos/payment/`**
  - `PaymentSession.ts` — immutable value object: totals, remaining, allocations, `isBalanced()`, `changeDue()`, `canAcceptTender(kind, amount)`. Pure, unit-testable, no React, no supabase.
  - `TenderDriver.ts` — interface: `{ kind, capabilities: { allowsChange, allowsPartial, allowsOffline, refundable }, prepare(session), authorize(input), capture(authId), void(authId), refund(authId, amount) }`. Mirrors the existing `IPaymentTerminalDriver` shape so the electron layer plugs in cleanly.
  - `drivers/CashDriver.ts` — wraps overtender + rounding; no server auth.
  - `drivers/CardDriver.ts` — thin wrapper around existing `CardTerminalController`.
  - `drivers/MobileMoneyDriver.ts` — wraps MPESA STK / C2B (consolidates `MpesaPaymentModal` + `MpesaC2BLookupModal` behind one driver; the two modals become presentation shells for the same driver's `authorize()` flow).
  - `drivers/CustomerCreditDriver.ts` and `drivers/StoreCreditDriver.ts` — treat customer/store credit as first-class tenders instead of PaymentDialog specials.
  - `drivers/GiftCardDriver.ts` (net-new, thin) — uses existing `pos_gift_cards` tables via a new authorize/capture RPC pair; unlocks gift card as a real tender without touching PaymentDialog again in the future.
  - `PaymentSessionController.ts` — orchestrates: opens the session RPC, drives selected `TenderDriver`, records tenders, cancels/reverses on error, commits when balanced. This is what `PaymentDialog` calls.
- **PaymentDialog** shrinks to layout + tender picker + amount input; every branch that today does `if method === "cash" | "card" | ...` disappears (already prohibited by `pos-payment-method-extensibility.test.ts` — extend that guard to also fail on driver-selection by method_key).
- **`paymentMethodResolver`** grows a `capabilities` field so the dialog can render "Partial", "Offline OK", "Change" affordances from data, not from hardcoded tender knowledge.

---

## Phase 3 — Unify refund / void / reverse across tenders

Today only card has a real FSM; cash/mobile money reversals write directly. Extend the Wave 2 return-authorization pattern to every tender:

- Add `pos_tender_reversal_authorizations(id, session_id NULL, transaction_id NULL, tender_id, requested_by, approver_id, kind ∈ 'void'|'refund'|'reverse', state, reason_code_id, manager_pin_verified_at, applied_at)` with the same `requested → approved → applied` FSM already used by `pos_return_authorizations`.
- Route every reversal through `TenderDriver.void|refund` → RPC → FSM → outbox event `tender.reversed`. Dispatcher posts the reversing JE (mirror of the original tender's posting) with idempotency ledger `pos_tender_reversal_apply_log`.
- Delete direct UPDATEs on `pos_transaction_payments` outside the RPC surface; add arch guard `pos-tender-reversal-single-path.test.ts`.

---

## Phase 4 — Offline & multi-currency posture

The platform is already offline-capable for sales commit; the payment layer isn't:

- `pos_payment_sessions.status = 'open'` rows synced through the existing offline queue → `pos_payment_session_open` is called with the offline-generated `idempotency_key`, then tenders replay in order. Card/MPESA drivers refuse offline (`capabilities.allowsOffline=false`); cash + customer credit + gift card allow it.
- Session carries `currency` and `fx_rate_snapshot`; multi-tender across currencies computes per-tender applied amount in the sale's home currency at capture-time rate (from `exchange_rates`), stored on the tender row. Enables future FX tender without another refactor.
- Extend `pos-offline-replay-uses-rpc.test.ts` to cover the session RPC path.

---

## Phase 5 — Cashier UX pass (only after 1-4 land)

With the domain rebuilt, redesign `PaymentDialog` for the enterprise cashier: one primary tender fast-path (numeric-keypad first, tender selection second), always-visible "Balance due / Change due" ledger driven by `PaymentSession`, one-key split (`S`), one-key reverse-last-tender (`R`), and resumable sessions surfaced in `HeldOrdersBar` alongside held carts. Zero new business logic — pure presentation over the Phase 1-2 domain.

---

## Definition of done

- `docs/architecture/POS_PAYMENT_ENGINE.md` + `docs/audit/pos-payment-engine.md` merged and referenced from `docs/audit/pos-transaction-lifecycle-canonical.md`.
- `pos_payment_sessions` + tenders table live, all commits go through `pos_payment_session_commit`, legacy PaymentDialog "assemble array of payments then call finalize" path removed.
- Every tender (cash, card, mobile money, customer credit, store credit, gift card) implements a `TenderDriver`; no `method_key === "..."` branch survives in `src/components/pos/`.
- Every reversal (void/refund/reverse) goes through the unified authorization FSM; no direct writes to `pos_transaction_payments`.
- All Wave 2 arch guards remain green; new guards added: `pos-payment-session-lifecycle`, `pos-tender-driver-contract`, `pos-tender-reversal-single-path`, `pos-payment-session-idempotency`.
- ESLint rule `no-pos-commit-without-idempotency-key` covers session RPCs.
- Duplicated logic map (from Phase 0 audit) shows every "Duplicated / Leaked" row resolved to "Owned".

## Not in scope

Payment gateway integrations beyond what already exists (MPESA, sim card driver). Receipts, drawer/shift UX, loyalty accrual, promotions, fiscal device, physical hardware. Those wait for their own waves.

## Execution order

Phase 0 (audit doc — the deliverable that decides whether phases 1-4 need re-scoping) → Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5. I will pause after Phase 0 for your review of the audit before writing migrations.
