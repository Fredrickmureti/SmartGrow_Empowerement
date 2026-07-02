# POS Benchmark — Odoo POS + Mature Retail Patterns vs Our POS

Date: 2026-05-11
Status: Stage 0 deliverable of the POS deep-audit & overhaul plan (`.lovable/plan.md`).
Scope: distill the principles that any enterprise-grade POS must satisfy, then map each principle 1:1 against the current state of our POS so later stages have an explicit benchmark to score against.

This doc does not modify code. It is the bar.

---

## 1. Principles to satisfy

### 1.1 Session / shift / cash control (Odoo POS + supermarket norm)
| # | Principle | Why it matters |
|---|---|---|
| S1 | Exactly one open session per (register, cashier) at any time | prevents double-counting, lost shifts |
| S2 | Opening float is mandatory and counted by denomination | makes variance attributable |
| S3 | All cash movements during a shift are typed: `opening_float`, `cash_in`, `cash_out`, `pickup`, `drop`, `petty_payout`, `closing_count` | every cent is reconciled |
| S4 | Closing requires a denomination count; variance > tolerance ⇒ manager PIN + `Cash Over/Short` GL line | accountability |
| S5 | Closed shift is read-only at the DB layer | no after-the-fact tampering |
| S6 | Shift close posts a single batched JE per tender + COGS + tax | keeps GL volume sane vs per-txn posting |
| S7 | Cannot close while held orders, unposted payments, or missing cash count exist | no orphaned data |

### 1.2 Order lifecycle
| # | Principle |
|---|---|
| O1 | Distinct states: `draft → paid → (voided | returned | invoiced)` |
| O2 | Cancel (pre-payment) ≠ Void (same-shift reversal) ≠ Return (cross-shift partial) — three flows, three audit trails |
| O3 | A paid transaction is **immutable**; reversals/returns are new rows linked back |
| O4 | Every paid transaction snapshots: prices, tax rates, customer, cashier, branch, currency, receipt template — reprints/returns must use the snapshot, not live data |
| O5 | Idempotency key on the commit RPC so flaky-network retries cannot double-post |

### 1.3 Cashier UX (supermarket bar)
| # | Principle |
|---|---|
| U1 | Cash sale ≤ 4 actions; barcode sale = 1 scan + 1 tap |
| U2 | Keyboard-first: F-keys for search/qty/discount/customer/hold/recall/pay; `*` qty multiplier (`3 * <scan>`) |
| U3 | Barcode buffer is focus-agnostic (works whether or not an input is focused) |
| U4 | Product search returns < 50ms on 10k SKUs (preload + IndexedDB cache) |
| U5 | Quick-tender buttons (Exact, $5/10/20/50, round-up) |
| U6 | Single-screen pay panel; no nested modals on the hot path |
| U7 | Held-orders bar always visible, recall in 1 click |
| U8 | Errors render inline; no blocking dialogs interrupting selling |

### 1.4 Returns / refunds
| # | Principle |
|---|---|
| R1 | Return is anchored to an original transaction (number, date+register, scan QR) |
| R2 | Per-line returnable qty = sold − already-returned, enforced server-side |
| R3 | Reason code required above a configured threshold |
| R4 | Manager PIN above a configured threshold |
| R5 | Refund tender defaults to original; manager override required to change |
| R6 | Inventory restored via `stock_movements` (positive); GL revenue/tax/COGS/cash all negate |
| R7 | Return receipt prints with `RETURN` watermark and links back to original |

### 1.5 Voids
| # | Principle |
|---|---|
| V1 | Same-shift only; cross-shift reversals must use Return |
| V2 | Always full amount; partial = Return |
| V3 | Manager PIN mandatory; reason mandatory |
| V4 | Original row marked `voided`; reversal row created; both visible in history with link |
| V5 | Reprint of voided transaction is watermarked `VOID` |

### 1.6 Manager approval / security
| # | Principle |
|---|---|
| M1 | Server-side PIN verification (never client) with rate-limit / lockout |
| M2 | Every restricted action writes to a `pos_manager_overrides` audit row (action, amount, original cashier, approving manager, reason, txn link) |
| M3 | Restricted actions and thresholds configurable per business: void, return, discount %, price override, cash_out, close-with-variance, reprint after N hours |

### 1.7 Inventory integration
| # | Principle |
|---|---|
| I1 | One canonical write path: `process_pos_transaction` / `process_pos_return` / `process_pos_void` → `stock_movements` |
| I2 | Branch-scoped, AVCO costed; never mutate `products.stock_quantity` from the client |
| I3 | Stock visibility uses the branch-aware RPC, not raw products read |
| I4 | Negative-stock policy resolved via `resolve_pos_setting('allow_oversell')` |
| I5 | Realtime inventory invalidation on movement insert |

### 1.8 Accounting integration
| # | Principle |
|---|---|
| A1 | Default = batched JE on shift close; per-txn posting is opt-in |
| A2 | Each method has GL mapping validated at Open Shift; missing mapping blocks open |
| A3 | Returns/voids posted in the same shift's batch with explicit reversal lines |
| A4 | Daily reconciliation report: shift summary vs GL JE per branch; mismatches flagged |
| A5 | Customer-account tender posts to AR with `source_pos_transaction_id` |

### 1.9 Receipts
| # | Principle |
|---|---|
| C1 | Receipts are snapshotted JSON; reprints use the snapshot |
| C2 | Watermarks: `REPRINT`, `VOID`, `RETURN` |
| C3 | Numbering monotonic per register; no gaps without an audit row |

### 1.10 Branch / multi-store
| # | Principle |
|---|---|
| B1 | Branch + business derived from `pos_registers` only — never UI context |
| B2 | Stock, cash, payment GL accounts, reports — all isolated per branch |
| B3 | Cashier access scoped via `pos_cashier_registers` with business match enforced |

### 1.11 Performance / scalability
| # | Principle |
|---|---|
| P1 | Indexes on hot paths: `pos_transactions(business_id, register_id, created_at desc)`, `pos_transaction_items(transaction_id)`, `stock_movements(business_id, branch_id, product_id, created_at desc)`, `pos_cash_movements(shift_id, performed_at desc)` |
| P2 | Terminal handles 10k products without re-render storms (virtualized list, memoized selectors) |
| P3 | RPC p95 < 250ms under 5 registers × 200 sales/hr |
| P4 | Shift close completes < 5s for a 1000-txn shift |

### 1.12 Reporting
| # | Principle |
|---|---|
| RP1 | All POS reports use the **same** unified report engine as Finance |
| RP2 | Every report ties back to a GL JE link |
| RP3 | Sales by shift/cashier/register/branch, payment-method summary, returns, voids, net sales, cash variance, product sales, tax summary, session report — all present and reconcile |

---

## 2. Map against current POS

Legend: ✅ meets bar · ◐ partial / shallow · ✗ missing or decorative · ? unverified.

| Ref | Principle | Status today | Evidence |
|---|---|---|---|
| S1 | One active session per (register, cashier) | ◐ | `usePOSSessions`/`pos_shifts` enforce in code, no partial-unique DB index found |
| S2 | Opening float counted by denomination | ✅ | `OpenShiftDialog`, `CashDenominationCounter` |
| S3 | Typed cash movement set | ◐ | `cash_in / cash_out / float / pickup` only; missing `drop`, `petty_payout`, explicit `opening_float`, `closing_count` types |
| S4 | Variance ⇒ PIN ⇒ Over/Short JE | ◐ | `CloseShiftDialog` + denom counter exist; PIN gating on variance not verified; Over/Short GL line not confirmed |
| S5 | Closed shift read-only at DB | ? | RLS update policy not yet inspected |
| S6 | Batched JE on shift close | ✅ | `trg_pos_shift_close_journal` + `pos_shift_close_errors` |
| S7 | Block close on held / unposted / missing count | ◐ | partial — needs explicit guard list |
| O1 | State machine | ✅ | `status` column + `process_pos_void` / `process_pos_return` |
| O2 | Cancel/Void/Return distinction | ◐ | UI conflates "Process Return" with refund-only path; void path separate (`process_pos_void`) |
| O3 | Immutability | ✅ | reversal-row pattern in place |
| O4 | Snapshot on commit | ◐ | prices/tax stored on items but no full receipt-snapshot JSON; reprint may use live template |
| O5 | Idempotency key on commit | ✗ | not present in `process_pos_transaction` signature |
| U1 | ≤ 4 actions / sale | ◐ | terminal works but mouse-heavy in spots |
| U2 | F-key shortcuts | ✗ | no global shortcut layer |
| U3 | Focus-agnostic barcode | ◐ | `useBarcodeScanner` exists; needs hardening |
| U4 | <50ms search on 10k | ? | `usePOSProductCache` exists, latency unmeasured |
| U5 | Quick-tender buttons | ◐ | partial in `PaymentDialog` |
| U6 | Single-screen pay | ◐ | dialog-based today |
| U7 | Held bar always visible | ✗ | accessed via dialog |
| U8 | Inline errors | ◐ | mostly toasts |
| R1 | Original-receipt search | ◐ | by number/date in `ReturnDialog`; no QR scan |
| R2 | Per-line returnable qty enforced | ? | UI clamps; server-side enforcement not confirmed (no `v_pos_returnable_qty` view) |
| R3 | Reason code by threshold | ✗ | no `pos_return_reasons` table |
| R4 | PIN by threshold | ◐ | `pos_security_settings.return_requires_manager` exists; threshold-driven gate not confirmed |
| R5 | Refund tender defaults to original | ✗ | UI lets user pick freely |
| R6 | Inventory + GL reverse | ✅ | `process_pos_return` does both |
| R7 | RETURN watermark + link | ◐ | link present; watermark unverified |
| V1 | Void = same-shift only | ? | not enforced in `process_pos_void` (verify) |
| V2 | Void = full amount | ? | needs check |
| V3 | PIN + reason mandatory | ◐ | reason yes; PIN gated by settings |
| V4 | Both rows visible w/ link | ✅ | history dialog |
| V5 | VOID watermark | ◐ | unverified |
| M1 | Server-side PIN + lockout | ◐ | `useManagerOverride` server-side; lockout via `pos_security_audit` partial |
| M2 | Every override audited | ◐ | `pos_manager_overrides` table exists; coverage incomplete |
| M3 | Configurable thresholds | ✗ | no `pos_manager_override_thresholds` table |
| I1 | Single canonical inv path | ✅ | enforced by tests |
| I2 | No client `stock_quantity` writes | ✅ | static guard test |
| I3 | Branch-aware stock RPC | ✅ | `get_available_pos_stock_for_register` |
| I4 | Oversell setting honored | ? | needs check in RPC |
| I5 | Realtime cache invalidation on movement | ◐ | invalidation on txn success only |
| A1 | Batched JE on shift close | ✅ | trigger present |
| A2 | GL mapping validated at Open Shift | ✗ | readiness check (`ensure_pos_ready_for_business`) checks general; per-tender mapping not gated |
| A3 | Returns/voids in same batch | ? | needs trace |
| A4 | Daily reconciliation report | ✗ | no `v_pos_shift_reconciliation` view |
| A5 | Customer-account tender posts AR | ◐ | `usePOSCreditSale` exists; lineage column added; AR posting path needs trace |
| C1 | Snapshot JSON on transaction | ✗ | not present |
| C2 | Watermarks | ◐ | partial |
| C3 | Monotonic numbering | ✅ | `transaction_number` sequence |
| B1 | Scope from register only | ✅ | CI-enforced |
| B2 | Per-branch isolation | ✅ | enforced |
| B3 | Cashier access | ✅ | `enforce_cashier_register_business_match` |
| P1 | Indexes | ? | needs `\d+` audit |
| P2 | 10k products without re-renders | ? | unmeasured |
| P3 | RPC p95 | ? | no load test |
| P4 | Shift close < 5s / 1000 txns | ? | unmeasured |
| RP1 | Unified report engine | ◐ | `usePOSEnhancedReports` may diverge from Finance engine |
| RP2 | Each report ⇒ JE link | ✗ | no JE link surfaced in report rows |
| RP3 | Full report set | ◐ | `EnhancedReports.tsx` covers most; net sales / cash variance reconciliation not confirmed |

---

## 3. Worst-offender shortlist (drives the code stages)

Ranked by risk × likelihood of biting in production:

1. **C1 + O4 + O5** — no receipt snapshot, no idempotency. A reprint after a price change shows the wrong receipt; a network retry can double-post. → Stage 3.
2. **R3, R4, R5, M3** — return/refund flow lacks reason codes, threshold-driven PIN, original-tender default, and configurable thresholds. → Stage 4 + 11.
3. **U2, U7, U6** — keyboard layer absent, held bar buried, multi-modal pay panel. Cashier speed is the brand promise. → Stage 2.
4. **A2, A4** — open shift doesn't gate on per-tender GL mapping; no daily reconciliation view. → Stage 8 + 10.
5. **S3, S4, S5, S7** — cash control missing types and the close-blockers list; closed-shift read-only not DB-enforced. → Stage 6 + 7.
6. **RP1, RP2** — POS reports diverge from the unified Finance engine and don't link to JEs. → Stage 17.
7. **P1 → P4** — performance is unmeasured. → Stage 16.

Each stage in `.lovable/plan.md` is sized against this shortlist.

---

## 4. What this doc is not

- Not a fix list. Stages 2–18 own the fixes.
- Not a re-litigation of the multi-entity work, which is already CI-enforced.
- Not a UI mockup. The bar above is functional, not visual.

End of Stage 0.
