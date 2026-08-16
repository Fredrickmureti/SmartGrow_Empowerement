# Landed Cost Domain — Verification Verdict & Phase F Execution Plan

Last updated: 2026-08-16 (new owner). Supersedes earlier landed-cost files in `.lovable/plan/`.

## Phase 1 — Independent verification of the prior claims

Re-checked directly against the live database and the working tree.

| Prior claim | Verdict | Evidence |
| --- | --- | --- |
| One writer per operation, no duplicate engines | Confirmed | `pg_proc` shows exactly one overload each for `landed_cost_allocate_voucher`, `landed_cost_post_voucher`, `_landed_cost_post_apply`, `landed_cost_reverse_voucher`, `inventory_apply_cost_revaluation`, `inventory_reverse_cost_revaluation`, `inventory_sync_avco_from_layers`, `resolve_product_measure` |
| Phase C — parallel selftest path retired | Confirmed | no `landed_cost_selftest*` function exists in `public` |
| Phase B2 — bill/credit-note encumbrance guard | Confirmed | `landed_cost_bill_encumbrance`, `landed_cost_bill_block_reason`, `landed_cost_assert_bill_unencumbered`, `_landed_cost_guard_vendor_credit_note` all present, single-overload |
| Phase E — server-side workspace KPIs | Confirmed | `landed_cost_workspace_summary` exists and is the only KPI source in `landedCostRpcs.ts`; no `landedCostKpis` reducer remains; architecture guard in `src/test/architecture/landed-cost.test.ts` rejects client-side lifecycle counting |
| Phase D — weight/volume is a data gap, not a capability gap | Confirmed | `resolve_product_measure` resolves at the exact packaging level, falls back to base × pack size, normalises through the UoM engine and returns NULL only when the fact is absent; `product_physical_attributes` has **0 rows** |
| Phase A/B1/B3 lifecycle executed | Confirmed as far as data shows | 1 voucher, 1 component, 1 allocation, 1 revaluation, 1 GRN with 1 line; `stock_transfers` is empty, so the transfer/reversal case remains a rolled-back rehearsal only |

Verdict: the domain is genuinely reconstructed and canonically integrated. The active
gap is exactly what the prior owner named — weight/volume allocation has never been
executed, because no product carries physical attributes. One item is weaker than
claimed: the transfer split is rehearsal-only, since there is no transfer data.

## Phase 2 — Remaining work

### F (active) — prove weight / volume allocation end to end

1. Seed through canonical paths only, in the existing business: products with
   packaging levels, `product_physical_attributes` for base unit and at least one
   pack level (never hand-writing trigger-derived columns such as `gross_weight`),
   and a goods receipt with mixed pack levels across several lines.
2. Create a weight-basis voucher and a volume-basis voucher over that receipt and
   allocate. Assert: basis sum equals the sum of `resolve_product_measure` at the
   pack level actually received (gross preferred, net fallback); allocation total
   equals the charge total to the last minor unit; re-running is deterministic and
   clears prior allocations; a line whose product has no measure refuses by name.
3. Post and reverse one voucher. Assert the Phase A invariants: AVCO moved by exactly
   the capitalised amount, consumed portion in COGS, balanced journal with
   `source_type = 'landed_cost_voucher'`, one outbox event, zero valuation drift
   before and after, reversal by compensating entry (no journal deletion).
4. Check the operator-facing refusal message and the basis-picker hints against what
   the engine actually requires; correct the copy if they diverge.
5. Land `supabase/tests/landed_cost_weight_volume_test.sql` and the audit write-up
   `docs/audit/2026-08-16-landed-cost-weight-volume-execution.md`.

### F2 (added by this review) — close the transfer/reversal proof with real data

The warehouse-split reversal is currently only proven inside a rolled-back
rehearsal. With Phase F data in place, execute for real: receive → transfer part →
post → reverse, and assert both origin and destination layers return to their
pre-landed-cost unit cost, AVCO is re-derived per warehouse, and drift is zero in
both scopes. Any defect found is fixed in `inventory_reverse_cost_revaluation`, never
in landed cost.

### G — authenticated browser verification

Blocked in this environment (external, unmanaged Supabase; no session can be minted).
Verify public routes only and record the limitation; do not simulate a session.

## Rules carried forward

- No new engines. FX, UoM, approvals, valuation, accounting, events, documents and
  audit stay canonical; landed cost is a consumer.
- Any discrepancy is fixed at the canonical engine, never with a landed-cost-local
  workaround, fallback, or relaxed guard.
- Seeding is allowed via canonical RPCs and normal writes only.
- After each unit: `npm run typecheck:landed-costs`, the landed-cost architecture
  tests, and the `supabase/tests/landed_cost_*` probes; then update this file.
