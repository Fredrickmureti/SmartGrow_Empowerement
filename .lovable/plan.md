# Inventory Foundation — Verification & Next Steps

## Phase 1 — Verification of prior engineer's claims

Spot-checked every "completed" claim in `.lovable/plan.md` against the filesystem and migration history:

| Claim | Verified |
|---|---|
| ADRs 0073 (recall), 0074 (import split), 0075 (drift log) present | ✅ |
| Six split import configs under `src/lib/importConfigs/product/` | ✅ 6 files present |
| Guards `product-variants.test.ts`, `recall-rpc.test.ts`, `product-imports-are-split.test.ts` | ✅ all present |
| `stock_quant_drift_runs` table + GRANTs + RLS + `record_stock_quant_drift_run` RPC | ✅ in `20260717010251_*.sql` |
| Variant-aware read paths (`useProducts`, `useProductsPaginated`, `useBranchScopedProducts`, `Products.tsx` opt-in) | ✅ |
| POS GS1 wiring + GRN AI-17/AI-11 persistence | ✅ |
| Recall RPC + `LotDetail.tsx` action | ✅ |

The handoff log is truthful. No claimed-complete item is missing or superficial.

## Phase 2 — Explicit deferred backlog (unchanged, still owed)

In dependency order — each item unblocks the next:

1. **Nightly `stock-quant-drift` edge function + pg_cron schedule** (starts the 14-day evidence window). No such function exists yet under `supabase/functions/`.
2. **`warehouse_stock` → `stock_quants` reader migration** — rewrite `src/lib/inventory/readOnHand.ts` first, then route ~139 refs across 39 files through it. Extend the architecture-guard allowlist.
3. **ADR 0076 + drop `warehouse_stock` / `warehouse_stock_lots`** — preflight snapshot into `stock_adjustment_backfill_log`; gated on ≥14 zero-drift runs.
4. **Server-side variant-parent filter in `list_products_with_branch_stock` RPC** — remove the client-side parent-id fetch in `useBranchScopedProducts`.
5. **Recall outbox event `product.recall.opened` + notification worker** using the returned manifest.
6. **Per-artefact batch handlers for the 5 non-master split importers** (barcode, batch, warehouse-stock, price, supplier) with idempotency keys + outbox events per ADR 0074.

Nothing to append from an independent review — the enterprise gaps flagged in the parent prompt (traceability, GS1, variants, ASN, serials, quants, import split, recall) are already in-plan or shipped. The one deferred design question worth flagging: item 6's warehouse-stock batch handler must write to `stock_quants` (never legacy `warehouse_stock`) so it doesn't create new debt for item 2.

## Phase 3 — This session's execution: Step 1 (drift job)

Standalone, low-risk, unblocks the retirement clock.

### 3.1 Edge function `supabase/functions/stock-quant-drift/index.ts`
- POST body: `{ organization_id: string }` (zod-validated), plus `verify_jwt = false` in `supabase/config.toml` since pg_cron calls it with the anon key.
- CORS headers; JWT-in-code guard: require `Authorization: Bearer <SUPABASE_ANON_KEY>` header match to reject anonymous callers off-schedule.
- Uses the service-role client to:
  1. Insert a `stock_quant_drift_runs` row with `status='running'`.
  2. Paginate products for the org (500/page); per page aggregate `stock_quants.quantity` vs `warehouse_stock.quantity` grouped by `(business_id, product_id, warehouse_id)`.
  3. Accumulate: `products_checked`, `drifted_rows`, `total_drift_qty`, top-10 offenders sample (JSON).
  4. On success call `record_stock_quant_drift_run(...)` with `status='completed'`; on throw, mark `failed` with `error_message`.
- Returns JSON summary for cron observability.

### 3.2 Cron schedule via `supabase--insert` (NOT migration)
- `cron.schedule('nightly-stock-quant-drift', '15 2 * * *', $$ select net.http_post(...) $$)` — one row per active org, or a single dispatcher row that fans out inside SQL. Prefer the single-row dispatcher (SELECT loop over organizations) to keep the schedule table small.
- Embeds function URL + anon key — this is exactly why the rule says use `supabase--insert`, not `supabase--migration`.

### 3.3 Verification
- Manually invoke the function once from the dashboard for one org; assert a `stock_quant_drift_runs` row is written with `status='completed'`.
- Nothing else changes this session — no reader migration, no table drops.

## Guardrails carried forward
- No new `warehouse_stock` readers.
- Every new public-schema table needs `GRANT`s in the same migration.
- Guards land with the code they protect.
- 62 pre-existing architecture-test failures are out of scope for this thread.
- Legacy `productImportConfig.ts` is a compat shim only.

## Out of scope for this session
- Reader migration to `stock_quants` (item 2) — waits on drift evidence.
- Dropping `warehouse_stock` (item 3) — waits on item 2.
- Items 4–6 — sequenced after retirement lands.
