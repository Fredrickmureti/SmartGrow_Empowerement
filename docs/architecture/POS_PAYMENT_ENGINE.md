# POS Payment Engine — Canonical Architecture

Status: Wave 3 · Phase 0 — Canonical reference
Date: 2026-07-18
Companion: [`docs/audit/pos-payment-engine.md`](../audit/pos-payment-engine.md)
Extends: [`docs/audit/pos-transaction-lifecycle-canonical.md`](../audit/pos-transaction-lifecycle-canonical.md), ADR 0009, ADR 0082.

The Payment Engine is the subsystem that sits between "the cart is ready
to be charged" and "the transaction is committed and accounted". It
does not own the basket, the sale, the inventory, the GL, the receipt,
the drawer, loyalty, or promotions. It orchestrates **tenders** into a
**payment session** that resolves the invoice, and it emits the events
that let those other domains do their jobs.

This document is the shape we hold ourselves to — inferred from mature
enterprise retail platforms (Dynamics 365 Commerce, Oracle Retail, SAP
Customer Checkout, NCR Retail, LS Central, Odoo POS, Shopify POS,
Square, Lightspeed). It is not a copy of any single implementation.

---

## 1. What is a payment (first principles)

A payment is not a row. A payment is:

1. an **intent** to settle an invoice for a given amount in a given
   currency, at a given moment, by a given cashier, on a given register;
2. a set of one or more **tenders** — each one authorised (or not) by
   a **driver** appropriate to its kind (cash, card, mobile money,
   customer credit, store credit, gift card, voucher, coupon, credit
   note, bank transfer);
3. resolved by a **session** whose invariant is
   `Σ(tender.amount_applied) == invoice.grand_total` and
   `Σ(tender.tendered) − Σ(tender.applied) == Σ(change_given)`;
4. **committed** atomically together with the sale, or **cancelled** —
   there is no third state visible outside the engine;
5. followed by a **settlement** phase (per tender kind) whose GL and
   reconciliation impact is deterministic and idempotent.

Every property that matters (auditability, replayability, financial
integrity, offline safety, split-tender safety) falls out of modelling
(1)-(5) as first-class server-side aggregates rather than as UI state.

---

## 2. Canonical lifecycle

```text
        Cart ready
            │
            ▼
   Resolve available tenders            ← paymentMethodResolver (catalog + provider + context)
            │
            ▼
   Open payment session                 ← pos_payment_session_open(idempotency_key)
            │
            ▼
   Select tender + amount               ← cashier picks kind & amount
            │
            ▼
   Validate                             ← currency, customer, capabilities, over-allocation
            │
            ▼
   Driver.authorize()                   ← tender-specific (cash: none; card: EMV; wallet: STK; credit: A/R hold)
            │
            ▼
   Driver.capture()                     ← tender-specific (cash: implicit; card: auth→capture; wallet: confirm; credit: post)
            │
            ▼
   Record tender on session             ← pos_payment_session_record_tender(idempotency_key)
            │
   Session balanced? ── no ──▶ next tender  (loop; split / partial)
            │
           yes
            │
            ▼
   Commit sale                          ← pos_payment_session_commit → process_pos_transaction
            │
   ┌────────┼────────┬───────────┬───────────┬──────────┐
   ▼        ▼        ▼           ▼           ▼          ▼
 sale.    payment. inventory.  drawer.     analytics.  audit.
 committed captured decremented cash_in     event       event
            │
            ▼
   Settlement phase                     ← per tender kind: card batch, wallet reconcile, cash drop
            │
            ▼
   GL posted + reconciled               ← pos_card_settlement_post_gl, pos_cash_drop_post_gl, …
            │
            ▼
   Closed

  Failure paths (from any pre-commit stage):
      decline / timeout / cancel → Driver.void or Driver.refund → session reverses that tender
      session-level cancel       → reverse all captured tenders → mark cancelled
      post-commit refund/void    → pos_tender_reversal_authorizations FSM (requested → approved → applied)
```

---

## 3. Ownership contract per stage

| Stage | Owner | Boundary invariant |
|---|---|---|
| Tender resolution | `paymentMethodResolver` (pure) | Reads catalog + provider + register + cart context. Returns *readiness* and *capabilities*; never mutates. |
| Session open | Payment engine (RPC) | Idempotent on `(register_id, idempotency_key)`. Emits `payment.session.opened`. |
| Tender authorise | `TenderDriver` implementation | Vendor / kind-specific. Never touches `pos_transaction_payments` directly. |
| Tender capture | `TenderDriver` implementation | Deterministic; captured amount ≤ authorised amount. |
| Tender record | Payment engine (RPC) | FSM-validated append to `pos_payment_session_tenders`. Recomputes totals server-side. |
| Session commit | Payment engine (RPC) | Atomic. Copies tenders into `pos_transaction_payments`. Calls `process_pos_transaction`. Emits `payment.captured` + `sale.committed` in-tx. |
| Session cancel | Payment engine (RPC) | Reverses every captured tender via its driver, marks session cancelled, emits `payment.session.cancelled`. |
| Reversal (post-commit) | Reversal-authorization FSM + dispatcher | `requested → approved → applied`. Manager-PIN-gated. Reversing JE via dispatcher, keyed on `authorization_id`. |
| Settlement | Settlement subsystem (per kind) | Card: `pos_card_settlements` + `pos_card_settlement_post_gl`. Wallet: reconciliation view. Cash: drawer / drop / variance. |
| Receipt | Presentation | Rendered from committed snapshot, never from live session state. |
| Loyalty / customer history | Customer / Loyalty domains | React to `sale.committed`; never write inside the commit RPC. |

The Payment Engine **orchestrates**; it does not own the customer
account, the gift-card wallet, the card terminal SDK, the M-Pesa
gateway, the GL, or the receipt. Each of those is behind a driver or an
outbox consumer.

---

## 4. Tender kinds and their capabilities

Every tender is described by three catalog columns
(`pos_payment_methods.tender_kind`, `capture_mode`, `provider_key`) plus
a computed capability set. The engine routes by capabilities — never by
`method_key === "cash"`.

| kind | capture_mode | allowsChange | allowsPartial | allowsOffline | refundable | driver |
|---|---|---|---|---|---|---|
| cash | implicit | ✅ | ✅ | ✅ | reverse (cash out) | `CashDriver` |
| card | auth_capture / auth_only | ❌ | ✅ | ❌ | void (pre-settle) / refund (post-settle) | `CardDriver` → `CardTerminalController` |
| mobile_money (wallet) | provider_confirm | ❌ | ✅ | ❌ (STK) / ✅ queued (C2B lookup) | provider refund | `MobileMoneyDriver` |
| customer_credit (A/R) | implicit | ❌ | ✅ | ✅ | credit note | `CustomerCreditDriver` |
| store_credit (liability) | implicit | ❌ | ✅ | ✅ | refund to balance | `StoreCreditDriver` |
| gift_card | authorize_capture | ❌ | ✅ | ✅ (offline reserve) | reload | `GiftCardDriver` |
| voucher / coupon | implicit | ❌ | fixed | ✅ | non-refundable | `VoucherDriver` |
| credit_note | implicit | ❌ | up to face value | ✅ | non-reversible | `CreditNoteDriver` |
| bank_transfer | reference | ❌ | ✅ | ✅ (deferred verify) | manual refund | `BankTransferDriver` |

Capabilities are **data on the catalog row**, not code in the dialog.
Adding a new tender is one migration + one driver file; no dialog edit.

---

## 5. Failure taxonomy

| Failure | Detected by | Recovery |
|---|---|---|
| Driver decline | driver.authorize() | Session unchanged; cashier picks another tender. |
| Driver timeout | driver | Session unchanged; driver retries with same auth idempotency key; if user cancels, session stays open. |
| Network partition mid-record | session RPC | Client retries with the same `record_tender` idempotency key; RPC returns the existing tender row. |
| Browser refresh mid-split | none needed | Session reloaded by id; captured tenders replay from `pos_payment_session_tenders`. |
| Terminal reboot mid-auth | driver + heartbeat | On reconnect, driver polls last auth by `vendorTxnId`; result reconciled to session or voided. |
| Commit failed after some captures | commit RPC (tx aborted) | Session stays `balanced`; cashier retries commit; if abandoned, `session_cancel` reverses every captured tender via its driver. |
| Post-commit refund | operator | `pos_tender_reversal_authorizations` (FSM) → dispatcher posts reversing JE. |
| Duplicate submission | idempotency_key (session, tender, commit) | RPC returns the existing row; no double capture, no double charge. |

There is exactly **one** idempotency contract per boundary:

- session open → `pos_payment_session_open.p_idempotency_key`
- record tender → `pos_payment_session_record_tender.p_idempotency_key`
- commit → `process_pos_transaction.p_idempotency_key` (existing, ADR 0082 D3)
- reversal apply → `pos_tender_reversal_apply_log.authorization_id` PK
- settlement→GL → `pos_card_settlement_gl_apply_log.settlement_id` PK
  (Wave 2 F.6, already shipped)

The ESLint rule `no-pos-commit-without-idempotency-key.js` enforces the
commit boundary today; Wave 3 extends it to the session boundaries.

---

## 6. Events emitted (canonical topics)

| topic | producer | consumers | idempotency key |
|---|---|---|---|
| `payment.session.opened` | `pos_payment_session_open` trigger | audit | `session_id` |
| `payment.tender.captured` | `pos_payment_session_record_tender` trigger | audit, analytics | `tender_id` |
| `payment.tender.reversed` | `pos_payment_session_reverse_tender` + `pos_tender_reversal_authorizations` transition | GL dispatcher, audit | `tender_id` + `reversal_id` |
| `payment.session.committed` | `pos_payment_session_commit` trigger | (fires alongside `sale.committed`) | `session_id` |
| `payment.session.cancelled` | `pos_payment_session_cancel` trigger | audit, analytics | `session_id` |
| `settlement.card.closed` | `pos_close_card_settlement` (Wave 2 F.5) | `pos_card_settlement_post_gl` (Wave 2 F.6) | `settlement_id` |
| `cash.drop.recorded` / `cash.variance.detected` | `pos_cash_movements` trigger (Wave 2 G.1) | cash-drop GL handler | `movement_id` |

All topics are registered in `business_event_topics` with explicit
`handler_scope` and `max_attempts`. Consumers are idempotent by the key
above; retries never double-post.

---

## 7. Non-goals (explicitly out of scope)

The Payment Engine does not own, and must not grow to own:

- the receipt document (rendered from the committed snapshot);
- the physical cash drawer (kicked by drawer subsystem on
  `payment.session.committed` when the tender mix requires it);
- loyalty accrual (Loyalty consumes `sale.committed`);
- promotions (Promotions resolves before the engine is invoked);
- inventory (Inventory reacts to `inventory.decremented`);
- fiscal device transmission (Fiscal consumes `sale.committed`);
- hardware discovery / pairing;
- reporting rollups (built from the outbox stream).

Any pull request that grows the engine to own one of these fails the
architecture guards.
