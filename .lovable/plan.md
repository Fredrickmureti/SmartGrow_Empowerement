# POS Wave — status (continues the approved plan archived at
# .lovable/plan/pos-wave-transaction-engine-canonical-domain-consumer-audit-2026-08-15.md)

| # | Phase | Verdict | State |
|---|---|---|---|
| 0 | Topology | — | recorded in archived plan |
| 1 | Product consumption / read seam | ✅ fixed | done (this loop) |
| 2 | UoM & packaging contract | ✅ grid parity | done (this loop) |
| 3 | Inventory availability | ✅ fixed | done (this loop) |
| 4 | Pricing & tax authority | ✅ fixed | done (this loop) |
| 5 | Transaction/commit integrity & saga | — | **ACTIVE NEXT** |
| 6-15 | (unchanged) | — | not started |

## Phase 1 — closed
- Root cause confirmed: `list_products_with_branch_stock` had two overloads
  (4-arg + 5-arg) → PostgREST `PGRST203` on the POS 4-arg call.
- Migration dropped the legacy 4-arg overload; ONE signature remains
  (`org, business, branch, include_variant_parents, warehouse`). The RPC now
  also returns `category_name, tax_rate_name, etims_tax_code, is_weighted,
  plu_code` and filters `is_active AND status='active'`, and resolves
  `tax_rate` from `tax_rates` when a rate id is set. EXECUTE granted to
  `authenticated`/`service_role` only.
- `usePOSProducts` rewritten: RPC-only read, shared `mapCanonicalProductRow`,
  no `from("products")`. `usePOSProductCache`, `ProductPeekDialog` and
  `POSBarcodeSettings` now read the same seam (product-table selects removed
  from POS entirely).
- Guard: `src/test/architecture/pos-product-read-seam.test.ts` (passing) —
  fails the build if any POS file selects from `products` again.

## Phase 2 — closed (grid/scan parity)
- `POSProduct` now carries the canonical contract: `packaging[]`,
  `base_uom_*`, `sales_uom_*`, `category_id`, `is_weighted`, `plu_code`,
  `on_hand/reserved/available`.
- POSTerminal derives `packagedProductIds` from the RPC packaging levels
  (its private `product_packaging` query is gone), stamps `base_uom_id` on
  directly-added and modifier lines, and now sends the real `category_id`
  (previously the category NAME / product type was written to `category_id`).
- Base-unit conversion remains server/dialog-owned; no POS-local UoM math added.

## Known pre-existing failures (NOT introduced by this loop)
`inventory-branch-filter`, `posScopeContaminationGuard`, `posBranchIsolation`,
`inventoryAuditCorrections` and ~100 other architecture suites were already
red before these edits; they belong to later phases / other waves.

## Phase 3 — closed (inventory availability)
Symptom addressed: POS availability decisions and the live stock signal were
both derived from the company-wide `products.stock_quantity` cache, so one
branch reacted to (and could check out against) another branch's stock.

Server (migration applied):
- `pos_register_stock_scope(register)` — ONE place resolving a register's
  (business, branch, warehouse); open shift's warehouse first, else the
  branch default. Both POS availability wrappers now delegate to it.
- `get_available_pos_stock_for_register_batch(product_ids, register,
  exclude_self)` — thin wrapper over `resolve_stock_availability_batch`;
  no availability math re-implemented (ADR 0142). Returns
  `(product_id, available)`, clamped at 0, excludes the register's own holds.
- Both functions: SECURITY DEFINER, `search_path=public`, EXECUTE revoked
  from PUBLIC/anon, granted to `authenticated`/`service_role`.
- `stock_quants` added to the `supabase_realtime` publication with
  `REPLICA IDENTITY FULL` (idempotent guard), so the till can subscribe to
  branch-grained stock instead of the cached aggregate.

Client:
- `usePOSStockSync` realtime now subscribes to `stock_quants` filtered by
  `business_id` (was `products` filtered by `organization_id`). The payload
  is used ONLY for cache invalidation — no wire quantity is a decision input,
  and the misleading cross-branch low/out-of-stock toasts are gone.
- `verifyCartStock` is one batched RPC for the whole cart (was N sequential
  calls, one per line, i.e. an inconsistent snapshot). Duplicate lines of the
  same product are summed before checking, and the call FAILS CLOSED: an
  unreachable authority blocks every line rather than green-lighting a sale.
- `usePOSProducts.hasStock` renamed `hasStockHint` and documented as advisory
  display-only (it reads the cached grid figure).

Guard: `src/test/architecture/pos-availability-authority.test.ts` (4 tests,
passing) — batched register-scoped verification, fail-closed behaviour,
`stock_quants` realtime scope, advisory-only cached hint.

## Phase 4 — closed (pricing & tax authority)
Symptom addressed: POS owned its own money math. `pos_resolve_line` read
`products.unit_price` / `products.tax_rate` directly (ignoring price lists,
customer-group pricing, pack/UoM pricing, tax-inclusive rates and customer
exemptions), and the cart computed subtotal/tax/total client-side with no
server quote before tender.

Server (migration applied):
- `pos_resolve_line` DROPPED and recreated with ONE signature
  (`business, product, qty, requested_price, discount_type, discount_value,
  contact, packaging, display_uom, at`). It no longer reads pricing/tax from
  `products`: price comes from `resolve_line_unit_price` (price list >
  price book / pack > product scalar, incl. customer-group discount) and tax
  from `resolve_sales_line_tax` (exemption > customer > product > company
  default, with `is_inclusive` and `fixed_amount` honoured). No POS-local
  pricing logic remains.
- NEW `pos_quote_cart(register, lines, contact, cart_discount_type,
  cart_discount_value)` — server-computed basket: per-line resolved
  price/tax/discount plus subtotal, line + cart discount, tax and total.
  Scope resolved via `pos_register_stock_scope`, caller checked with
  `assert_pos_caller_branch_access`. Cart discount scales tax proportionally.
- Both functions SECURITY DEFINER, `search_path=public`, EXECUTE revoked from
  PUBLIC, granted to `authenticated`/`service_role`.
- `process_pos_transaction` patched (in place, definition-rewrite guarded by a
  RAISE if the call site is missing) to price with the SAME inputs as the
  quote: it now passes `p_customer_id`, the line `packaging_id` and
  `display_uom_id`. Commit and preview can no longer disagree, so a customer
  price-list sale no longer trips `price_override_required`.

Client:
- NEW `usePOSCartQuote` — react-query wrapper on `pos_quote_cart`, keyed by a
  canonical basket signature (lines, qty, discounts, packaging/UoM, customer).
  Exposes `status` (`empty|pending|ready|unavailable`) and
  `isPricingAuthoritative`.
- `usePOSCartAdapter` now returns SERVER money for both retail and restaurant
  carts: quoted per-line `unit_price / tax_rate / tax_amount / line_total`
  and quoted `subtotal / discount_amount / tax_amount / total` (also inside
  `cartState`). Local line math survives only as an optimistic placeholder
  while the quote is in flight — never as a tender input.
- `usePOSCart` exposes its `cartDiscount` input so the cart-level discount is
  priced by the server rather than by the till.
- POSTerminal FAILS CLOSED: `openTender` (the single tender choke point) and
  `handlePaymentComplete` refuse to proceed unless the current basket is
  server-quoted; pending shows "Confirming prices…", failure blocks payment
  and re-requests the quote.

Guard: `src/test/architecture/pos-pricing-tax-authority.test.ts` (7 tests,
passing) — resolver delegation, no `products` price reads in the resolver,
branch-guarded quote RPC, quote-sourced display totals, fail-closed tender.
Also re-ran green: `pos-product-read-seam`, `pos-availability-authority`,
`pos-server-authoritative-money-math`, `usePOSCart`, `POSTerminal`.

## Currently active
Phase 5 — transaction/commit integrity & saga (not started).

## Next agent — start here
1. VERIFY Phases 1-4 before writing anything new:
   - `npx vitest run src/test/architecture/pos-product-read-seam.test.ts
     src/test/architecture/pos-availability-authority.test.ts
     src/test/architecture/pos-pricing-tax-authority.test.ts
     src/test/architecture/pos-server-authoritative-money-math.test.ts
     src/hooks/pos/__tests__/usePOSCart.test.ts
     src/pages/pos/__tests__/POSTerminal.test.tsx`
     (all currently green; the only expected red elsewhere is the PRE-EXISTING
     `process_pos_transaction` / void-reversal `stock_movements` assertion and
     the ~100 pre-existing architecture suites listed above).
   - Confirm exactly ONE overload each of `list_products_with_branch_stock`,
     `pos_resolve_line`, `pos_quote_cart` exists.
   - Confirm `process_pos_transaction` still passes customer + packaging +
     display UoM into `pos_resolve_line` (the Phase 4 migration patches the
     live definition; a later regeneration of that RPC MUST keep those args).
   - Smoke a real basket at a register: quoted total must equal the committed
     `pos_transactions` total to the cent, including a price-list customer.
2. THEN resume at Phase 5 (transaction & commit integrity): the payment-session
   saga (`openSession → recordTender → commitSession`), idempotency-key
   derivation, partial-failure/replay behaviour, offline queue drain ordering,
   and reversal/void symmetry — including the known pre-existing
   void-reversal `stock_movements` gap. Do not start Phase 6+ or unrelated
   areas before Phase 5 is closed and recorded here.
