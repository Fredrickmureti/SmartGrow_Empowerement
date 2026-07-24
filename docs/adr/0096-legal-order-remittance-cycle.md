# ADR-0096 — Legal Order Remittance Cycle Closure

**Status:** Accepted — Phase 7 step 1 (2026-07-24)
**Supersedes:** none · **Extends:** ADR-0093 (recipient continuity), ADR-0094 (event outbox), ADR-0095 (jurisdiction packs)

## Context

Phase 5 shipped the outbox → `legal_order_remittance_lines` projection so
posted garnishment payments are visible to finance and ESS. What was
missing was the *planning* side: an operator could see accruals
(`garnishment_ledger`) and paid-out lines separately, but had no
first-class object to represent "these are the orders I intend to pay
to this recipient in one bank transfer this week".

Without that object we cannot:

- Produce a single bank file for a recipient covering N orders across M
  employees.
- Reconcile a single incoming bank debit against the payroll intent.
- Auto-close orders whose total remittances have caught up to
  `total_owed` in a way that is auditable end-to-end.

## Decision

Introduce two new writable tables and four RPCs. All status writes
continue to go through the existing FSM (`_legal_order_fsm_guard`);
this ADR adds a **planning aggregate**, not a new writer.

### Aggregate

```
legal_order_remittance_batches
  status ∈ { draft, generated, settled, cancelled }
  recipient-scoped, period-scoped, one bank file per batch

  ├── legal_order_remittance_batch_lines
  │     one per legal_orders_records.id, planned_amount / actual_amount
  │     back-links to legal_order_remittance_lines.id on settle
```

### RPCs

| RPC | Purpose | Guard |
|-----|---------|-------|
| `legal_order_build_remittance_batch(org, biz, recipient, from, to, notes)` | Materialise unpaid accruals per order into a draft | `user_has_organization_access` |
| `legal_order_generate_remittance_bank_file(batch_id, format)` | Deterministic body + sha256 checksum; supports `csv`, `ach_stub`, `sepa_pain001_stub` | org access + status ∈ {draft, generated} |
| `legal_order_settle_remittance_batch(batch_id, payment_date, reference, bank_txn_id)` | Project each planned line into `legal_order_remittance_lines` with a unique `source_event_id` (idempotent), stamp settled_*, invoke `legal_order_auto_satisfy` | org access + status = generated + bank file present |
| `legal_order_cancel_remittance_batch(batch_id, reason)` | Cancel a non-settled batch | org access |
| `legal_order_auto_satisfy(org?)` | Safety net: transition orders where `Σ remittance ≥ total_owed` to satisfied via `apply_system_garnishment_transition` | callable by service_role for nightly job |

### Resolution & idempotency contract

- **Batch number** — `LORB-{YYYY}-{seq6}` per organization, monotonic.
- **Bank file** — body is derived from a deterministic query, checksum
  is `sha256(body)`. Regenerating a batch that is still `generated`
  overwrites the checksum; once `settled` the checksum is immutable.
- **Settlement idempotency** — each planned line inserts one row in
  `legal_order_remittance_lines` with a fresh `source_event_id`, so the
  Phase 5 dispatcher will not double-fan notifications; the batch's
  `payment_id` is generated once and shared across all remittance lines
  for that batch (matches the existing "one payment → many orders"
  shape).

### What this ADR explicitly does **not** do

- Does not introduce a new event topic. Callers who need to react to
  batch settlement should subscribe to the existing
  `legal_order.payment_posted` outbox events emitted by the payment
  writer path.
- Does not embed jurisdiction rules. Format enumeration is
  pack-neutral; a locale's actual bank format is authored via ADR-0095
  seeded rows and consumed by later phases without code changes.
- Does not bypass the FSM. `legal_order_auto_satisfy` calls the
  existing `apply_system_garnishment_transition` publisher.

## Consequences

- The Batches tab in the Legal Orders workspace is now the operator
  home for "money about to leave the building".
- `legal_order_remittance_lines` remains the single financial source of
  truth for money that has left the building.
- Bank reconciliation (`bank_reconciliation_matches`) can join on
  `legal_order_remittance_batches.settled_bank_transaction_id` — this
  is the seam Phase 7 step 2 will formalise.
- Auto-close happens on the same transaction as settlement, so the
  audit trail (`garnishment_lifecycle_events`) records
  `auto_satisfied` in lock-step with the remittance line insert.
