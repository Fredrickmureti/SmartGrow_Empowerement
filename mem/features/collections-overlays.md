---
name: Collections operational overlays (dunning, promises, disputes, work queue)
description: Dunning, promises-to-pay, disputes and the collections work queue are server-derived overlays on finance_ar_net_position; never re-derive escalation, promise status, disputed exposure or queue ranking in the browser
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

## Disputes
`ar_disputes` flags a contested amount. A dispute **never reduces the
receivable** — no invoice update, no journal entry. Disputed exposure is
reported beside AR (its own KPI) and is never netted off `net_amount`.
- Writes go only through `raise_ar_dispute` / `resolve_ar_dispute`, with an
  idempotency key from the dispute intent (`disputeRequestKey`).
- An open dispute sets `dunning_assignment.on_hold` — escalation pauses while
  the balance is contested.
Client surface: `src/services/finance/disputes.ts` → `useArDisputes` →
"Dispute" column + `RaiseDisputeDialog` in Collections.

## Work queue
`collections_work_queue` (+ `get_collections_work_queue(_business_id,
_collector_user_id)`) is the prioritised action list. Exposure, aging, collector,
dunning level, open promise and open dispute are joined in SQL, and
`priority_score = net_amount * (1 + max_days_overdue/30) * factor`, where the
factor is 0.25 in dispute, 0.5 under an open promise, else 1. Overlays
**de-prioritise, never hide** rows. The client must not sort or re-score.
Client surface: `src/services/finance/collectionsWorkQueue.ts` →
`useCollectionsWorkQueue` → "Work queue" tab in Collections.

## Guards
`src/test/architecture/dunning-policy.test.ts`,
`src/test/architecture/promise-to-pay.test.ts`,
`src/test/architecture/collector-assignment.test.ts`,
`src/test/architecture/disputes-work-queue.test.ts`
