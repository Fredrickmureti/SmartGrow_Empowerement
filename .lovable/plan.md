# POS Wave — Transaction Engine & Canonical Domain Consumer Audit

Authoritative engineering record. Future agents: read the phase table, continue
at the first phase that is not ✅. Do not repeat completed investigation.

## Phase status

| # | Phase | Verdict | State |
|---|---|---|---|
| 0 | POS topology & critical path | — | in progress (draft below) |
| 1 | Product consumption / read seam | ❌ (see F1) | active — next to implement |
| 2 | UoM & packaging contract | ⚠ (see F2) | queued |
| 3 | Inventory availability | — | not started |
| 4 | Reservation / stock consumption | — | not started |
| 5 | Transaction state machine | — | not started |
| 6 | Server-side money authority | — | not started |
| 7 | Payment integrity | — | not started |
| 8 | Concurrency & idempotency | — | not started |
| 9 | Offline / retry | — | not started |
| 10 | Returns / void / reversal | — | not started |
| 11 | Receipt / printing boundary | — | not started |
| 12 | Event architecture | — | not started |
| 13 | Finance boundary | — | not started |
| 14 | Audit trail | — | not started |
| 15 | Reporting boundary | — | not started |

## Phase 0 — topology (evidence-based draft, to be completed in-wave)

- Shell/routes: `src/apps/pos/*`; terminal surfaces `src/apps/pos/terminal/{sale,return,held,history,receipt}`.
- Product read (grid/search): `usePOSProducts` → RPC `list_products_with_branch_stock` (stock map) **plus a direct `products` table select** (fields).
- Product read (scan): `useResolveBarcode` → RPC `pos_resolve_scan(business, branch, code)` → canonical `resolve_product_identity` (identity + price/tax/packaging).
- Cart: `usePOSCart` lines carry `packaging_id / display_uom_id / base_uom_id / packaging_label`.
- Commit: `usePOSTransactionOffline` → payment-session saga `openSession → recordTender → commitSession` → `process_pos_transaction`, deterministic idempotency key from `useCommitKey(register, shift)`.
- Table orders: single 4-arg `finalize_table_order` overload (ADR 0009).
- Receipts: snapshot `pos_receipt_snapshots` + `generate-document` (ADR 0086); hardware via main-process orchestrator (ADR 0014).

Open items for Phase 0 completion: reservation touchpoints, void/return RPC map, event publication points, offline queue replay path.

## Findings

### F1 — POS product grid does not use a canonical read seam ❌ (Phase 1)
- Evidence: `src/hooks/pos/usePOSProducts.ts` calls `list_products_with_branch_stock` **only for a stock map**, then issues its own `supabase.from("products").select("*")` for names/prices/tax and re-maps `unit_price → selling_price`. `usePOSProductCache.ts` repeats the same mapping for the offline cache.
- Additional live defect: `public.list_products_with_branch_stock` currently has **two overloads** in the database — `(uuid,uuid,uuid,boolean)` and `(uuid,uuid,uuid,boolean,uuid)` (the newer warehouse-scoped one). POS calls it with the 4 legacy named args, which is the classic PostgREST overload-ambiguity failure (`PGRST203`) and matches the "POS stopped loading products" symptom. `useBranchScopedProducts` passes all 5 and is unaffected.
- Why it matters: two competing product representations in POS; the grid path never sees `packaging`, `base_uom/sales_uom` (the RPC returns them), so grid-added lines and scan-added lines are not the same product contract.
- Canonical owner: Product domain — `list_products_with_branch_stock` (list/stock) and `resolve_product_identity` / `pos_resolve_scan` (identity).
- Required action: (a) confirm the runtime error is `PGRST203`, then drop the stale 4-arg overload so exactly one signature exists; (b) rewrite `usePOSProducts` to read rows from the RPC only — delete the direct `products` select and the local field mapping; (c) align `usePOSProductCache` to the same shape; (d) add an architecture guard test forbidding `from("products")` inside POS code.
- Dependency: none. Implement now.

### F2 — grid path drops packaging/UoM that the scan path carries ⚠ (Phase 2)
- Evidence: `POSProduct` (usePOSProducts) has `base_uom_id` only; no `packaging`, no `sales_uom_id`. `usePOSCart` lines and `useResolveBarcode` do carry `packaging_id / display_uom_id / packaging_label`.
- Why it matters: selling "3 bags" from the grid cannot be distinguished from 3 base units unless packaging reaches the line; base-unit conversion must stay server-side.
- Canonical owner: Product packaging (`product_packaging.qty_in_base_uom`) + server resolver.
- Required action: deferred to Phase 2 after F1 lands (the RPC already returns `packaging`).
- Dependency: F1.

## Working rules for this wave
- One phase at a time: implement → verify against the DB/live path → record verdict here → next phase.
- No POS-local Product model, UoM converter, inventory calculator or barcode logic. Upstream defects are recorded as ⏸ blocked and fixed at the canonical seam.
- Browser is never authoritative for identity, quantity conversion, price, tax, totals or stock.
- Finance stays out of scope; POS → Finance dependencies are collected under Phase 13 for the next wave.
