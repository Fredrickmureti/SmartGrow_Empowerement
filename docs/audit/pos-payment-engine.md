# POS Payment Engine — Stage-by-stage Audit

Status: Wave 3 · Phase 0 — Gap grading
Date: 2026-07-18
Canonical reference: [`docs/architecture/POS_PAYMENT_ENGINE.md`](../architecture/POS_PAYMENT_ENGINE.md)
Sibling audit: [`docs/audit/pos-transaction-lifecycle-canonical.md`](./pos-transaction-lifecycle-canonical.md)

Grades:

- **Owned** — one canonical implementation, in the right layer, guarded.
- **Duplicated** — the responsibility is implemented in more than one place.
- **Leaked** — the responsibility lives in the wrong layer (typically in `PaymentDialog.tsx` or a modal instead of a domain service or an RPC).
- **Missing** — the responsibility is not modelled at all today.

Every row cites the file(s) that back the grade. Findings drive Wave 3
Phases 1–4; the phases will be re-scoped if this audit surfaces
anything unexpected on second-pass reads.

---

## 1. Tender resolution & readiness

| Stage | Grade | Evidence | Notes |
|---|---|---|---|
| Catalog read (`pos_payment_methods`) | **Owned** | `src/hooks/pos/usePOSSettings.ts` via `usePOSSettings().enabledPaymentMethods`. | Single hook; consumed by dialog only. |
| Readiness gating (provider active, clearing account, register allow-list, customer present) | **Owned** | `src/lib/pos/paymentMethodResolver.ts` — `resolvePaymentMethods()`; guarded by `src/test/pos/payment-method-resolver.test.ts`. | Correctly returns unready methods with `blockedReason` so UI can render disabled chips. |
| Tender **capabilities** (allowsChange / allowsPartial / allowsOffline / refundable) | **Missing** | Not modelled in the resolver output; not on the catalog row; not read anywhere. | Every consumer re-derives from `tender_kind` / `capture_mode` inline. Wave 3 Phase 2 adds a `capabilities` field on `ResolvedPaymentMethod` and populates from the catalog. |
| Kind routing | **Leaked (partially)** | Resolver `switch (m.method_key)` at `paymentMethodResolver.ts:129-193` still branches on hardcoded `"cash" / "credit" / "mobile_money" / "card" / "bank_transfer" / "voucher"`. | Contradicts the Phase B "catalog-driven" contract. The `pos-payment-method-extensibility.test.ts` guard covers the *dialog* but not the *resolver*. Fix: switch on `tender_kind` (already a catalog column) instead of `method_key`; extend the arch guard to the resolver file. |

## 2. Payment session (pre-commit state)

| Stage | Grade | Evidence | Notes |
|---|---|---|---|
| Session as a persistent aggregate | **Missing** | No `pos_payment_sessions` table exists (verified against the supabase tables index — 165 `pos_*` tables, none named `_session` for payments; `pos_sessions` is the cashier login session, `pos_terminal_sessions` is the hardware pair). | A payment in progress lives entirely as `useState` inside `PaymentDialog.tsx` (`payments`, `amount`, `reference`, `cashTendered`, `showCardModal`, etc. — lines 101-113). Browser refresh, network partition, or accidental dialog close **loses every captured tender**. Card authorisations become orphan vendor auths with no session to reconcile against. This is the single most-impactful gap in the engine. |
| Session idempotency | **Missing** | See above. | Commit-level idempotency exists (`process_pos_transaction.p_idempotency_key`, ESLint rule `no-pos-commit-without-idempotency-key.js`) but there is no idempotency layer *between* "cashier tapped Cash" and "commit fires" — every retry re-enters the dialog fresh. |

## 3. Tender authorisation drivers

| Tender | Grade | Evidence | Notes |
|---|---|---|---|
| Cash | **Leaked** | `PaymentDialog.tsx:227-247` (`handleQuickCashPayment`), `168-220` (`handleAddPayment`), `117-123` (`applyCashRounding`). | Amount, tendered, change, and rounding math live in the dialog. No `CashDriver`. Server double-checks totals but the client is the source of the numbers. |
| Card | **Owned (well)** | `src/services/pos/CardTerminalController.ts` + `pos_card_*` RPCs + `pos_card_fsm_transitions` guard trigger. `pos-card-fsm.test.ts` locks the FSM. | Cleanest tender in the codebase. Only tender with a proper client-side FSM wrapper and a server-side FSM. **This is the pattern the other tenders should follow.** |
| Card modal presentation | **Owned** | `src/components/pos/CardPaymentModal.tsx` (205 lines). | Presentation-only; delegates every mutation to `CardTerminalController`. |
| Mobile money (MPESA STK) | **Leaked** | `src/components/pos/MpesaPaymentModal.tsx` (486 lines) owns the STK push, polling, and receipt-number handoff. | No driver abstraction; the modal is the driver. Cannot be reused from a keyboard-shortcut path or an offline replay. |
| Mobile money (MPESA C2B lookup) | **Duplicated** | `src/components/pos/MpesaC2BLookupModal.tsx` (189 lines) + `useMpesaC2BLookup.ts` hook. | Same *tender* as the STK modal but a second UI + second code path. A `MobileMoneyDriver` with two `authorize()` strategies (`stk` / `c2b_lookup`) collapses this to one driver. |
| Customer credit ("credit_liability" / A/R) | **Leaked** | `PaymentDialog.tsx:389-411` `handleCreditQuickPay`; `handleAddPayment` credit branch at `193-198`. | Constructs the payment line inline; no driver. |
| Store credit | **Missing** | No dedicated tender; users apply it as `credit_liability`. | Should be its own tender with its own driver so refund flows differ. |
| Gift cards | **Missing** | `pos_gift_cards` + `pos_gift_card_transactions` tables exist (verified in supabase tables index) but no PaymentDialog integration. | Table is present but no tender routes to it. Adding gift-card tender today requires editing PaymentDialog — a violation of the Phase B contract. |
| Vouchers / coupons | **Missing** (as *tender*) | Voucher exists as a `tender_kind` in resolver default branch (line 187) but no driver, no modal. | Falls back to reference input only. |
| Credit notes | **Missing** (as *tender*) | `credit_notes` table exists in finance; no POS tender routes to them. | |
| Bank transfer | **Owned (trivially)** | `PaymentDialog.tsx` reference-based fallback. | Deferred verification is manual today; acceptable for Wave 3 scope. |

## 4. Session math (tendered / applied / change / balance)

| Stage | Grade | Evidence | Notes |
|---|---|---|---|
| Applied total | **Duplicated** | `PaymentDialog.tsx:138`; also recomputed server-side by `process_pos_transaction`; also recomputed in `finalize_table_order` for restaurant. | Three sources of truth. Server one is authoritative but the client one drives UI. A `PaymentSession` value object (Wave 3 Phase 2) collapses the two client copies. |
| Tendered total | **Duplicated** | `PaymentDialog.tsx:139`. | Same pattern. |
| Change due | **Duplicated** | `PaymentDialog.tsx:140,142,145`. | Two different formulations in the same file (`totalChange` vs `Math.max(0, totalTendered − effectiveTotal)`); both used to render the same field. |
| Cash rounding | **Leaked** | `PaymentDialog.tsx:117-123`. | Rule lives client-side. Should be a pure helper consumed by the `CashDriver`. |
| Split-tender allocation | **Leaked** | `PaymentDialog.tsx` `payments` array + `handleAddPayment`. | No server-side aggregate; if the array is mutated inconsistently (a bug we've had) nothing catches it until commit. |
| Over-tender / under-tender guard | **Duplicated** | Client-side clamp at `PaymentDialog.tsx:236-237`; server enforcement in `_pos_record_payment`. | Server is authoritative (per ADR 0009) but the client can silently under-render if it drifts. |

## 5. Commit path

| Stage | Grade | Evidence | Notes |
|---|---|---|---|
| Atomic commit RPC | **Owned** | `process_pos_transaction` (main), `finalize_table_order` (restaurant). `POSTerminal.tsx:918` restaurant call; `usePOSTransactionOffline.ts:196` retail call. | Two commit surfaces (retail vs restaurant) but both funnel through `_pos_record_payment` and the same FSM guards. Acceptable duplication scoped to the two lifecycles. |
| Commit idempotency | **Owned** | `useCommitKey.ts` + ESLint `no-pos-commit-without-idempotency-key.js`. | Enforced end-to-end. |
| Payment row insert | **Owned** | `_pos_record_payment` (single helper called by both commit RPCs). | Correct. |
| FSM guard on payment insert | **Owned** | `pos_card_fsm_transitions` trigger + `pos-card-fsm.test.ts`. | Only enforces card; cash/wallet/credit inserts are trusted. |

## 6. Post-commit reversal (void / refund / reverse)

| Stage | Grade | Evidence | Notes |
|---|---|---|---|
| Card void / reverse | **Owned** | `pos_card_void`, `pos_card_reverse` RPCs; `CardTerminalController.void/reverse`. | FSM-enforced. |
| Cash reversal | **Leaked** | Currently through `pos_return_authorizations` (Wave 2 G.3) at the *transaction* level, not the *tender* level. | Works for whole-sale returns; partial single-tender reversal on a multi-tender sale has no FSM. |
| Wallet (MPESA) reversal | **Missing** | No MPESA B2C refund path from POS. | Manual reconciliation only. |
| Customer credit reversal | **Missing** | No first-class reversal; requires manual JE. | |
| Reversal idempotency ledger | **Missing** (unified) | Only `pos_card_settlement_gl_apply_log` and `pos_return_apply_log` exist. | Wave 3 Phase 3 introduces `pos_tender_reversal_apply_log`. |

## 7. Settlement handoff

| Stage | Grade | Evidence | Notes |
|---|---|---|---|
| Card batch → settlement rows | **Owned** | Wave 2 F.1-F.5. `pos_card_settlements`, `pos_card_settlement_apply`, `pos_close_card_settlement`. | Shipped, guarded. |
| Card settlement → GL | **Owned** | Wave 2 F.6. `pos_card_settlement_post_gl` + apply-log. Dispatcher wired on `settlement.card.closed`. | Shipped this session. |
| Cash drop / variance → GL | **Owned** | Wave 2 G.1-G.2. | Shipped. |
| Wallet settlement | **Missing** | No `pos_wallet_settlements`. MPESA transactions reconcile via `mpesa_c2b_transactions` outside POS. | Out of Wave 3 scope; documented for a later wave. |

## 8. Offline posture

| Stage | Grade | Evidence | Notes |
|---|---|---|---|
| Offline sale commit | **Owned** | `usePOSTransactionOffline.ts` + `TransactionQueue.ts` + `SQLiteSyncManager.ts`. Guarded by `pos-offline-replay-uses-rpc.test.ts`. | Sales replay through the same RPC, not a shadow path. |
| Offline **payment session** | **Missing** | Nothing to offline — sessions don't exist as records. | Wave 3 Phase 4: session is offline-first, tender rows queued in order, drivers refuse offline where kind requires connectivity. |
| Offline capability per tender | **Missing** | Not modelled; today "cash offline" works incidentally because cash needs no auth. | Turn into a first-class `capabilities.allowsOffline` on every driver. |

## 9. Multi-currency

| Stage | Grade | Evidence | Notes |
|---|---|---|---|
| Currency snapshot on sale | **Owned** | `pos_transactions.currency` (verified in tables index). | |
| Currency snapshot on tender | **Missing** | `pos_transaction_payments` does not store per-tender currency or FX rate. | Multi-currency tender (a rare but real enterprise case — accepting USD cash against a KES-priced sale) has no home in the schema. |
| FX rate snapshot at capture time | **Missing** | Uses live rate at commit time only. | |

Multi-currency is scoped into Wave 3 Phase 4 alongside offline because
the schema change is the same shape (per-tender snapshot columns).

## 10. UX / cashier flow

| Stage | Grade | Evidence | Notes |
|---|---|---|---|
| PaymentDialog responsibilities | **Leaked (severely)** | `PaymentDialog.tsx` is 842 lines and does: tender rendering, tender selection, amount input, cash-tendered input, cash quick-amounts, cash rounding, tip capture, split-payment array, MPESA modal orchestration, card modal orchestration, credit "quick pay", C2B lookup toggling, provider config lookup, and payment-line construction for four different tender kinds. | Violates SRP. Every future tender bloats this file further. |
| Split-tender workflow | **Owned (functionally)** but **Leaked (structurally)** | Works today; the array is client-only. | See §2 + §4. |
| Resumable payment | **Missing** | Dialog close = payments lost. | |

---

## Summary of gaps → Wave 3 phases

| Gap | Phase |
|---|---|
| No `pos_payment_sessions` aggregate; no per-boundary idempotency between "tap tender" and "commit" | Phase 1 |
| Resolver switches on `method_key` instead of `tender_kind`; missing `capabilities`; missing gift/voucher/credit-note tenders as first-class | Phase 1 (catalog cols) + Phase 2 (driver + resolver refactor) |
| Cash/wallet/credit tender modals own their own state; no `TenderDriver` abstraction; MPESA STK and C2B are two code paths for one tender | Phase 2 |
| Payment math (`applied`, `tendered`, `change`, `rounding`, `remaining`) duplicated across client and server | Phase 2 (`PaymentSession` value object) |
| No unified reversal FSM across tenders; MPESA and credit reversal missing entirely | Phase 3 |
| No offline session; no per-tender currency snapshot; no FX rate snapshot | Phase 4 |
| `PaymentDialog.tsx` is a 842-line god component | Phase 5 (presentation only, after 1-4) |

Everything the audit grades **Owned** is preserved as-is — Wave 3 must
not regress the card FSM, the commit idempotency, the settlement→GL
path, or the offline sale replay.
