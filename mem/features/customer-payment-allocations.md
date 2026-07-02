---
name: Allocation-first customer payments
description: ADR 0027 — payment_allocations is canonical link; useCustomerLedger/customer_ledger_entries view is the SoT for customer balance
type: feature
---

## Rule
Customer payments are **allocation-first** (ADR 0027). The only
sanctioned reads are:

- `usePaymentAllocations(paymentId)` for "what invoices did this
  payment settle?" — never `payments.invoice_id` from a fetched row.
- `useCustomerLedger({contactId, businessId, branchId, dateFrom,
  dateTo})` (backed by the `customer_ledger_entries` view) for
  customer balance, statements, and aging — never sum invoices /
  payments / credit_notes by hand.

## DB invariants (enforced at the trigger level)
- `trg_payment_alloc_sum_invariant` (DEFERRABLE) — sum of allocations
  equals `payments.applied_amount` (±0.005) at commit time. Voided /
  unreconciled / cancelled payments are excluded.
- `trg_payment_alloc_consistency` — every allocation's invoice must
  share `contact_id` + `business_id` + `organization_id` with the
  parent payment.
- `trg_payment_period_open` (BEFORE INSERT on `payments`) — rejects
  payments whose `payment_date` falls in a closed fiscal period.
- `trg_cascade_branch_payment_allocations` is DROPPED — allocation
  branch is inherited from the payment header, not the invoice.

## Provenance
`payment_allocations.source ∈ {rpc, backfill, reallocation}` and
`payment_allocations.created_by` carry origin/actor for audit.

## Architecture guard
`src/test/architecture/payment-allocations-first-class.test.ts`
bans new UI reads of `payments.invoice_id`. The current allowlist is
ratcheted — adding entries requires reviewer sign-off; the goal is
to drive it to zero before the column is DROPPED (one release after
ADR 0027 acceptance).

## Pending (Batch 2)
- `reallocate_payment_atomic` RPC + `ReallocatePaymentDialog`.
- `/sales/customers/:id/ledger` page consuming `useCustomerLedger`.
- POS payment RPC alignment with the allocation contract.
- Receipt template for multi-invoice payments
  (`generate-document` `customer_payment`).
