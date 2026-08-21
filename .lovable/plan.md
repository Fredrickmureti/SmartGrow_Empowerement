# Currency & FX — settlement convergence programme (authoritative status)

Last updated: 2026-08-21 14:07 UTC. Authority: ADR 0135 / 0136 / 0138.
Predecessor plan: `.lovable/plan/currency-fx-handover-verification-verdict-then-producer-cont-2026-08-21.md`
(findings C1–C6 and the phase numbering below come from it).

## Current position

**Active phase: Phase 6 (realized-FX vs GL tie-out) — not started.**
Phases 1–5 are complete and verified. Phase 7 is the only other outstanding item.

## The FX contract being enforced

1. Denomination lives on the business document and is frozen by the BEFORE stamper.
2. The booking rate comes from `fx_stamp_document` → `require_exchange_rate`. No caller supplies it.
3. The settlement rate comes from `resolve_exchange_rate` on the settlement date, server-side.
4. A monetary balance is relieved at its original booking rate; the delta against the
   settlement rate is realized FX via `resolve_fx_realized_account`.
5. A missing rate raises. No `COALESCE(rate, 1)`, no currency literal.
6. `post_journal_entry_atomic` is the only converter.

## Completed and verified

### Phase 1 — producer map (investigation) — DONE
Every settlement producer traced to its journal lines against `pg_proc`:

| Producer | Verdict |
| --- | --- |
| `bank_match_confirm` | Clean. Derives base currency, uses `require_exchange_rate`, rate 1 only when the transaction is in base. |
| `approve_sales_return_atomic` | Clean. COGS posts as base with `_currency := NULL`; the credit note it raises is stamped by the trigger. |
| `purchase_return_raise_credit` | Clean. Passes the purchase return's own document rate; the VCN stamper owns the booking rate. |
| `record_advance_payment`, `record_vendor_advance_payment`, `apply_vendor_advance_atomic` | No currency or rate columns exist on `payments`; advances are structurally base-currency only. C5 **dropped as a defect**, recorded as a limitation (see below). |
| `expense_reimburse_direct` | **Defect — promoted to Phase 5.** Fixed. |
| `pos_payment_session_open` | **Defect — promoted to Phase 5.** Fixed. |

### Phase 2 — C1, PO → Bill — DONE
`convert_po_to_bill_atomic` no longer reads `exchange_rates` or falls back to parity;
`trg_bills_stamp_currency` owns currency, rate and `company_currency_total`, and the
function reads the stamped values back via `RETURNING`.

### Phase 3 — C4, caller-supplied settlement rates — DONE
`record_multi_invoice_payment` and `record_multi_bill_payment` resolve the rate
server-side and raise `22023` if a caller passes `_exchange_rate`.

### Phase 4 — C2 / C3, realized FX on compensation — DONE
- `apply_credit_to_invoice_atomic`: enforces currency parity, relieves each leg at its own
  booking rate, posts the delta to the realized FX account.
- `refund_customer_atomic` / `refund_from_vendor_atomic`: `'KES'` literals removed in favour
  of the business base currency; realized FX recognised between the booking rate and the
  refund-date rate.

### Phase 5 — the last two producers — DONE (this wave)
- `expense_reimburse_direct`: the `COALESCE(r.exchange_rate, 1)` parity fallback is gone. The
  employee payable is relieved at the expense booking rate, cash moves at the server-resolved
  payment-date rate, and the delta posts as realized FX gain/loss. A foreign expense with no
  booking rate or no payment-date rate raises `23514`.
- `pos_payment_session_open`: both `'KES'` literals and `COALESCE(p_fx_rate, 1)` removed. The
  session currency defaults to the company base currency, the rate is resolved server-side,
  a caller-supplied `p_fx_rate` raises `22023`, and settling in a non-base currency is
  refused explicitly rather than guessed.
- Client: `p_fx_rate` / `fxRate` removed from `src/lib/pos/paymentSessionClient.ts` and
  `src/hooks/pos/usePaymentSession.ts`.

Verification performed this wave:
- Live `pg_proc` assertions: no parity regex match in `expense_reimburse_direct`, realized-FX
  account referenced, no `'KES'` in the POS opener, rate rejection and server resolution present.
- `supabase/tests/fx_settlement_realized_test.sql` extended with a Phase 5 contract block.
- `src/test/architecture/fx-single-engine.test.ts` → **27 passing** (2 new guards: no settlement
  RPC call site passes a rate; the POS client carries no `fxRate` input).
- `bunx tsgo --noEmit -p tsconfig.app.json` clean.

## Pending

- **Phase 6 (next) — realized-FX vs GL tie-out.** Prove that the sum of realized FX postings
  reconciles to the GL movement on the realized gain/loss accounts, per business and period.
  Needs a foreign settlement fixture (now creatable via any of the Phase 4/5 paths) and a
  report or SQL contract test asserting the tie-out.
- **Phase 7 — period-close interlock.** Closing a period must refuse when an enabled currency
  has no rate on file for the period end.
- **Carried limitations (documented, not defects):**
  - Advances (`payments`, `customer_credit_balances`) have no currency column and are base
    currency only. Foreign-currency advances would require a schema change — do not start it
    without an explicit decision.
  - C6 hygiene: `set_business_active_currency` still carries an `anon` EXECUTE grant. It fails
    closed on `auth.uid() IS NULL`, so it is cosmetic; drop the grant opportunistically.
- **Unrelated pre-existing failure (do not attribute to this programme):**
  `src/test/architecture/bill-payment-allocations-first-class.test.ts` → "reads the canonical
  vendor_ledger_entries view" fails because `useVendorStatements.ts` was refactored to read
  through `src/services/finance/vendorStatementLedger.ts`. Untouched by FX work.

## Instructions for the next agent

1. **Verify before continuing.** Do not take this file's claims on trust. Re-check against the
   live database and codebase:
   - `expense_reimburse_direct` and `pos_payment_session_open` bodies in `pg_proc` — confirm no
     `COALESCE(<rate>, 1)`, no currency literal, `resolve_exchange_rate` present, and the
     realized-FX branches balance (the FX line must be signed so the entry stays base-balanced).
   - Run `bunx vitest run src/test/architecture/fx-single-engine.test.ts` (expect 27 passing) and
     execute `supabase/tests/fx_settlement_realized_test.sql`.
   - Confirm no POS or expense UI still sends a rate.
2. **Then resume at Phase 6**, not elsewhere. Phase 6 → Phase 7 in that order.
3. **Scope boundary unchanged:** FX source → settlement → posting → FX engine → FX reporting.
   No new rate table, no second resolver, no client-side conversion, no unrelated module work.
