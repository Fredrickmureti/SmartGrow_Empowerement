# Vendor Credit Notes — Authoritative Project Status

Domain: Purchases / AP vendor credit notes.

## Current phase

**Phase 7 — 7a verified independently. 7b is the next task.**

## Independent verification of the previous engineer's claims (this session)

Checked against the live database and the codebase, not the notes:

- `apply_vendor_credit_to_bill_atomic(_org, _business, _vcn, _bill, _amount, _by, _notes, _branch)`
  exists, is `authenticated`-executable, no longer calls the nonexistent
  `vendor_credit_balance_apply`, inserts the `vendor_credit_movements` row directly, bumps
  `row_version`, and calls the period guard. **Claim confirmed.**
- `unapply_vendor_credit_from_bill_atomic(_application_id, _reason)` exists, `authenticated`
  execute, period-guarded, bumps `row_version`. **Claim confirmed.**
- `apply_vendor_credit_fifo_atomic` has no inline period guard but delegates to the single-bill
  writer, so it inherits it. **Acceptable, no defect.**
- Lifecycle writers all exist as named RPCs (`submit`, `approve`, `reject`, `cancel`, `dispute`,
  `resolve_dispute`, `issue`, `reverse`, `refund_from_vendor_atomic`), with
  `reverse_vendor_credit_note_atomic` and `resolve_reversal_intent_vendor_credit_note` both
  period-guarded. **Phase 6 claims confirmed.**
- `vendor_credit_tieout` view exists (subledger vs GL account).

### Defect confirmed for 7b

Unapplied vendor credit is invisible to every AP position surface:

- `src/services/finance/openItems.ts` states outright that "AP has no credit-position analogue";
  only AR nets credit (`fetchUnappliedCustomerCredit` → `finance_ar_customer_credit`).
- In the database there is a `finance_ar_customer_credit` view but **no AP counterpart**;
  `get_ar_ap_aging_from_ledger`, `get_ap_summary` and `get_ap_aging_summary` contain no reference
  to vendor credit at all.
- Consequence: a supplier holding open vendor credit is aged and reported at the gross payable.
  Aged payables, the AP summary tiles and payment proposals all overstate what is owed.

## Next milestone — Phase 7 remaining

### 7b — AP credit position in ageing and supplier balance

1. Add `finance_ap_vendor_credit` as the single canonical definition of unapplied vendor credit,
   sourced from `vendor_credit_balances` / `vendor_credit_movements` (never from
   `vendor_credit_notes.amount_applied`), mirroring the shape and filters of
   `finance_ar_customer_credit` (org/business/branch, contact, currency, base amount, 0.01 floor).
2. Net that credit inside the SQL that owns the accounting rule — `get_ar_ap_aging_from_ledger`
   (AP branch), `get_ap_summary` and `get_ap_aging_summary` — as a negative residual that is never
   aged (lands in `current`), exactly as AR does. No new bucket vocabulary.
3. Client: remove the "AP has no credit-position analogue" branch in
   `src/services/finance/openItems.ts` and let the AP path consume the netted figures; Aged
   Payables and the purchases dashboard show gross payable, credit and net payable.
4. Vendor statements already emit `vendor_credit_note` lines — reconcile their closing balance
   against the same view so statement, ageing and tie-out agree.

### 7c — period close interaction

Assert (and ratchet) that post, apply, unapply and reverse all refuse a closed fiscal period
through the canonical guard. The guard is present in every writer today; the missing piece is a
test that keeps it there.

### 7d — appended after this session's review

- **Tie-out ratchet.** `vendor_credit_tieout` exists but nothing fails when it drifts. Wire it into
  `snapshot_control_account_drift()` coverage and add an architecture test asserting the AP credit
  view, the subledger and the GL account are the only three sources compared.
- **Aged-payables provenance test.** A ratchet that fails if any AP ageing or supplier-balance
  surface derives credit from document columns instead of the new view.

## Instructions for the next agent

1. 7a is verified — do not re-audit it. Start at 7b.
2. Put the netting rule in SQL, not in the browser; the client may only display.
3. Reuse canonical engines (aging vocabulary in `src/services/finance/aging.ts`, the AR credit view
   as the shape template, the reversal engine, outbox, period guard). Do not add a second AP
   position calculator.

## Known out of scope

`expense` is registered reversible but `resolve_reversal_intent_finance` has no expense branch, so
`reversal-intent-coverage.test.ts` fails on that row. Pre-existing, belongs to Expenses.

Note: the full `src/test/architecture` suite exceeds a 10-minute run in this sandbox; run targeted
files rather than the whole directory.
