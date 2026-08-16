# Landed Cost — Audit Verdict and Remaining Engineering

## What I verified first (live code + live database)

The Landed Cost domain in this ERP is **already reconstructed as a first-class domain**, not a page. Confirmed against the database and the working tree, not against prior notes:

- One voucher engine: `landed_cost_allocate_voucher`, `landed_cost_post_voucher` (gate) → `_landed_cost_post_apply` (private applier, `service_role` only), `landed_cost_reverse_voucher`. One overload each.
- Canonical engines are consumed, not duplicated: FX stamped server-side by `_landed_cost_voucher_fx_stamp` (refuses, never falls back to 1); valuation via `inventory_apply_cost_revaluation`; accounting via `post_journal_entry_atomic`; accounts via `resolve_posting_account`; governance via the registry (`landed_cost.post`, `landed_cost.reverse`) plus `_mirror_approval_to_landed_cost` and `guard_landed_cost_self_approval`; events via `_emit_landed_cost_outbox`.
- Reporting reads canonical data: `landed_cost_clearing_exposure`, `landed_cost_receipt_summary`, `landed_cost_valuation_attribution`, consumed by the inventory valuation report, journal-entry drill-through, PO receipts section and bill match.
- Guards exist: `landed-cost.test.ts`, `landed-cost-currency.test.ts`, `stock-event-fabric-and-landed-cost.test.ts`, and four SQL probe files.

So the correct engagement here is **not** another reconstruction. It is closing the four gaps that remain, in dependency order.

## Verified remaining gaps

1. **The domain has never been exercised.** The database holds 1 voucher, in `draft`, 0 components, 0 allocations, 0 posted, 0 reversed. Every claim about posting, revaluation, journal balance, approval routing and reversal rests on introspection and read-only probes — never on an actual executed lifecycle.
2. **Weight / volume allocation bases are fully supported — this earlier finding was WRONG (corrected 2026-08-16).** It read only the legacy POS columns on `products`. The canonical model is `product_physical_attributes` (net/tare/derived gross weight, volume, L/W/H, each with its own UoM, per product and per packaging level), normalised by `resolve_product_measure`, captured by the "Physical attributes" section of `ProductForm`, and already consumed by `landed_cost_allocate_voucher` for both bases. The refusal seen in testing is data absence for those specific products, not a modelling gap.
3. **`landed_cost_selftest` / `landed_cost_selftest_run` still exist** in `public` — a second, non-canonical verification path that should be retired now that SQL probes cover its assertions.
4. **Edge-case behaviour is unproven** for: receipt reversal after capitalisation, supplier credit note / freight-bill reversal after posting, stock transferred or scrapped between receipt and posting, a voucher spanning receipts in two branches or warehouses, and concurrent re-post (row locking on the voucher).

## Plan

### Phase A — Execute the full lifecycle against live data (first, everything else depends on it)
Drive one real voucher end to end in a scratch business: create → attach charge components → select eligible receipts → allocate → route for approval → approve → post → reverse. After each step verify from source transactions, not from the UI response:
- allocation total equals the charge total to the last minor unit, deterministic on re-run;
- inventory unit cost moved by exactly the capitalised amount, and only for stock still on hand;
- the consumed portion landed in COGS;
- the journal balances and carries `source_type = 'landed_cost_voucher'`;
- the outbox event was emitted once;
- reversal unwound both valuation and ledger with a compensating entry, never a delete.
Record the evidence in `docs/audit/`. Any discrepancy found here becomes a fix in the canonical engine, not a landed-cost workaround.

### Phase B — Edge-case rules (the four unproven cases)
For each case, first determine whether the engine already refuses or handles it; only genuine gaps become work.
- Receipt reversal / goods-receipt cancellation while a posted voucher references it → must refuse, or require landed-cost reversal first.
- Freight bill reversal or supplier credit note after posting → define whether it forces a voucher reversal or a correcting voucher, and enforce it in the AP path.
- Transfers and scrap between receipt and posting → confirm the revaluation split follows remaining quantity at posting time.
- Cross-branch / cross-warehouse voucher → confirm scope validation and per-branch journal attribution.
- Concurrent post → confirm `FOR UPDATE` on the voucher row and idempotency by `(source_type, source_id)`.

### Phase C — Retire the parallel verification path
Move any assertion `landed_cost_selftest` still uniquely covers into `supabase/tests/landed_cost_*`, then drop both functions. Add a probe asserting they stay dropped.

### Phase D — Weight / volume basis (product-domain dependency)
Nothing to build. The product/packaging model, the UoM normalisation and the allocation paths all exist and are wired. Capture physical attributes on the products in scope and weight/volume allocation runs; the per-product refusal message names exactly which products are missing a measure. No local conversion formulas, no fabricated dimensions.

### Phase E — Operator comprehension pass on the workspace
Only after A–D. The workspace should answer, without database vocabulary: what needs allocating, what awaits approval, what is ready to post, how much value is being added, and what happened after posting. Read-only, from the existing server-side reporting RPCs.

## Technical notes

- No new engines. FX, UoM, approvals, valuation, accounting, events, documents, audit and RLS all stay canonical; Landed Cost remains a consumer.
- Every lifecycle transition stays a server-side RPC; the browser requests operations and renders state.
- Checks after each unit: `npm run typecheck:landed-costs`, the three landed-cost architecture tests, and the SQL probe files.
