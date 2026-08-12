# Currency & FX — status log (verified)

## Done and verified
- Steps A–F: AP stampers converged on `fx_stamp_document`, no parity fallback, strict
  `require_exchange_rate`, one resolver precedence, FX admin surface, revaluation engine
  and readiness, single client lookup with guards.
- **Step G — FX exposure reporting.** `fx_exposure_by_currency` /
  `fx_exposure_open_items` (SECURITY DEFINER, business-gated), `useFxExposure`, and the
  FX Exposure report at `/finance/reports/fx-exposure` with per-currency drill-down,
  export, and an explicit "No rate on file" state. Guard extended in
  `fx-single-engine.test.ts`.
- **Step H — Reversal governance for vendor credit notes.** Audit result: no work was
  needed. `reverse_vendor_credit_note_atomic` already calls `assert_can_reverse` (which
  evaluates `reversal_approval_requirement`) and `assert_reversal_reason`, and the dialog
  already uses the shared `useReversalApproval` / `ReversalApprovalNotice`. Ratcheted with
  a new guard block in `reversal-intent-policy.test.ts` so it cannot drift into a bespoke gate.
- **Step I — Close the loop.** ADR 0138 written; `mem://features/currency-and-fx-resolution`
  updated.

## Open / not defects
`business_active_currencies` is still empty and `exchange_rates` holds provider rows with
no tenant overrides — the Step D/F paths are implemented but not yet exercised with real
tenant data. The gates default open on the base currency.
