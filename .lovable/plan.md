# Collections & Receivables — Verification Verdict, then Waves 10–13

## Phase 1 verdict — previous engineer's claims re-checked

Verified directly against the codebase and the live database:

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Waves 0–8 (canonical aging, as-of dating, credit netting, statement delivery queue, FX policy) | CONFIRMED | views `finance_ar_customer_credit`, `finance_ar_net_position`, `finance_ar_net_position_by_currency`, table `customer_statement_send_jobs` all exist; `aging-single-source` 6/6, `credit-fx-policy` 3/3, `statement-delivery-durability` 4/4 pass |
| Wave 9 collector assignment | CONFIRMED | `collector_assignments` table exists; `collector-assignment.test.ts` 7/7 passes; `src/pages/sales/Collections.tsx` renders the Collector column, assign dialog and "My accounts" filter, and `useCollectorAssignments` is wired |
| Wave 10 dunning policy | NOT STARTED | no `dunning_levels` table, no `dunning_assignment` view, no next-action column |
| Waves 11–13 (PTP, disputes, work queue) | NOT STARTED | no `ar_promises_to_pay`, `ar_disputes`, `collections_work_queue` objects |

No regressions or superficial patches found in the completed waves. The
architecture holds: Collections reads GL-gated AR projections and never
re-derives balances. That stays untouched (KEEP).

North star unchanged: Collections is an operational layer over canonical AR
truth. Every new object below is an *operational overlay* keyed to a customer
— none of them stores or recomputes a balance.

## Wave 10 — Dunning policy (escalation levels)

- Table `dunning_levels` (org, business, name, sequence, min_days_overdue,
  action_type enum `reminder|statement|call|escalate|legal`, template_id
  nullable, active). RLS org-scoped, GRANTs for authenticated/service_role.
- Seed default ladder per business on first read (0–30 reminder, 31–60
  statement, 61–90 call, 90+ escalate).
- View `dunning_assignment`: `finance_ar_net_position` joined to the highest
  matching level by `max_days_overdue` → next-action label per customer.
- Collections UI: "Next action" column sourced from that view.
- Guard: next action derives from canonical AR days-overdue, not invoice status.

## Wave 11 — Promise to pay

- Table `ar_promises_to_pay` (contact, optional document, promised_amount,
  currency + base amount, expected_payment_date, status
  `open|kept|broken|cancelled`, notes, audit columns). Org/business scoped RLS.
- RPC `record_promise_to_pay` (server-resolved base amount, idempotency key)
  and `evaluate_promise_status` (marks `broken` past date with no matching
  settlement, `kept` when residual dropped by the promised amount).
- Service + hook; Collections row action "Record promise" plus a PTP badge.

## Wave 12 — Dispute flagging

- Table `ar_disputes` (contact, optional document, dispute_type, reason,
  amount_disputed + base amount, status `open|resolved|rejected`, raised/resolved
  audit). Org/business scoped RLS.
- RPC `resolve_ar_dispute`. Disputed exposure is reported separately and is
  suppressed from dunning escalation, never subtracted from AR.
- Service + hook; Collections "Flag dispute" action + dispute badge, and a
  "Disputed" KPI distinct from overdue.

## Wave 13 — Collections work queue

- View `collections_work_queue`: `finance_ar_net_position` + collector
  assignment + dunning assignment + latest promise + open disputes, one row per
  customer with a priority score (exposure × age, de-prioritising disputed and
  in-promise accounts).
- RPC `get_collections_work_queue(collector_user_id)`.
- Collections UI "Work queue" tab: prioritised action list.
- Guard test: the queue sources from canonical AR, not from `invoices.status`.

## Technical notes

- Every new table follows the project's migration contract: CREATE TABLE →
  GRANT → ENABLE RLS → POLICY, plus `updated_at` trigger.
- No client-side money arithmetic: base-currency conversion uses the existing
  `to_base_amount()` function server-side.
- Money/communication-adjacent RPCs take deterministic request keys (no
  `crypto.randomUUID()` on the client), per existing project rule.
- Verification per wave: targeted architecture test + `tsgo` typecheck + plan
  file update. The ~145 pre-existing unrelated architecture test failures in
  the repo are not regressions from this work.
