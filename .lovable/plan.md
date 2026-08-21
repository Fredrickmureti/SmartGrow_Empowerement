# Currency & FX — Phase 6 (realized-FX tie-outs)

## Verified this phase (run against live data, all writes rolled back)

- **AR receipt tie-out** — PASS. Foreign invoice booked at the rate on file, two
  partial receipts at a later rate: AR control nets to zero, cash equals the
  settlement-date value, realized FX = 5,500.
- **AP payment tie-out** — PASS. Same shape on the payables side: AP control
  nets to zero, bank matches the settlement-date value, realized FX loss = 5,500.
- **Credit note applied to an invoice** — PASS. AR is relieved at the invoice's
  booking rate, the credit liability at the credit note's, and the 1,200
  difference lands in realized FX.
- **Cash refund of a foreign credit note** — PASS after the fix below.

## Defect found and fixed

`refund_customer_atomic` and `refund_from_vendor_atomic` passed the
`bank_accounts.id` row identifier into the journal line's `account_id` instead of
the bank's general-ledger account. Every refund through these engines failed the
cross-company posting guard (or would have pointed at a non-existent account).
Both now resolve the bank's GL account and raise if it is not configured.

Guard: `supabase/tests/refund_bank_gl_account_test.sql`.
Fixtures: `supabase/tests/fx_compensation_tieout_test.sql`.

## Remaining

1. Extend tie-out coverage to bank-reconciliation-driven settlement
   (`bank_match_confirm`) — the one settlement route still unverified.
2. Data hygiene: at least one `bank_accounts` row in the live org points at a GL
   account with a NULL `business_id`; refunds from that account will be rejected
   by the cross-company guard. Needs an owner decision, not a code change.
3. Carry-over: approval-gated reversal for `vendor_credit_note` (non-FX).
