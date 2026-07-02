# Opening-stock → GL trigger — root-cause audit (2026-05-28)

**Verdict:** The observed behavior is **correct**. The reported
"30,000 inventory asset" entry is the cost-based capitalization of opening
stock, triggered by an opening-balance inventory transaction — **not** by
mere product creation. No hidden auto-posting, no selling-price
contamination, no metadata→GL leak.

## Reported scenario

- Product selling price = 80
- Product cost = 50
- Quantity in stock = 600
- System produced **30,000**, visible in journal entries and on the Balance
  Sheet under Assets.

## Trigger trace (what operational event posted the entry)

1. **Product create form** (`src/pages/Products.tsx`) has an optional
   "Opening stock per warehouse" block, shown on CREATE only. The operator
   entered qty 600 with a unit cost of 50 for a warehouse.
2. On save, the client filters opening lines to positive quantities and,
   because `track_inventory` is on and opening items exist, calls
   `create_product_with_opening_stock_atomic`.
3. That RPC inserts the product row first (pure metadata — **no GL**). Then,
   **only when** a positive opening quantity exists (`v_has_opening`), it
   routes each warehouse line through `apply_or_request_stock_adjustment`
   with `reason = 'opening_balance'`.
4. The approved opening-balance adjustment posts a balanced journal entry
   via the canonical `post_journal_entry_atomic` path:
   - **Dr** Inventory Asset (`default_account_settings 'inventory'`) — 30,000
   - **Cr** Opening Balance Equity (`opening_balance_equity`) — 30,000
   - JE description: `Opening Inventory — {adjustment_number}`,
     `source_type = 'stock_adjustment'`, `source_id = {adjustment_id}`.

## Valuation confirmation (cost, not price)

- 30,000 = `600 × 50` (cost). Selling price (80) would have produced 48,000
  and never enters valuation.
- Cost resolution order: caller `unit_cost` → product `cost_price`
  (`COALESCE(NULLIF(sai.unit_cost,0), p.cost_price, 0)`), with a hard RAISE
  if no positive cost can be resolved. The selling price (`unit_price`) is
  never referenced in any valuation path.

## Config-vs-transaction boundary (the original concern)

- Product **create with zero opening quantity** → metadata only, **no JE**
  (guarded by `v_has_opening`).
- Product **update** → never writes stock or GL
  (`Products.tsx`: "opening stock is intentionally NOT written here").
- The only path from product creation to the GL is the operator deliberately
  supplying opening stock — which is, by definition, an inventory
  transaction, not metadata.

## Enterprise comparison

Capitalizing opening inventory at cost against an opening-equity account is
the standard "initial quantity on hand" pattern in QuickBooks, Xero,
NetSuite, Odoo, and ERPNext. Product masters are metadata; inventory
transactions (opening balances, receipts, adjustments, deliveries) are the
accounting events. This implementation matches that separation.

## Hardening shipped (transparency + traceability only)

The accounting is correct; the *experience* was the gap — the opening-stock
field lives inside the product-create form, so the GL consequence felt
implicit. Changes (frontend + docs + test, **no schema change**):

1. **Live GL preview** in the create form: when any opening quantity is
   positive, an inline note shows
   `Dr Inventory {amount} / Cr Opening Balance Equity {amount}` (valued at
   cost), and states that no opening quantity posts nothing.
2. **JE deep-link** in the success toast: a "View entry" action links to
   `/finance/journal-entries?selected={id}` for immediate audit.
3. **Regression guard:**
   `src/test/architecture/opening-stock-gl-trigger.test.ts` pins the
   positive-quantity gate, the cost-based valuation (no `unit_price`), and
   the traceability surface.

## Unresolved risks / future recommendations

- Optional structural UX: move opening-balance entry out of the product
  form into a dedicated "Opening Balances" wizard for clearer onboarding.
  Deferred — current inline flow is correct and industry-standard.

## Cross-references

- `docs/audit/2026-05-22-opening-stock-gl.md`
- `docs/adr/0002-costing-method-avco-on-receipt.md`
- `docs/adr/0016-inventory-adjustment-gl-integrity.md`
- `docs/adr/0020-journal-entry-narration-convention.md`
