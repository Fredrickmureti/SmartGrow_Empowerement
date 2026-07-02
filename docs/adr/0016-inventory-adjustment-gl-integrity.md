# ADR 0016 — Inventory Adjustment ↔ GL Integrity

**Status:** Accepted (2026-05-21)
**Supersedes:** N/A
**Related:** ADR 0002 (AVCO on receipt), audit `docs/audit/2026-05-21-inventory-adjustment-gl.md`

## Context

The 2026-05-21 audit confirmed a class of data-integrity defects in
`stock_adjustments`:

1. The legacy client mutation passed no `unit_cost`, so
   `approve_stock_adjustment_atomic` silently skipped journal entry creation
   for any positive adjustment. Stock moved; GL did not. The inventory
   subledger and the trial balance drifted by the entire valuation of every
   such adjustment.
2. There was no idempotency guard, so a retried mutation could double-post
   stock and double-post the JE.
3. There was no reversal path. Operators were editing approved adjustments
   in place or creating opposing adjustments by hand, breaking the audit
   trail.
4. Approved headers were mutable — `reason`, `adjustment_date`, and even
   line totals could be edited after posting, which is unacceptable for any
   audited general ledger.

## Decision

The adjustment lifecycle is governed by **three non-negotiable invariants**,
each enforced server-side. The renderer is no longer trusted to keep the
ledger consistent.

### Invariant 1 — *Stock moves if and only if a JE posts*

`approve_stock_adjustment_atomic` resolves cost server-side via
`resolve_adjustment_unit_cost` (warehouse AVCO → org AVCO → last receipt →
product standard cost). If **no** cost is available, the RPC raises and the
entire adjustment is rolled back. The legacy "silently skip GL" path is
deleted.

### Invariant 2 — *Approved adjustments are immutable*

`prevent_approved_adjustment_mutation` is a `BEFORE UPDATE` trigger on
`stock_adjustments` that rejects any field change once
`status = 'approved'`, except for the three status transitions explicitly
allowed (`approved → reversed` via the reversal RPC, and the
`reversed_by_adjustment_id` linkage write).

### Invariant 3 — *Corrections happen through reversal, never edit*

`reverse_stock_adjustment(adjustment_id, reason)` creates a new
adjustment with negated quantities, approves it atomically (so it posts
its own contra JE), and links the two rows via
`reverses_adjustment_id` / `reversed_by_adjustment_id`. The UI exposes
this through `ReverseAdjustmentDialog`; no other path is supported.

## Operational guard rails

- **Idempotency.** `client_request_id` is enforced by a partial unique
  index per `organization_id`. The hook generates a UUID per create attempt
  and the mutation is therefore safe to retry across network failures.
- **Backfill.** Legacy approved rows without a JE are surfaced through
  `list_adjustments_missing_journals` and remediated one-by-one via
  `backfill_missing_adjustment_je`, which uses today's resolved cost (not
  the original adjustment date — historical cost is unrecoverable). The
  reconciliation card renders each row individually; there is intentionally
  no bulk button.
- **AVCO scope.** `warehouse_stock.average_cost` is the authoritative
  per-warehouse moving-average cost. Org-wide AVCO remains a fallback.

## Consequences

- The Inventory Adjustment dialog must collect `unit_cost` per line; the
  enum-keyed `reason` field (no free text) drives the contra account.
- Edge functions and scripts that previously wrote into `stock_adjustments`
  with `status = 'approved'` are broken by design — they must use
  `approve_stock_adjustment_atomic` or `reverse_stock_adjustment`.
- The reconciliation card is now the only sanctioned way to clean up
  pre-fix legacy rows.

## Test coverage

- `src/test/architecture/inventory-adjustment-cost-resolution.test.ts`
  pins the migration SQL and renderer surface.
- `supabase/tests/inventory-adjustment-gl.sql` (pgTAP) covers the RPC
  behaviour end-to-end: cost-missing raise, idempotency, reversal linkage,
  immutability trigger, and missing-JE backfill.
