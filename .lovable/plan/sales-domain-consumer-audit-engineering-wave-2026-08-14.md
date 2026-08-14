# Sales Domain — Consumer Audit & Engineering Wave

Sales must consume the canonical Product, UoM, Packaging, Pricing, Inventory, Warehouse, Tax and Finance engines — not re-implement them. This wave audits that consumption, records verdicts in a live plan file, and fixes findings one phase at a time.

## What the investigation already established

Evidence gathered from the Sales feature code and the migration history:

1. **State transitions are already server-authoritative.** `sales_orders` carries a governed-write trigger (`trg_00_sales_order_governed_write`) that rejects any direct status / totals / lock / exchange-rate write; state changes only happen inside `create_sales_order_atomic`, `confirm_sales_order_atomic`, `cancel_sales_order_atomic`, `convert_so_to_invoice_atomic`, `complete_delivery_atomic`, `cancel_delivery_atomic`. Delivery completion moves stock, resolves cost and posts COGS inside the database. This part is sound and will not be rewritten.

2. **Pricing has three competing sources and Sales uses the weakest one.**
   - `product_pricing` + `resolve_product_price(business, product, packaging, qty, price_list)` — packaging-aware, effective-dated, quantity-break aware. **Zero callers anywhere in the app.**
   - `price_lists` / `price_list_items` via `usePricing()` — resolves customer/group/volume pricing **in the browser**, and is used only by marketing/subscription pages, not by Sales.
   - `products.unit_price` — this is what `SalesOrderCreatePage` actually copies onto a line.

3. **Money and tax are computed in the browser.** The create/edit pages compute `line_total`, `tax_amount`, subtotal, tax and total in React and pass them to the RPC. `create_sales_order_atomic` re-sums the header from the lines (good) but accepts each line's `unit_price`, `tax_rate`, `tax_amount` and `line_total` verbatim. Tax rate is copied from a contact/product default read client-side, not resolved by a tax engine.

4. **The UoM/packaging seam is declared but not wired.** Item tables carry `packaging_id`, `display_uom_id`, `display_quantity`, `uom_snapshot`, and the atomic RPC persists them — but the shared line editor (`PricedLineRow`) exposes only a bare quantity and price. No Sales surface calls `convert_uom`. So "sell 17 kg of a product stocked as 50 kg bags" cannot be expressed, and it is unproven whether `quantity` on a sales line is base units or display units.

5. **Reservation is best-effort and warehouse is guessed.** `confirm_sales_order_atomic` picks the first active default warehouse for the branch and calls `create_stock_reservation` per line; failures are collected as `reservations_skipped` and the order still confirms. Sales never expresses which warehouse must fulfil.

6. **Estimates bypass the governed pattern.** Estimate lines and additional costs are inserted/deleted directly from the browser (`estimate_items`, `estimate_additional_costs`), unlike orders/invoices/deliveries.

7. **No idempotency.** None of the Sales create/convert RPCs take an idempotency key; a double submit or retry creates a second document.

## Plan file

Create `docs/plans/sales-domain-live-status.md` as the authoritative handoff artifact, with one section per phase (0–14), a single **Current active phase**, verified-complete phases, blocked phases with the named dependency, and remaining actionable work. Every finding records: evidence (file/function), why it matters, canonical owner, required action, dependency, implement-now yes/no. It is updated at the end of every phase — never rewritten wholesale.

## Phase order and content

**Phase 0 — Upstream contract verification (active).**
Verify, with database and code evidence, the contracts Sales depends on: product identity/lifecycle (`resolve_product_identity`), the UoM engine (`convert_uom`, `uom_categories.dimension`), packaging (`product_packaging.qty_in_base_uom`, hierarchy rules), physical attributes (`resolve_product_measure`), stock quant/reservation semantics and units, and the pricing tables above. Output: for each, the canonical owner, the exact function signature Sales must call, and the unit each quantity column is expressed in. Any genuine upstream defect is documented and Sales work on the dependent phase pauses — no Sales-side workaround.

**Phase 1 — Lifecycle reconstruction.** Derive the actual document graph and transitions from the RPCs and triggers (estimate → order → delivery/invoice, invoice → delivery, return → credit note), classifying each document as intent / obligation / inventory event / accounting event, and which are immutable after posting. Documentation only.

**Phase 2 — Product consumption.** Enumerate every Sales read of Product and confirm there is no Sales-local product/UoM/packaging table or duplicated SKU resolution; classify anything duplicated as read model, projection, cache, or competing truth.

**Phase 3 — UoM & packaging (highest-risk).** Establish and enforce one quantity contract for Sales lines: a customer-facing `display_quantity` + `display_uom_id`/`packaging_id`, and a canonical base quantity that inventory consumes, converted server-side by `convert_uom` — never in React. Extend the shared line editor to capture sell unit/packaging, and make the atomic RPCs derive and validate the base quantity instead of trusting the client. Prove the 17 kg / 1 bag / 3 bags cases end to end.

**Phase 4 — Pricing.** Pick one canonical resolver (evidence points to `product_pricing` + `resolve_product_price`, extended with customer/group price lists rather than a second engine), retire or demote the other paths, and make Sales resolve unit price server-side at line entry and re-validate at document creation. `usePricing`'s browser resolution stops being authoritative for Sales.

**Phase 5 — Inventory interaction.** Decide and enforce whether a confirmed order may exist with unreserved stock; replace the silent `reservations_skipped` path with an explicit, operator-visible outcome. Verify cancellation releases reservations and returns restore stock, and that availability is computed from the canonical quant engine.

**Phase 6 — Warehouse interaction.** Make the fulfilment warehouse an explicit commercial input rather than a "first default for branch" guess, and confirm Sales expresses requirements while Warehouse executes picking/packing/dispatch.

**Phase 7 — Tax.** Route tax rate and amount through the canonical tax/localization resolver server-side; browser tax stays a preview only. Flag any country-specific logic sitting in generic Sales code.

**Phase 8 — Customer & receivables.** Confirm Finance owns posting, allocation, ledger and statements, and that Sales reads those projections instead of computing balances.

**Phase 9 — Document lifecycles.** Verify each transactional document's states are engine-enforced and that estimates are brought under a governed write path like their siblings.

**Phase 10 — Server authority & concurrency.** Add idempotency keys to Sales create/convert RPCs, verify row locking on conversion paths, and test double-submit, retry, refresh and two-user edits.

**Phase 11 — Multi-tenant / branch.** Verify organization/business/branch/warehouse scope for every Sales entity, including numbering, pricing and customer scope, and test isolation.

**Phase 12 — Events.** Map real Sales business events onto the existing `business_event_outbox`; add none that no consumer needs.

**Phase 13 — Failure semantics.** Determine rollback / retry / compensation behaviour for the failure list and remove any frontend fallback that hides a failed authoritative operation.

**Phase 14 — Reporting boundaries.** Classify Overview, Statements, Customer Ledger, Collections and Salesperson Performance as projections vs. transactional surfaces; no reporting redesign in this wave.

## Working rules for this wave

- One phase at a time: inspect, identify canonical owner, verify behaviour, name the gap, update the plan file, implement, test, confirm no duplicate engine, mark complete with evidence.
- Phases already correct are marked verified and left alone.
- Upstream defects are fixed in the upstream domain through its own architecture, or the Sales phase is marked blocked — never worked around in Sales.
- Authoritative computation stays server-side; React keeps only previews.

## Deliverable of the first execution turn

Phase 0 completed with evidence and `docs/plans/sales-domain-live-status.md` created, phases 1–14 stubbed with their verification questions, and the active phase set to the first phase requiring code change.
