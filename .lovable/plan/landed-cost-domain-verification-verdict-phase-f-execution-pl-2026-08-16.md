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

### F (complete) — weight / volume allocation proven end to end

Seeded physical attributes and a mixed-packaging receipt through canonical paths;
allocated a weight-basis and a volume-basis voucher, both summing exactly to their
component; refusal by product name proven with zero allocation rows.
**Posted both vouchers** (LCV-2026-00002, LCV-2026-00003) as the owner via a
migration-scoped JWT claim — governance auto-allowed under `solo` mode, audited.
Balanced journals Dr Inventory / Cr Landed Cost Clearing, one outbox event each,
layer unit costs raised by exactly the allocated amounts.

Defects found and fixed at the canonical engines:
- `convert_uom` raised on a NULL quantity, blocking any net weight without a tare.
- `update_weighted_avg_cost_on_receipt` was a second costing authority and read
  `products.stock_quantity` before the stock trigger applied the receipt, so AVCO
  was overwritten with the last purchase price on every receipt into existing
  stock. It now delegates to `inventory_sync_avco_from_layers`; all AVCO re-derived;
  drift back to zero.

Ratchets: `supabase/tests/landed_cost_weight_volume_test.sql`,
`supabase/tests/inventory_avco_single_writer_test.sql`. Write-ups:
`docs/audit/2026-08-16-landed-cost-physical-basis.md`,
`docs/audit/2026-08-16-landed-cost-posting-and-avco-writer.md`.


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
