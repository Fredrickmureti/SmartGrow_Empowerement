# Vendor Credit Notes — CLOSED

Domain: Purchases / AP vendor credit notes.
Status: **Closed — 2026-08-12.** All phases delivered; no deferred items.

## Final state

### Phase 7a — atomic apply / unapply (verified, not re-audited)
`apply_vendor_credit_to_bill_atomic`, `unapply_vendor_credit_from_bill_atomic`
and `apply_vendor_credit_fifo_atomic` write `vendor_credit_movements` directly,
bump `row_version`, and are period-guarded (FIFO by delegation).

### Phase 7b — AP credit position (delivered)
- `public.finance_ap_vendor_credit` is the single canonical definition of
  unapplied vendor credit, projected from `vendor_credit_balances`, mirroring
  `finance_ar_customer_credit` (currency, base amount, 0.01 floor).
- `get_ar_ap_aging_from_ledger` (AP branch), `get_ap_summary` and
  `get_ap_aging_summary` net it as a never-aged negative residual in `current`.
- `src/services/finance/openItems.ts` no longer claims "AP has no
  credit-position analogue"; the supplier list and
  `fetchContactOpenItemAging("ap", …)` both consume the netted figure, so vendor
  statements, aged payables and the AP summary reconcile.

### Phase 7c — period close (delivered)
`src/test/architecture/vendor-credit-period-close.test.ts` pins
`is_period_open` in issue / apply / unapply / reverse / reversal-intent, pins
the raise-on-closed behaviour, pins FIFO delegation, and pins the ADR-0123
no-direct-journal-insert rule.

### Phase 7d — tie-out & provenance ratchets (delivered)
- `vendor_credit_tieout` is fed into `control_account_drift_log` by
  `snapshot_control_account_drift()` (nightly `pg_cron`, ADR-0032).
- `src/test/architecture/ap-credit-position-provenance.test.ts` fails CI if the
  view changes source, if any AP SQL surface stops netting it, if the removed
  client branch returns, if an AP position surface reads `vendor_credit_notes`
  for a credit balance, or if the tie-out drops out of the drift snapshot.

Decisions recorded in `docs/adr/0133-ap-credit-position-and-vendor-credit-ratchets.md`.

## Known out of scope (belongs to Expenses, not this domain)
`expense` is registered reversible but `resolve_reversal_intent_finance` has no
expense branch, so `reversal-intent-coverage.test.ts` fails on that row.
Pre-existing and unrelated to vendor credit notes.
