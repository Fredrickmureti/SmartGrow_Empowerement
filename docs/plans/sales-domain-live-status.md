# Sales Domain — Live Status (Product/Inventory Consumer Audit Wave)

Authoritative handoff between engineering agents. One section per phase.
Update at the end of every phase; never rewrite wholesale.
Every finding records: **Evidence · Why it matters · Canonical owner · Required action · Dependency · Implement now?**

Verdict legend: ✅ correct · ⚠ needs improvement · ❌ architecturally wrong · ⏸ blocked upstream

> Evidence rule for this wave: `supabase/migrations/**` is **stale** relative to
> the live database (e.g. the migration copy of `confirm_sales_order_atomic`
> calls a `create_stock_reservation` function that no longer exists; the live
> body calls `reserve_stock_atomic`). All database claims below were read from
> `pg_proc` / `pg_attribute` on the live project, not from migration files.

---

## Phase 0 — Upstream contract verification ✅ COMPLETE

The contracts Sales is supposed to consume, verified against the live database.

### 0.1 Product identity — ✅ canonical, unused by Sales

`resolve_product_identity(p_business_id, p_code, p_branch_id, p_allow_sku_fallback, p_supplier_id)`
returns `(status, product_id, product_name, sku, identifier_id, matched_kind,
matched_code, packaging_id, packaging_name, qty_in_base_uom, base_uom_id,
is_base_unit, match_count)` — i.e. the resolver already hands the caller the
**packaging level and its base-unit multiplier**. ADR 0114 fixes the read seam
(`useResolveProductIdentity` / `resolveProductIdentityOnce`, and
`scanToBaseUnits` for the conversion).

Sales consumes it only through `DocumentLineScanner`; the manual
product-picker path in the Sales create pages does not go through the seam and
therefore never sees `packaging_id` / `qty_in_base_uom`.

### 0.2 UoM engine — ✅ canonical, zero Sales callers

`convert_uom(p_qty numeric, p_from_uom uuid, p_to_uom uuid) → numeric` is the
single conversion engine; `uom_categories.dimension` classifies the family
(count/mass/volume/length/…). Callers in the app: product form, variants,
physical attributes, product hooks. **No Sales file references `convert_uom`.**

### 0.3 Packaging — ✅ canonical, partially consumed

`product_packaging(product_id, name, qty_in_base_uom, parent_packaging_id,
qty_in_parent, is_shipping_unit, is_purchase_default, **is_sales_default**)`.
The hierarchy and the *sales default* level already exist upstream.
`products.sales_uom_id` also exists as the default selling unit.
**No Sales file references `sales_uom_id` or `is_sales_default`.**

### 0.4 Physical attributes — ✅ canonical (ADR 0140)

`resolve_product_measure(p_business, p_product, p_packaging, p_measure,
p_target_uom) → numeric`, fail-closed (NULL when unknown). Sales needs it only
for shipping weight/volume on delivery; it must never copy the columns.
**No Sales caller today** — acceptable until Phase 6 decides whether delivery
needs shipment weight.

### 0.5 Inventory / reservation — ✅ canonical engine, idempotent

`reserve_stock_atomic(p_organization_id, p_product_id, p_quantity,
p_source_type, p_source_id, p_warehouse_id, p_location_id, p_lot_number,
p_lot_id, p_expires_at, **p_idempotency_key**, p_allow_partial, p_reserved_by,
p_metadata)`, plus `release_stock_reservation`,
`release_stock_reservations_for_source`, `consume_stock_reservation(s)`,
`allocate_stock_reservation`, `expire_stock_reservations`,
`get_available_stock(product, warehouse, business, branch)`.
Live `confirm_sales_order_atomic` calls `reserve_stock_atomic` with a per-line
idempotency key (`sales_order:<so>:<item>`). The reservation engine is sound.

### 0.6 Pricing — ❌ three sources, no owner

| Source | Shape | Callers |
| --- | --- | --- |
| `product_pricing` + `resolve_product_price(business, product, packaging, qty, price_list)` | packaging-aware, effective-dated, min-quantity breaks, currency | **none, anywhere** |
| `price_lists` / `price_list_items` via `usePricing()` | customer / group / volume resolution **in the browser** | marketing + subscription pages only |
| `products.unit_price` | flat scalar | **what Sales actually uses** |

All three tables are currently empty (0 rows), so no data migration is implied
by choosing an owner — this is a pure architecture decision.

### 0.7 Tax — ❌ no sale-time resolver exists

`tax_rates(business_id, rate, is_inclusive, is_compound, tax_type,
fixed_amount, effective_from, effective_to, etims_tax_code)` is the canonical
configuration, but the only tax functions in the database are
`resolve_product_tax_localization(product, jurisdiction)`,
`upsert_product_tax_localization` and `resolve_sales_return_line_tax(invoice_item, qty)`.
**There is no `resolve_sales_line_tax`-style engine.** Sales create pages read
`tax_rates` directly from the browser and compute `tax_amount` in React.

### 0.8 Line quantity contract — ❌ no base-quantity column

Across `sales_order_items`, `invoice_items`, `delivery_note_items`,
`estimate_items`, `credit_note_items` the columns are `quantity`,
`display_quantity`, `packaging_id`, `display_uom_id`, `uom_snapshot text`.
There is **no `base_quantity`**, no CHECK tying `quantity` to
`display_quantity × qty_in_base_uom`, and no column comment declaring the unit
of `quantity` — except `delivery_note_items.uom_snapshot` ("Frozen base UoM
code at DN insert"), which implies `quantity_delivered` is in base units.
Inventory movements at `complete_delivery_atomic` consume `quantity_delivered`
directly, so **base units is the de-facto contract, enforced nowhere**.
Additional defect: `invoice_items.quantity` and `estimate_items.quantity` are
`numeric(10,2)` while `sales_order_items.quantity` is `numeric(15,2)` — a
weight-selling line (17.005 kg) silently rounds.

`uom_snapshot` is `text` in the database, but
`src/services/documents/snapshots/lineItemUom.ts` accepts either a string or an
object — a latent contract split to close in Phase 3.

### Phase 0 verdict

| Contract | Verdict |
| --- | --- |
| Product identity | ✅ canonical (Sales under-consumes) |
| UoM engine | ✅ canonical (zero Sales callers) |
| Packaging | ✅ canonical (zero Sales callers) |
| Physical attributes | ✅ canonical (not yet needed) |
| Inventory / reservation | ✅ canonical and idempotent |
| Pricing | ❌ three competing sources, none owned |
| Tax | ❌ no sale-time resolver; browser computes tax |
| Line quantity contract | ❌ undeclared and unenforced |

**No upstream defect blocks Sales.** Every gap found is a Sales-side
consumption failure, plus two missing canonical engines (sale-time pricing
resolution ownership, sale-time tax resolution) whose correct home is the
Pricing and Tax domains respectively — not Sales.

---

## Phase 1 — Sales lifecycle reconstruction — ⏳ not started

To verify: the real document graph from live RPCs/triggers
(`create_sales_order_atomic`, `confirm_sales_order_atomic`,
`convert_estimate_to_so_atomic`, `convert_so_to_invoice_atomic`,
`create_delivery_from_sales_order_atomic`, `create_invoice_from_delivery_atomic`,
`complete_delivery_atomic`, `cancel_*`), classifying each document as
intent / obligation / inventory event / accounting event, which are optional,
which are immutable after posting, which require reversal rather than edit.

Known so far: `sales_orders` is protected by
`trg_00_sales_order_governed_write` (rejects direct status, totals, `is_locked`,
`converted_invoice_id`, `exchange_rate` writes with SQLSTATE 42501); benign
header fields stay editable. Delivery completion posts COGS and moves stock.

## Phase 2 — Product consumption — ⏳ not started

To verify: every Sales read of Product; absence of Sales-local product / UoM /
packaging tables; duplicate SKU resolution; whether the manual product picker
should route through the identity read seam like the scanner does.

## Phase 3 — UoM & packaging — ⏳ not started (highest risk)

Target contract: a line stores **what the customer bought**
(`display_quantity` + `display_uom_id` or `packaging_id`) **and** what
inventory consumes (base quantity), the second derived server-side via
`convert_uom` / `qty_in_base_uom` — never in React. Must prove: 17 kg of a
product stocked in 50 kg bags, 1 bag, 3 bags. Includes widening the
`numeric(10,2)` quantity columns and settling the `uom_snapshot` text-vs-object
split.

## Phase 4 — Pricing — ⏳ not started

Choose one owner (evidence favours `product_pricing` + `resolve_product_price`,
extended with customer/group scope rather than a second engine), demote the
others, resolve price server-side at line entry and re-validate at document
creation.

## Phase 5 — Inventory interaction — ⏳ not started

Decide whether a confirmed order may exist with unreserved stock:
`confirm_sales_order_atomic` today counts failures into `reservations_skipped`
and confirms anyway. Verify cancellation releases via
`release_stock_reservations_for_source`, delivery consumes via
`consume_stock_reservations_for_source`, and returns restore stock.

## Phase 6 — Warehouse interaction — ⏳ not started

Both `confirm_sales_order_atomic` and `complete_delivery_atomic` pick the first
active, non-transit, default warehouse for the branch. Sales never states a
fulfilment warehouse. Decide whether the commercial document must express it.

## Phase 7 — Tax — ⏳ not started

Introduce (in the Tax/localization domain, not Sales) a sale-time resolver over
`tax_rates` with effective dates and inclusive/compound handling; Sales calls
it server-side, React keeps a preview only. Audit `etims_*` fields for
localization leakage into generic Sales code.

## Phase 8 — Customer & receivables — ⏳ not started

Confirm Finance owns posting, allocation, ledger, statements; Sales reads
projections.

## Phase 9 — Document lifecycles — ⏳ not started

Per-document state machines; bring `estimate_items` /
`estimate_additional_costs` (today inserted and deleted straight from the
browser) under a governed write path like their siblings.

## Phase 10 — Server authority & concurrency — ⏳ not started

`create_sales_order_atomic` derives header totals from the lines (good) but
accepts each line's `unit_price`, `tax_rate`, `tax_amount`, `line_total`
verbatim, and takes no idempotency key. Add idempotency to Sales create/convert
RPCs; test double-submit, retry, refresh, two-user edit.

## Phase 11 — Multi-tenant / branch — ⏳ not started

Scope audit per entity, including numbering (`get_next_so_number`,
`get_next_invoice_number`), pricing scope, customer scope, warehouse scope.

## Phase 12 — Events — ⏳ not started

Map real Sales events onto the existing `business_event_outbox`; add none
without a consumer.

## Phase 13 — Failure semantics — ⏳ not started

Rollback / retry / compensation behaviour; remove frontend fallbacks that hide
failed authoritative operations.

## Phase 14 — Reporting boundaries — ⏳ not started

Classify Overview, Statements, Customer Ledger, Collections, Salesperson
Performance as projections vs transactional surfaces.

---

## Current active phase

**Phase 1 — Sales lifecycle reconstruction** (documentation only; it defines
the document graph the later phases enforce).

## Verified complete

- Phase 0 — upstream contract verification (evidence above).

## Blocked phases

None. Phases 4 and 7 depend on an ownership decision, not on an upstream
defect.

## Remaining actionable work

1. Phase 1 — reconstruct the lifecycle from live RPCs and triggers.
2. Phase 3 — the line quantity contract (highest business risk: quantities are
   currently ambiguous between customer units and inventory units).
3. Phase 4 — collapse three pricing sources to one server-side resolver.
4. Phase 7 — create a sale-time tax resolver in the Tax domain.
5. Phase 10 — idempotency + server-side line money validation.
6. Phase 9 — governed write path for estimates.
