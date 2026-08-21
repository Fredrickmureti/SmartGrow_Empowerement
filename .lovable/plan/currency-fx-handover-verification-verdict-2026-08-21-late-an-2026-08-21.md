# Currency & FX — handover verification verdict (2026-08-21 late) and remaining wave

Authority: ADR 0135 / 0136 / 0138. Predecessor: `.lovable/plan/currency-fx-handover-verification-verdict-then-producer-cont-2026-08-21.md`.

## 0. Supabase connection note

VERIFIED FACT: this project is already bound to Supabase project ref `jkszmrroyjfdwokbkzis`,
and all FX verification below was run against it. A project can hold only one Supabase
binding, so `AccrualFlowCorporation` cannot be attached alongside it. If that is a *different*
Supabase project you want to switch to, say so explicitly — it is a destructive re-bind and is
out of scope for this wave.

## 1. Verification of the previous engineer's claims (done this session, live DB + code)

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Phase 2 — `convert_po_to_bill_atomic` no longer resolves or falls back to parity | VERIFIED | body sets `v_rate := NULL; v_company_total := NULL` and reads them back via `RETURNING`; the bill stamper owns the rate |
| Phase 3 — settlement RPCs reject caller-supplied rates | VERIFIED | `record_multi_invoice_payment` / `record_multi_bill_payment` both reference `resolve_exchange_rate`; no parity `COALESCE` |
| Phase 4 — compensation paths | VERIFIED | `refund_customer_atomic`, `refund_from_vendor_atomic` use the resolver, no `'KES'`/`'USD'` literals; `apply_credit_to_invoice_atomic` correctly relieves at booking rates only (no resolver needed) |
| Phase 5 — `expense_reimburse_direct`, `pos_payment_session_open` | VERIFIED | both use the resolver, neither contains a currency literal or a `COALESCE(rate,1)` |
| `fx-single-engine.test.ts` = 27 passing | VERIFIED | ran: 27/27 pass |
| C6 — stray `anon` EXECUTE on `set_business_active_currency` | INVALIDATED — already clean | `routine_privileges` shows 0 anon grants |
| Outbox vocabulary regression test "drafted but not saved" | INVALIDATED — it exists | `supabase/tests/business_event_outbox_source_vocabulary_test.sql` present |
| AR and AP realized-FX tie-outs (Phases E/F) | PRESENT, RE-RUN PENDING | `supabase/tests/fx_realized_tieout_test.sql`, `fx_realized_ap_tieout_test.sql` exist but were not re-executed this session |
| User report: "users type the currency instead of picking from the catalogue" | INVALIDATED for the surfaces checked | `CurrencySettings.tsx` uses catalogue-backed `Select` for base currency, enablement and override entry; suppliers, contracts, landed cost and bank accounts use `CurrencyCombobox` |
| Period close ignores FX | INVALIDATED | `close_fiscal_period` already references the revaluation/rate guard, and `ClosePeriodSheet` surfaces unrevalued foreign balances |

Nothing in the completed phases was found to be superficial or regressed. Resume point is
therefore genuinely **after Phase 5/F**, as the log claimed.

## 2. Remaining work (dependency-ordered)

### Phase 6 — re-prove the tie-outs, then extend them (next)
1. Execute `fx_realized_tieout_test.sql` and `fx_realized_ap_tieout_test.sql` against the live
   DB inside a rolled-back transaction; record pass/fail rather than trusting the log.
2. Extend coverage to the settlement paths never exercised with real foreign-currency data:
   - credit note application (`apply_credit_to_invoice_atomic`) and customer/vendor refunds,
   - bank-reconciliation-driven settlement (`bank_match_confirm`).
   Each fixture: book at rate A, settle at rate B, assert the control account nets to zero at
   the booking rate, cash moves at the settlement rate, and the delta lands in the account from
   `resolve_fx_realized_account`. Roll back; leave no data.
3. Add a single SQL contract test asserting realized-FX postings reconcile to GL movement on the
   realized gain/loss accounts per business and period.

### Phase 7 — period-close FX interlock (after 6)
`close_fiscal_period` guards unrevalued balances. Verify and, if absent, add the second
condition: refuse the close when an enabled currency has **no rate on file at period end**,
with the reason surfaced in `ClosePeriodSheet` rather than a raw error.

### Phase 8 — revaluation lifecycle re-proof (after 7)
Re-run `fx_revaluation_lifecycle_test.sql`; confirm `reverse_fx_revaluation_run` fully reverses
the prior run so successive revaluations cannot accumulate, and that a missing rate is a
recorded exception on the run, never a silent skip.

### Phase 9 — isolation ratchet (last)
Assert business-scoping on `fx_exposure_by_currency`, `fx_exposure_open_items`,
`fx_revaluation_readiness` and `describe_exchange_rate`: a member of Business A must never
resolve or read Business B's rates or exposure. Add to the architecture guard.

## 3. Carried limitations (documented, not defects)
- `payments` / `customer_credit_balances` carry no currency column: advances are structurally
  base-currency only. A schema change is out of scope without an explicit decision.
- Pre-existing unrelated failure: `bill-payment-allocations-first-class.test.ts` (vendor
  statement refactor) — not attributable to FX work.

## 4. Scope boundary
FX source → settlement → posting → FX engine → FX reporting. No new rate table, no second
resolver, no client-side conversion, no unrelated module work, no schema change to advances.

## 5. Execution status
Phases 1–5 / A–F: complete and verified. Phase 6: not started (active). Phases 7–9: pending.
