# ADR 0133 — AP Credit Position, Period-Close Ratchet & Vendor-Credit Tie-Out

Status: Accepted
Date: 2026-08-12
Extends: ADR-0132 (vendor compensation parity), ADR-0033 (single AR/AP open-items engine)

## Context

ADR-0132 made `vendor_credit_movements` the authority for vendor credit and gave
vendor credit its own GL account (`vendor_credit` system role). What it did not
do is make that credit visible to the AP *position* surfaces. Until this change:

- there was no AP counterpart to `finance_ar_customer_credit`;
- `get_ap_summary`, `get_ap_aging_summary` and the AP branch of
  `get_ar_ap_aging_from_ledger` contained no reference to vendor credit;
- `src/services/finance/openItems.ts` stated outright that "AP has no
  credit-position analogue".

Consequently a supplier holding open vendor credit was aged and reported at the
gross payable: aged payables, AP summary tiles and payment proposals all
overstated what was owed.

## Decision

1. **One canonical definition.** `public.finance_ap_vendor_credit` projects
   unapplied vendor credit from `vendor_credit_balances` (never from
   `vendor_credit_notes.total - amount_applied`), mirroring the shape, currency
   handling, base-amount conversion and `0.01` floor of
   `finance_ar_customer_credit`.
2. **Netting lives in SQL.** `get_ap_summary`, `get_ap_aging_summary` and
   `get_ar_ap_aging_from_ledger` net that view as a negative residual that is
   never aged — it lands in the `current` bucket, exactly as AR does. No new
   bucket vocabulary, no second AP position calculator.
3. **The client only displays.** `openItems.ts` reads the same view for the
   supplier-level netting and for `fetchContactOpenItemAging("ap", …)`, so
   aged payables, the purchases dashboard and vendor statements agree with the
   AP summary by construction.
4. **Period close is ratcheted.** Every vendor-credit writer that moves the
   ledger — issue, apply, unapply, reverse, reversal-intent resolution — calls
   `public.is_period_open` and raises on a closed period.
   `apply_vendor_credit_fifo_atomic` inherits the guard by delegating to the
   single-bill writer.
5. **Tie-out is monitored, not merely available.** `vendor_credit_tieout`
   compares the vendor-credit subledger against the `vendor_credit` GL account
   and is written into `control_account_drift_log` by
   `snapshot_control_account_drift()` on the nightly `pg_cron` job (ADR-0032).

## Ratchets

- `src/test/architecture/vendor-credit-period-close.test.ts` — pins the period
  guard, the raise-on-closed behaviour, FIFO delegation, and the ADR-0123
  no-direct-journal-insert rule for every vendor-credit writer.
- `src/test/architecture/ap-credit-position-provenance.test.ts` — pins the view
  definition and its source table, requires the three AP SQL surfaces to read
  the view, forbids the "no credit-position analogue" branch from returning,
  forbids any AP position surface from querying `vendor_credit_notes` for a
  credit balance, and asserts the tie-out is fed into the drift log.

## Consequences

- AP and AR are now symmetric: gross payable, credit and net payable come from
  one projection on both sides of the ledger.
- Any future AP surface that wants a credit figure must read
  `finance_ap_vendor_credit`; inventing a second filter fails CI.
- Vendor-credit drift, if it ever appears, is timestamped in
  `control_account_drift_log` rather than discovered at audit.
