# Currency & FX — Phase 6 (realized-FX tie-outs)

**Active phase:** Phase 6 — realized-FX settlement tie-outs. All five settlement
routes are now verified. Phase 6 is complete apart from the data-hygiene item
below, which needs an owner decision rather than code.

## Fully implemented and verified

Every tie-out below was run against live data through a self-aborting fixture
(all writes rolled back) and reported the expected figures.

- **AR receipt** — PASS. Foreign invoice booked at the rate on file, two partial
  receipts at a later rate: AR control nets to zero, cash equals the
  settlement-date value, realized FX = 5,500.
  Fixture: `supabase/tests/fx_realized_tieout_test.sql`.
- **AP payment** — PASS. Same shape on the payables side: AP control nets to
  zero, bank matches the settlement-date value, realized FX loss = 5,500.
  Fixture: `supabase/tests/fx_realized_ap_tieout_test.sql`.
- **Credit note applied to an invoice** — PASS. AR relieved at the invoice's
  booking rate, the credit liability at the credit note's, difference to
  realized FX. Fixture: `supabase/tests/fx_compensation_tieout_test.sql`.
- **Cash refund of a foreign credit note** — PASS after the refund fix below.
  Same fixture.
- **Bank-reconciliation settlement (`bank_match_confirm`)** — PASS after the
  bank-match fixes below, for both a statement line that names its currency and
  one that does not: rate 135 (statement date), AR relieved at 129,500 (booking
  rate), bank 135,000, realized FX gain 5,500.
  Fixture: `supabase/tests/fx_bank_match_tieout_test.sql`.
  Structural guard: `supabase/tests/bank_match_fx_contract_test.sql`.

### Defects found and fixed in this phase

1. **Refund engines posted the wrong account.** `refund_customer_atomic` and
   `refund_from_vendor_atomic` put the `bank_accounts.id` row identifier into
   the journal line's `account_id` instead of the bank's general-ledger account,
   so every refund failed the cross-company posting guard. Both now resolve the
   bank's GL account and raise if it is not configured.
   Guard: `supabase/tests/refund_bank_gl_account_test.sql`.
2. **Bank match confirmation was broken outright.** `bank_match_confirm` passed
   a caller-computed `_exchange_rate` into `record_multi_invoice_payment` and
   `record_multi_bill_payment`; those engines resolve their own rate and reject
   a supplied one (ADR 0136), so *every* invoice or bill match confirmation
   raised. The argument is gone; the engines resolve centrally.
3. **Parity fallback on unlabelled bank lines.** A statement line without
   `original_currency` was treated as base currency, valuing a foreign bank
   account's line at parity. The bank account's own currency is now the
   fallback, ahead of base.

## Pending

1. **Data hygiene (owner decision, not code):** at least one `bank_accounts` row
   in the live org points at a GL account with a NULL `business_id`. Refunds and
   bank matches from that account are rejected by the cross-company guard.
2. **Carry-over from an earlier phase:** approval-gated reversal for
   `vendor_credit_note` (non-FX).
3. **Phase 7 (next):** unrealized FX — period-end revaluation and its
   interaction with period close. `fx_revaluation_lifecycle_test.sql` exists;
   it has not been re-run as part of this programme.

## Instructions for the next agent

1. **Verify before continuing.** Do not take this file's claims on trust:
   - Re-run the five fixtures listed above through the migration tool (each one
     self-aborts, so nothing persists) and confirm every leg reports PASS.
   - Re-run the structural guards `bank_match_fx_contract_test.sql` and
     `refund_bank_gl_account_test.sql`, and the TypeScript architecture guards
     in `src/test/architecture/fx-single-engine.test.ts` (27 guards).
   - Confirm no settlement path passes a caller-supplied `_exchange_rate` and no
     path falls back to parity.
2. **Then resume at Phase 7 — unrealized FX**, in this order: period-end
   revaluation correctness, reversal of the prior period's revaluation, and the
   close-period guard that blocks closing with unrevalued foreign balances.
   Do not open unrelated areas; finish Phase 7 to a production-ready state
   before moving on.
