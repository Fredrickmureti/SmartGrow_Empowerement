# Collections & Receivables Convergence — REOPENED

North star: Collections is a trusted **operational layer over canonical AR
truth**. Receivables, aging and exposure come from the GL-gated projections
(`finance_ar_open_items` / `finance_ap_open_items`) and their derived canonical
views — never from document status, never re-derived in app code.

## Completed and verified

| Wave | Scope | Evidence |
| --- | --- | --- |
| 0–5 | Audit + drift sensor, canonical buckets in Collections, one aging source with as-of dating, AR summary nets credit, statement idempotency, currency integrity | see archived audit under `.lovable/plan/` |
| 6 | Credit-netting consolidation: `finance_ar_customer_credit` + `finance_ar_net_position`; all consumers repointed | `aging-single-source.test.ts` (6/6) |
| 7 | Statement delivery reliability: canonical cohort, durable queue, delivery badges | `statement-delivery-durability.test.ts` (4/4) |
| 8 | Per-currency presentation & FX policy for credit: `to_base_amount()` function, `finance_ar_customer_credit` FX-converted, `finance_ar_net_position_by_currency` view, Collections per-currency breakdown | `credit-fx-policy.test.ts` (3/3) |
| 9 | Collector assignment: `collector_assignments` table + RLS, `upsert`/`deactivate` RPCs (single-active per contact), `fetch_collector_assignments_with_names`/`fetch_org_members` RPCs, service + hook, Collections UI collector column + assign dialog + "My accounts" filter | `collector-assignment.test.ts` (7/7) |

## Remaining roadmap (in order — no deferral)

### Wave 10 — Dunning policy (escalation levels) [ACTIVE]

1. Table `dunning_levels` (org, business, name, sequence, min_days_overdue,
   action_type enum, template_id nullable). RLS admin/manage.
2. Seed default levels (0–30, 31–60, 61–90, 90+).
3. View `dunning_assignment` — maps each customer's `max_days_overdue` to the
   highest matching dunning level → next-action label.
4. Collections UI: "Next action" column derived from the dunning assignment.

### Wave 11 — Promise-to-pay lifecycle

1. Table `ar_promises_to_pay` (org, business, branch, contact_id, document_id
   nullable, promised_amount, currency, base_promised_amount, expected_payment_date,
   status enum, notes, created/by/at). RLS org-scoped.
2. RPC `evaluate_promise_status` — marks promises broken when
   `expected_payment_date < today` and no matching payment landed.
3. Service + hook; Collections UI: "Record PTP" action + PTP badge.

### Wave 12 — AR dispute flagging

1. Table `ar_disputes` (org, business, branch, contact_id, document_id nullable,
   dispute_type, reason, status enum, amount_disputed, currency, base_amount_disputed,
   raised_by/at, resolved_by/at/notes). RLS org-scoped.
2. RPC `resolve_ar_dispute`. Disputed items excluded from dunning escalation.
3. Service + hook; Collections UI: "Flag dispute" action + dispute badge.

### Wave 13 — Collections work queue

1. View `collections_work_queue` — joins `finance_ar_net_position` +
   `collector_assignments` + `dunning_assignment` + latest PTP + open disputes.
   One row per (customer, next-action) with priority score.
2. RPC `get_collections_work_queue(collector_user_id)` — returns prioritized
   action items for a collector.
3. Collections UI: "Work Queue" tab — prioritized action list with action type,
   priority, assigned collector, dispute/PTP status.
4. Guard test: work queue sources from canonical AR, not invoice status.

## Verification protocol (for every wave)

1. Run the full architecture test suite for the affected area.
2. Typecheck (`tsgo`).
3. Update this plan file immediately after each wave.

## Instructions for the next agent

1. **Verify first:** confirm Wave 9's migration landed (`collector_assignments`
   table + 4 RPCs exist), `collector-assignment.test.ts` passes (7/7), and the
   Collections UI renders the Collector column + assign dialog + "My accounts"
   filter before starting Wave 10.
2. **Resume chronologically:** start from Wave 10 — Dunning policy. Create the
   `dunning_levels` table, seed default levels, build the `dunning_assignment`
   view, and add the "Next action" column to Collections.
3. **Do not skip:** each wave depends on the prior — collector assignment
   feeds the work queue, dunning policy drives the next-action label, etc.
4. **Update this file** after each wave is verified.

## Known repo-wide caveat

The full `src/test/architecture` suite has ~145 pre-existing failing files
unrelated to receivables. They predate this work; do not treat them as
regressions here.
