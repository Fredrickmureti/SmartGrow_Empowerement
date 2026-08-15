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

## Phase 1 — Sales lifecycle reconstruction ✅ COMPLETE (documentation)

Reconstructed from live `pg_proc` / `pg_trigger`, not from migrations.

### The real document graph

```text
crm_leads ──convert_lead_to_estimate──▶ ESTIMATE ──convert_estimate_to_so_atomic──▶ SALES ORDER
                                          │                                            │
                                          └──convert_estimate_to_invoice_atomic──┐      │
PROFORMA ──convert_proforma_to_invoice_atomic────────────────────────────────────┤      │
                                                                                 ▼      │
   SALES ORDER ──confirm_sales_order_atomic──▶ (stock reserved)                INVOICE ◀┤
        │                                                                        ▲      │
        ├──create_delivery_from_sales_order_atomic──▶ DELIVERY NOTE              │      │
        │                                              │ dispatch_delivery_atomic│      │
        │                                              ▼                         │      │
        │                                       complete_delivery_atomic         │      │
        │                                       (stock out + COGS posted)        │      │
        │                                              │                         │      │
        │                                   create_invoice_from_delivery_atomic ─┘      │
        └──convert_so_to_invoice_atomic───────────────────────────────────────────────── ┘

INVOICE ──confirm_invoice_atomic / confirm_invoice_and_release_stock_atomic──▶ posted (AR + journal)
   │
   ├──create_sales_return_atomic ▶ SALES RETURN ──approve_sales_return_atomic──▶ stock back in
   ├──create_credit_note_atomic  ▶ CREDIT NOTE  ──confirm_credit_note_atomic──▶ apply_credit_to_invoice_atomic
   └──payments ──▶ allocations (Finance)

POS ──create_pos_credit_sale_invoice_atomic──▶ INVOICE (same AR spine)
```

### Classification

| Document | Nature | Optional? | Inventory effect | Accounting effect |
| --- | --- | --- | --- | --- |
| Estimate / Quote | commercial intent | yes | none | none |
| Proforma | commercial intent | yes | none | none |
| Sales order | obligation | yes (invoice-direct is legal) | **reservation** on confirm | none |
| Delivery note | fulfilment event | yes (service sales) | **stock out + COGS** on completion | COGS + inventory journal |
| Invoice | financial obligation | **no** — the AR spine | optional release on confirm (`confirm_invoice_and_release_stock_atomic`) | AR + revenue + tax journal |
| Sales return | reverse fulfilment | yes | stock in on approval | reverses COGS |
| Credit note | financial reversal | yes | none | AR reversal, allocation |
| Payment / allocation | settlement | yes | none | Finance-owned |

### Immutability and reversal (live triggers)

- `sales_orders` — `trg_00_sales_order_governed_write` rejects direct writes to
  status, totals, `is_locked`, `converted_invoice_id`, `exchange_rate` (42501);
  benign header fields stay editable. `sales_order_items` locked by
  `enforce_sales_order_items_lock_trg`; `trg_lock_so_on_dn_invoice` locks the
  order once a delivery note or invoice exists.
- `estimates` — `trg_estimate_status_write_guard`.
- `proforma_invoices` — `trg_proforma_status_write_guard` +
  `trg_proforma_block_converted_delete`.
- `credit_notes` — `sod_credit_notes_guard` (no self-approval).
- `invoices` — **no status/totals governed-write guard**. The only invoice
  guards are `trg_invoices_block_void_with_allocations`,
  `enforce_invoice_requires_journal`, contact/business match, count limit, and
  `cascade_voided_invoice_allocations`. ❌ **The AR spine is the least protected
  document in the domain** — a plain `update invoices set status/total` is not
  rejected the way the same write is on a sales order. Fix in Phase 9/10.
- All Sales tables carry `trg_enforce_org_write_lock` (org-level freeze).

Corrections after posting are by reversal (`create_credit_note_atomic`,
`create_sales_return_atomic`, `create_return_delivery_atomic`,
`cancel_delivery_atomic`, `cancel_sales_order_atomic`), never by edit.

## Phase 2 — Product consumption ✅ COMPLETE

- Sales owns **no** product-like table. The only tables Sales writes are its own
  documents plus `contacts` and `tax_rates` (read).
- Products reach Sales exclusively through the server RPC
  `list_products_with_branch_stock` (`useBranchScopedProducts`), which returns
  branch-true `on_hand` / `reserved` / `available` from the canonical
  availability engine — company-wide `products.stock_quantity` is deliberately
  not used. ✅ correct consumption shape.
- ⚠ **The projection is too narrow to be a correct consumer.** It returns
  `unit_price`, `tax_rate`, `tax_rate_id`, `track_inventory`, GL accounts —
  but **no `base_uom_id`, no `sales_uom_id`, no packaging levels, no
  `min_order_quantity` unit context**. Sales therefore *cannot* express a
  packaging-aware line even if the UI wanted to. Phase 3's first required
  action is widening this RPC's projection (Product domain change, consumed by
  Sales) rather than adding a second product query in Sales.
- ⚠ The manual product picker bypasses the ADR 0114 identity read seam that the
  scanner path (`DocumentLineScanner`) uses, so a picked line never receives
  `packaging_id` / `qty_in_base_uom` while a scanned line could. One seam, two
  behaviours.
- No duplicate-SKU handling in Sales — correct: uniqueness and ambiguity are
  the resolver's job (`status = 'ambiguous'`).


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

## Phase 6 — Invoice ↔ Receivables boundary — 🚧 in progress

- **6.0 done** — `InvoiceLineRow` consumes the shared `LineStockEval`; the
  availability coverage test now fails on any re-declared `StockEval`.
- **6.3 done** — `invoices` is a governed document. Trigger
  `trg_00_invoices_governed_write` rejects direct writes to `status`,
  `invoice_number`, `journal_entry_id`, `amount_paid`;
  `set_invoice_status_atomic` owns the legal non-financial transitions and
  `link_invoice_journal_entry_atomic` is the importer's link-once door.
  Client call sites migrated (`useInvoices`, `useInvoicesPaginated`,
  `MigrationStepOpenBalance`).
- **6.1 done** — see the dated section below.
- **6.2 done** — `create_invoice_atomic(p_header, p_items, p_user_id,
  p_idempotency_key)` writes header + lines in one transaction; replays return
  the first invoice via `public.sales_document_idempotency`.

## Current active phase

**Phase 6 — Invoice ↔ Receivables boundary — complete (6.0, 6.1, 6.2, 6.3).**
Next action: Phase 6b (warehouse selection on Sales documents), the next
milestone in the roadmap.

## Verified complete

- Phase 0 — upstream contract verification.
- Phase 1 — lifecycle reconstruction (document graph, classification,
  immutability/reversal map).
- Phase 2 — Product consumption (single server read seam).
- Phase 3 — the line quantity contract (`resolve_line_base_quantity`).
- Phase 4 — pricing / tax / totals resolvers with header totals rewritten
  from the lines.
- Phase 5 — availability policy consumed by every line-capturing editor.
- Phase 6 — Invoice ↔ Receivables boundary (shared stock type, server GL
  resolution, atomic idempotent creation, governed writes).

## Blocked phases

None.

## Remaining actionable work

1. Phase 6b — warehouse selection on Sales documents.
2. Phase 7 — sale-time tax resolver ownership in the Tax domain.
3. Phase 9/10 — governed write path for estimates; idempotency across Sales
   RPCs (reuse `sales_document_idempotency`).
4. Phase 2 follow-up — route the manual product picker through the ADR 0114
   identity read seam.
5. Recurring invoicing — `process-recurring-invoices` still writes
   `next_run_date` itself (pre-existing, outside Sales Phase 6).


## Phase 6.1 — server-side invoice GL resolution (done, 2026-08-15)

- `build_invoice_je_lines(uuid)` resolves AR (customer override → canonical
  default), per-line revenue (`resolve_product_gl_account`), `output_tax` and
  `discount_given`; raises actionable errors on missing mappings.
- `_confirm_invoice_core` builds the lines itself and rejects client-supplied
  `p_main_lines` (42501); the two atomic wrappers keep the argument only as a
  refused legacy parameter.
- `src/hooks/invoices/confirmInvoiceGL.ts` reduced to a thin RPC seam.
- Evidence: `confirmInvoiceGL.test.ts` (7 passing),
  `compensation-writer-monopoly.test.ts` (17 passing), `tsgo` clean.
- Next: 6.2 atomic invoice creation with idempotency.

## Phase 6.2 — atomic, idempotent invoice creation (done, 2026-08-15)

- `public.create_invoice_atomic(p_header jsonb, p_items jsonb, p_user_id uuid,
  p_idempotency_key text)` — SECURITY DEFINER, business-access checked, always
  creates a `draft`. Server resolves: document number
  (`get_next_invoice_number`), base quantity (`resolve_line_base_quantity`,
  rejecting a disagreeing client base quantity), per-line money, header
  totals, and `resolve_sales_exchange_rate`.
- `public.sales_document_idempotency` — `(organization_id, document_type,
  idempotency_key)` unique; a replay returns the original response with
  `idempotent_replay: true`. Reusable for Phase 10.
- Client seam `src/hooks/invoices/createInvoiceAtomic.ts`; both
  `useInvoices.createInvoice` and `useInvoicesPaginated.createInvoice` now go
  through it — no header/line inserts, no client totals. Bill-to snapshot is
  frozen post-create via `freezeBillToSnapshot("invoices", ...)`.
- Evidence: `src/test/architecture/invoice-creation-atomic.test.ts` (6),
  `confirmInvoiceGL.test.ts` (7), `compensation-writer-monopoly.test.ts` (17),
  `sales-availability-coverage.test.ts` (24) — all passing; `tsgo` clean.
- Known exception: `MigrationStepOpenBalance` still bulk-inserts historic
  opening-balance invoices directly. That is the migration importer, not the
  Sales editor path; it is a deliberate, documented exception.
