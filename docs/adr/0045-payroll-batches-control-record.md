# ADR-0045 — Payroll Batches as the Control Record

- **Status:** Accepted (2026-06-29)
- **Related:** ADR-0022 (Payroll Mapping Integrity), ADR-0041 (Payroll Readiness Workspace).

## Context

The original `payroll_run_groups` table was a cosmetic folder: a name, a
period, a `status` that never advanced past `draft`, and a never-populated
`totals_json` snapshot. Downstream payroll systems — GL posting,
remittances, bank files, tax certificates, reverse-payroll, reports — all
operated per-run and never consulted `payroll_runs.group_id`. That left a
real enterprise gap: there was no period-level control record to lock,
approve, post, pay, close, reverse, or audit as a unit.

## Decision

`payroll_run_groups` is reshaped (in place, no rename) into the
authoritative **Payroll Batch** control record:

1. **Identity and scope.** Every batch is keyed to
   `(organization_id, business_id, pay_schedule_id, period_start,
   period_end, run_type)` and carries a deterministic, human-readable
   `batch_number` issued by `payroll_batch_create`. Idempotency is
   enforced by `idempotency_key` on a unique index so retries are safe.
2. **Lifecycle at the table tier.** A BEFORE trigger
   (`validate_payroll_batch_lifecycle`, ADR-0022 pattern) enforces the
   canonical transitions: `draft → computing → review → approved →
   posted → paid → closed`, plus `cancelled` (pre-post) and `reversed`
   (post-payment). Terminal states are immutable. Stamps
   (`approved_by/at`, `posted_by/at`, `paid_by/at`, `closed_at`) are
   required when entering the corresponding state.
3. **Lifecycle RPCs are the only writer.** `payroll_batch_create`,
   `payroll_batch_submit`, `payroll_batch_approve`,
   `payroll_batch_cancel`, `payroll_batch_mark_posted`,
   `payroll_batch_mark_paid`, and `payroll_batch_close` are the only
   sanctioned mutation paths. Each runs as `SECURITY INVOKER` and emits
   an idempotent `payroll_batch.*` event into `business_event_outbox`.
4. **Child-run readiness gates the batch.** Submit requires ≥1 child
   run; approve requires no child in `draft`/`computing`; mark-posted
   requires every child posted-or-paid; mark-paid requires every child
   paid AND a payment batch linked back via
   `payroll_payment_batches.source_batch_id`; cancel detaches children
   and refuses if any child is already posted.
5. **Reporting is view-driven.** `v_payroll_batches`,
   `v_payroll_batch_register`, and `v_payroll_period_consolidation`
   compute headcount and totals from `payroll_runs` on read. The old
   stored `totals_json` snapshot is dropped — it was always stale.
6. **Single-business batches; cross-entity consolidation is a view.**
   Each batch belongs to exactly one business. Cross-entity views
   (`v_payroll_period_consolidation`) aggregate all batches sharing
   `(organization_id, business_id, period_start, period_end)`. Posting
   and payment remain per-batch.

## Consequences

- The `run_type='group_child'` value is retired from
  `validate_payroll_run_type`. Batch membership is expressed solely by
  `payroll_runs.group_id IS NOT NULL`.
- Ad-hoc runs (no batch) continue to work; they are surfaced in the UI
  as "Ad-hoc" and bypass batch lifecycle gates.
- The Payroll Control Center UI exposes the lifecycle action bar
  directly; it has no fallback to the old "rename a group" workflow.
- Edge functions (`post-payroll-gl`, `post-payroll-payment-gl`,
  `reverse-payroll`) remain per-run and atomic. Batch-level
  orchestration is built by the UI and recorded by the RPCs after each
  per-run side-effect completes — there is no batch-level
  "post everything" RPC in this revision; that is intentional, so a
  single child failure does not poison the whole batch.

## Invariants

- A batch in `posted`, `paid`, `closed`, `cancelled`, or `reversed`
  cannot be mutated except by the matching lifecycle RPC.
- Every batch lifecycle transition writes exactly one outbox event,
  idempotent on `payroll_batch:<id>:<event>:<status>`.
- `payroll_payment_batches.source_batch_id` is the only path by which a
  batch reaches `paid`.

## Migration log

- Phase 1: schema, indexes, backfill, lifecycle trigger, `v_payroll_batches`.
- Phase 2: `create`, `submit`, `approve`, `cancel` RPCs + event helper.
- Phase 3: `mark_posted`, `mark_paid`, `close` RPCs; payment-batch linkage.
- Phase 4: `v_payroll_batch_register`, `v_payroll_period_consolidation`.
- Phase 5: Payroll Control Center UX with lifecycle action bar.
- Phase 6: Drop `totals_json`; retire `group_child` run_type.
