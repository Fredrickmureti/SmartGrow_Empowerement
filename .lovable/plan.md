# Currency & FX — handover verification (2026-08-22) and Phase 9 rework

Authority: ADR 0135 / 0136 / 0138. Predecessor log: previous `.lovable/plan.md`
(Phases 1–8 claimed complete, Phase 9 "realized FX on settlement" claimed next).

## 0. Supabase binding

VERIFIED FACT: this project is bound to Supabase project ref `jkszmrroyjfdwokbkzis`
and every query below ran against it. A project holds one Supabase binding, so
`AccrualFlowCorporation` cannot be attached alongside it. If that is a different
project you want to switch to, that is a destructive re-bind and needs an explicit
decision — it is out of scope for this wave.

## 1. Verification of the previous engineer's claims (this session, live catalogue)

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Step 4 — only `_pick_exchange_rate_row` reads the rate book | VERIFIED | catalogue sweep of `pg_get_functiondef` across `public`: only `_pick_exchange_rate_row` (read), `publish_platform_rates` and `set_exchange_rate_override` (writes) reference `exchange_rates` |
| No parity fallback in settlement/base conversion | VERIFIED | `to_base_amount`, `record_multi_invoice_payment`, `record_multi_bill_payment` contain no `COALESCE(rate, 1)` |
| Step 5 — guard suites exist | VERIFIED (files present) | `supabase/tests/fx_single_rate_reader_test.sql`, `fx_settlement_realized_test.sql`, `fx_revaluation_lifecycle_test.sql`, `fx_realized_tieout_test.sql`, `fx_realized_ap_tieout_test.sql`, `fx_compensation_tieout_test.sql`, `fx_bank_match_tieout_test.sql`; architecture ratchet `src/test/architecture/fx-single-engine.test.ts`. Re-execution pending (Phase 9.0) |
| Phase 9 premise: "realized FX missing from `record_payment_atomic`" | **INVALIDATED** | `record_payment_atomic` is a deprecated shim: it locks the invoice, computes `LEAST(amount, balance_due)` and delegates the whole posting to `record_multi_invoice_payment`, which does use `resolve_exchange_rate` + `resolve_fx_realized_account`. Single-invoice settlement already realizes FX |
| Phase 9 premise: "settlement reversals miss realized FX" | **CONFIRMED — real defect** | `unapply_payment_atomic` posts a flat DR customer_deposits / CR AR at `applied_amount` with no rate resolution and no realized-FX line; `void_payment_atomic` and `void_bill_payment_atomic` contain no `realized`/FX reference at all |

## 2. Critical findings (VERIFIED FACT unless marked)

**F1 — Reversal asymmetry is the live realized-FX hole.**
Eight functions resolve a realized-FX account (`record_multi_invoice_payment`,
`record_multi_bill_payment`, `apply_credit_to_invoice_atomic`,
`refund_customer_atomic`, `refund_from_vendor_atomic`, `expense_reimburse_direct`,
`fx_realized_gain_loss`, `resolve_fx_realized_account`). **Zero** reversal
functions do. So a foreign settlement books a realized gain/loss on the way in
and never backs it out on unapply/void.
ACCOUNTING CONSEQUENCE: reversing a foreign-currency receipt leaves a permanent
phantom gain/loss in P&L and re-opens the invoice at an amount that no longer
ties to the control account. Affected events: unapply payment, void payment,
void bill payment.

**F2 — `payments` carries no currency, rate or base-amount column.**
Confirmed: no column on `public.payments` matching currency/rate/base/fx.
Settlement rate is resolved at posting time and lives only on the journal.
INFERENCE (to prove in 9.1): a reversal therefore *cannot* re-derive the
settlement rate from the payment row; it must read it back from the original
journal entry lines (`journal_entry_lines.exchange_rate` /
`original_currency`, which do exist) or from a settlement record.

**F3 — Journal-line FX metadata exists** (`journal_entry_lines.original_currency`,
`exchange_rate`). Whether every posting path populates it is UNVERIFIED and is
the first thing Phase 9.1 must establish, because it is the only available
source for reversal symmetry.

## 3. Accounting invariants this wave enforces

1. A reversal must reverse the *original* postings at the *original* rates —
   including any realized gain/loss line — not re-derive amounts at today's rate.
2. Realized FX arises only on settlement of a monetary item; unapplying a
   settlement un-realizes it. Net P&L effect of settle-then-reverse = 0.
3. A missing rate is an absence, never 1:1 — reversals inherit this: they may
   never fall back to parity, and they must not need a new rate lookup at all.
4. Booking-rate relief of the control account stays at the booking rate; only
   the cash leg moves at the settlement rate.

## 4. Execution order (smallest safe sequence)

### Phase 9.0 — Re-prove the suites (no code change)
Execute the existing FX SQL suites inside rolled-back transactions and run
`fx-single-engine.test.ts`. Record actual pass/fail; the log's claims are not
evidence.

### Phase 9.1 — Establish the reversal source of truth
Prove whether `journal_entry_lines.original_currency` / `exchange_rate` are
populated by `record_multi_invoice_payment` and `record_multi_bill_payment`.
Outcome decides: reverse-from-journal (preferred, no schema change) versus
persisting the settlement rate. No implementation until this is answered.

### Phase 9.2 — Reversal symmetry for AR (`unapply_payment_atomic`,
`void_payment_atomic`)
Rewrite the reversal posting to mirror the original entry line-for-line,
including the realized-FX line, through the existing posting monopoly. No new
resolver, no second reversal engine.

### Phase 9.3 — Reversal symmetry for AP (`void_bill_payment_atomic`,
`unapply_vendor_credit_from_bill_atomic`)
Same treatment, verified independently — not assumed identical to AR.

### Phase 9.4 — Tests
Extend `fx_settlement_realized_test.sql`: book at rate A, settle at rate B,
reverse; assert realized-FX account nets to zero, control account returns to the
booking-rate balance, and the invoice/bill returns to its pre-settlement state.
Add a ratchet asserting every reversal path referencing a settlement journal
also references `resolve_fx_realized_account`.

### Phase 10 — Tenant-facing absence states (unchanged, after 9)
Surfaces now receiving NULL must render an explicit "no rate on file" state.

### Phase 11 — Isolation ratchet (last)
Business-scoping assertions on `fx_exposure_by_currency`,
`fx_exposure_open_items`, `fx_revaluation_readiness`, `describe_exchange_rate`.

## 5. Scope boundary
FX source → settlement → reversal → posting → FX engine → FX reporting. No new
rate table, no second resolver, no client-side conversion, no currency column
added to `payments` unless 9.1 proves the journal cannot answer, no unrelated
module work.

## 6. Execution status
Phases 1–8: verified complete. Phase 9 premise corrected (single-invoice
settlement already compliant; reversals are the real gap). Phase 9.0: not
started — active. Phases 9.1–11: pending.
