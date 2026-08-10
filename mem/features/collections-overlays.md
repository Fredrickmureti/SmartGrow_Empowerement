---
name: Collections operational overlays (dunning & promises)
description: Dunning levels and promises-to-pay are server-derived overlays on finance_ar_net_position; never re-derive escalation or promise status in the browser
type: feature
---

## Dunning (escalation ladder)
`dunning_levels` holds the org-scoped ladder (`sequence`, `min_days_overdue`,
`action_type`). The **next action** per customer comes only from the
`dunning_assignment` view, which joins `finance_ar_net_position` to that ladder
on `max_days_overdue >= min_days_overdue`. Never compute an escalation level in
the browser, and never read `invoices.status` for it.
Client surface: `src/services/finance/dunning.ts` → `useDunningAssignments` →
"Next action" column in `src/pages/sales/Collections.tsx`.

## Promise to pay
`ar_promises_to_pay` records a commitment (amount, currency, base amount,
expected date, `baseline_residual`). It never posts money and never touches an
invoice.
- Writes go only through `record_promise_to_pay` — it resolves the org, converts
  with `to_base_amount(_business_id, _currency, _amount, _as_of)` (that argument
  order), captures the baseline net position, and de-duplicates on a request key
  derived from the promise intent (`promiseRequestKey`), never a random UUID.
- `kept` / `broken` are decided by `evaluate_promise_status` comparing the
  current `finance_ar_net_position` against `baseline_residual - base_promised_amount`.
  The client only triggers evaluation and re-reads.
Client surface: `src/services/finance/promises.ts` → `usePromisesToPay` →
"Promise" column + `PromiseToPayDialog` in Collections.

## Guards
`src/test/architecture/dunning-policy.test.ts`,
`src/test/architecture/promise-to-pay.test.ts`,
`src/test/architecture/collector-assignment.test.ts`
