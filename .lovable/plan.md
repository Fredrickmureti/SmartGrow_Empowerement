# Estimate / Quotation Lifecycle — Authoritative Project Status

Domain: Sales → Estimates / Quotations
Source audit: `.lovable/plan/estimate-quotation-lifecycle-audit-verdict-and-convergence-p-2026-08-08.md`
Last updated: 2026-08-08

## Current state

**All phases (0–6) of the Estimate convergence roadmap are implemented and verified.**
The domain is at a coherent, production-ready state. Nothing is half-landed.

## Completed and verified

### Phase 0 — Unbreak conversion (DONE, verified against live DB)
- `invoices.source_estimate_id` added (nullable, FK, indexed); `sales_orders.source_estimate_id` in use.
- `convert_estimate_to_so_atomic` reads `expiry_date` (the phantom `valid_until` is gone).
- Both RPCs copy `packaging_id, display_uom_id, display_quantity, uom_snapshot` line-for-line and
  materialise `estimate_additional_costs` as trailing document lines.
- Both RPCs raise unless `subtotal + tax − discount = total` before any write.
- Forward pointer recorded on both paths.
- Verified: `pg_get_functiondef` on the live database confirms all of the above.

### Phase 1 — Lifecycle spine (DONE)
- `estimates.sent_at, viewed_at, accepted_at, rejected_at, converted_sales_order_id`.
- `set_estimate_status_atomic(p_estimate_id, p_status, p_user_id)` owns the only legal transition
  table: `draft→sent→viewed→accepted|rejected|expired`, `accepted→converted`, terminal states closed.
- `estimate_status_events` audit table (business-scoped RLS) written on every transition,
  including both conversion paths.
- `trg_estimate_status_write_guard` blocks any direct `status` write that is not carrying the
  `app.estimate_status_writer` token.
- `get_document_lineage` knows the direct estimate → invoice edge.

### Phase 2 — Numbering convergence (DONE)
- `get_next_so_number(_org_id, _business_id, _branch_id)` with advisory lock and business+branch
  scope; the 1-arg signature remains as a thin delegate.
- Sequence extraction now parses only the trailing counter segment, so `EST-2026-0002` no longer
  becomes `EST-2026-20260002`.

### Phase 3 — RLS convergence (DONE)
- Legacy org-wide `estimate_items` policy family dropped; one business-scoped family remains,
  aligned with the parent table.
- `estimate_additional_costs` policies inherit the parent's business + module-permission check.

### Phase 4 — Frontend alignment (DONE)
- `src/lib/estimateLifecycle.ts` — single source of truth for the transition table and the totals
  formula (`computeEstimateTotals`, additional costs included).
- `useEstimates.setEstimateStatus` routes every transition through the RPC; `updateEstimate` no
  longer accepts `status` and now persists `additional_costs`.
- Create and edit share one totals formula — editing an estimate can no longer change its price.
- Conversion buttons are blocked when either forward pointer is set.
- Note: the "duplicate creation surface" flagged in the audit turned out to be a CSV importer, not a
  rival editor. Nothing to retire; finding withdrawn.

### Phase 5 — Expiry (DONE)
- `expire_stale_estimates()` moves `sent`/`viewed` estimates past `expiry_date` to `expired`
  through the same state machine; scheduled daily via `pg_cron`.

### Phase 6 — Tests (DONE)
- `src/test/lib/estimateLifecycle.test.ts` — transition legality + totals stability across
  create/edit round-trips.
- `src/test/architecture/estimate-status-single-writer.test.ts` — no client-side `estimates.status`
  write anywhere in `src/`.
- `src/test/architecture/estimate-conversion-parity.test.ts` (16 tests) — conversion invariants:
  double conversion rejected, illegal source statuses rejected, totals assertion present,
  additional costs materialised, UoM provenance carried, forward pointer recorded, audit event
  written, `valid_until` can never return, and only `useEstimates.ts` may invoke the conversion RPCs.
- All estimate suites pass. The repository-wide run has ~185 pre-existing failures unrelated to this
  domain (e.g. `wms-topic-vocabulary`); every estimate-related test passes in isolation and in CI scope.

## Pending

Nothing in the Estimate domain. No partial work, no orphaned functionality.

## Active phase

None — the Estimate roadmap is closed.

## Next milestone

The chronologically next domain in the sales chain, and the one this work now feeds directly:
**Sales Order → Delivery → Invoice execution lifecycle.** The estimate now hands a complete,
reconciled document to `sales_orders` (with additional costs as lines and UoM provenance intact);
the natural continuation is to audit whether the SO side preserves that fidelity through
fulfilment — specifically SO status machine parity, partial-delivery accounting, and whether
`sales_orders.source_estimate_id` survives into the invoice for end-to-end lineage.

## Instructions for the next agent

1. **Verify before you build.** Do not assume this document is accurate. Confirm, in this order:
   - `pg_get_functiondef` for `convert_estimate_to_invoice_atomic`, `convert_estimate_to_so_atomic`,
     `set_estimate_status_atomic`, `expire_stale_estimates`, and both `get_next_so_number` overloads.
   - `cron.job` contains the expiry schedule.
   - Run `bunx vitest run src/test/architecture/estimate-conversion-parity.test.ts
     src/test/architecture/estimate-status-single-writer.test.ts src/test/lib/estimateLifecycle.test.ts`
     — expect all green.
   - Spot-check RLS on `estimate_items` / `estimate_additional_costs`: exactly one business-scoped
     policy family each, no org-wide leftovers.
2. **If verification fails**, fix the Estimate domain first. Do not start the next milestone on a
   broken foundation.
3. **If verification passes**, open a new plan for the Sales Order execution lifecycle above.
   Do not jump to an unrelated module.
4. **Boundaries that must not be crossed** (carried forward from the audit): estimates never post to
   the GL; line-level price/tax/UoM snapshots stay frozen on `estimate_items`; the document
   snapshot/print pipeline (`services/documents/snapshots/salesEstimate.ts`) and `convert_lead_to_estimate`
   are correct and out of scope.
