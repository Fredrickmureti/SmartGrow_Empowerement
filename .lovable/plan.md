# Supplier Purchasing Conditions — audit findings and reconstruction plan

## A. What this domain actually is

The screen labelled "Vendor Price Lists" is not a price list. It is the
**purchasing info record**: the commercial conditions under which a *named
supplier* can supply a *named product* — price, currency, purchase unit,
minimum quantity, order increment, lead time, validity. It is a **source for
resolution**, never a transaction and never accounting.

The codebase already agrees with that reading: the table is
`supplier_item_terms`, ADR 0141 already declared it the canonical owner of
purchasing terms, and the UI is only a legacy party-keyed façade over it
(`src/hooks/useVendorPriceLists.ts` maps `preferred_rank <= 1` to a
`is_preferred` boolean and `currency_code` to `currency`).

## B. Boundary (confirmed against the existing ERP)

- Supplier conditions own: *what is available and on what terms*.
- `procurement_contracts` (+ lines, versions, amendments, releases) own the
  *commitment* — they already have their own lifecycle and approvals.
- RFQ owns quoted responses; PO owns what was actually agreed.
- Cost layers own valuation; finance starts at GRN/bill. Conditions create
  no accounting. This stays true.

## C. What already exists and must be reused (no new engines)

| Capability | Existing authority |
|---|---|
| Terms resolution | `resolve_supplier_purchasing_terms(business, product, supplier, on_date)` |
| Quantity policy | `validate_supplier_order_quantity` + `_purchase_assert_order_quantity` |
| UoM | `resolve_line_base_quantity` / `_uom_normalize_line` triggers |
| FX | `resolve_exchange_rate` / `require_exchange_rate` (ADR 0135/0136) |
| Party↔role hop | `_resolve_supplier_role_id` (ADR 0079) |
| Approvals | `approval_requests` / `approval_rules` + `_mirror_approval_to_*` |
| Events | `business_event_outbox` |
| Scope | `user_has_business_access`, `applyBranchFilter`, branch stamping guards |
| Client seam | `src/features/products/purchasing/supplierPurchasingTerms.ts` |

Nothing in this plan adds a second engine for any of the above.

## D. Verified defects (each confirmed by reading the live function/table)

1. **Price breaks are stored but never applied.** `supplier_item_terms.price_break_tiers`
   (jsonb) is validated by `_validate_supplier_item_terms` — strictly increasing
   tiers — yet `resolve_supplier_purchasing_terms` takes **no quantity argument**
   and returns the flat `v_t.unit_price`. No client file reads the tiers. A
   quantity-dependent price can be captured and will silently never be charged.
2. **No purchase-side price authority.** `resolve_line_unit_price` is the
   *sales* resolver (customer price lists, customer groups). Purchasing has no
   equivalent, so nothing ever decides precedence between an active contract
   line and a standing supplier condition. `purchase_order_items` already carries
   `contract_line_id` and `contract_unit_price`, so the precedence exists as
   data but is not resolved by any one server function.
3. **No provenance snapshot on the PO line.** The line snapshots UoM
   (`uom_snapshot*`) and contract price, but records no
   `supplier_terms_id`, no price source, and no FX rate at line level. "Why this
   price?" is not answerable years later for non-contract lines.
4. **Branch scope is contradictory.** The table has `branch_id` and the UI
   filters by branch, but the overlap guard in `_validate_supplier_item_terms`
   keys only `business_id + product_id + supplier_id`. Two branches cannot hold
   different valid conditions for the same window; one blocks the other.
5. **No governance, no audit, no event.** `upsert_supplier_item_terms` contains
   no reference to approvals, audit or `business_event_outbox` (verified on the
   live function body). Price changes are silent and unapproved.
6. **`preferred_rank` is flattened to a boolean in the UI**, discarding a real
   ranked sourcing order the column already supports.
7. **`currency_code text DEFAULT 'USD'`** with no tie to the business's active
   currencies; the form has no currency selector at all (the page only
   *formats* using `useCurrency`).
8. **Client-side status arithmetic**: `vendorPriceListView.tsx` computes
   expired/expiring-soon with `new Date()` in the browser.

Verdicts: boundary ✅ · terms resolver ✅ · quantity policy ✅ ·
price breaks ❌ · purchase price precedence ❌ · PO provenance ❌ ·
branch scope ❌ · governance/events ❌ · currency ⚠ · UI ⚠.

## E. Reconstruction phases (dependency-ordered, server before UI)

**Phase 1 — Make the resolver price-complete.**
Add `p_quantity` to `resolve_supplier_purchasing_terms`; it selects the
applicable `price_break_tiers` row (highest `min_qty <= quantity`, quantity
compared in base units via `resolve_line_base_quantity`, never in the browser)
and returns `unit_price` plus `price_source` (`tier` / `flat` / none) and the
tier boundary. Existing callers keep working (quantity defaults to the MOQ).

**Phase 2 — One purchasing price authority.**
`resolve_purchase_line_price(business, product, supplier, quantity, uom,
on_date)` returning price, currency, UoM, and a provenance record. Precedence,
resolved server-side and stated once: active contract line → supplier condition
tier → supplier condition flat → product default → manual. It calls the Phase 1
resolver and the contract tables; it does not re-implement either.

**Phase 3 — Branch-correct scope + validity.**
Extend the overlap guard to include `branch_id` (branch-specific conditions
coexist with a company-wide `NULL` row; branch wins at resolution). Effective
status becomes a server-derived expression, so the UI stops computing it.

**Phase 4 — Governance, audit, events.**
Register `supplier_terms.activate` / `.amend` with the existing approval engine
(mirroring the procurement-contract pattern), write `audit_logs`, and emit
`procurement.supplier_terms.{created,amended,expired,deactivated}` to
`business_event_outbox` — inside the same transaction as the write.

**Phase 5 — Provenance snapshot on the PO line.**
Add `supplier_terms_id` and `price_source` to `purchase_order_items`, stamped by
the existing PO write RPCs from the Phase 2 resolver alongside the contract
columns already there. Historical POs remain explainable when terms change.

**Phase 6 — Purchases consumption.**
`purchaseLineTerms.ts` (the single adapter) gains the price from Phase 2 so PO
/ requisition / RFQ-award lines default to the resolved price and unit — no new
seam, no browser arithmetic.

**Phase 7 — The workspace UI, last.**
Rename to Supplier Conditions, replace the `is_preferred` boolean with the
ranked sourcing order, add the canonical currency and UoM selectors, edit price
breaks as tiers, show provenance and effective status from the server, and
group the list around active / expiring / missing-coverage / pending-approval.
Context carry-in from product, supplier and requisition preselects.

**Phase 8 — Ratchets.**
Extend `supabase/tests/supplier_purchasing_terms_test.sql` and
`src/test/architecture/purchasing-terms-single-owner.test.ts`: no second price
resolver, no tier arithmetic or date-status arithmetic in browser files, no
direct writes to `supplier_item_terms`, overlap guard includes branch, PO write
RPCs stamp provenance, the write RPC emits an outbox row.

## F. Notes on the remaining fields

`notes` stays free text with no lifecycle — it is not a substitute for
structure and no engine may read it. `lead_time_days` is defined in the ADR
follow-up as **calendar days from PO issue to goods available at the receiving
location**; Phase 3 records that definition as a column comment and the UI
states it, rather than leaving a bare integer.

Each phase ends with the SQL guard and architecture test for that phase, so no
phase can be reverted silently by later work.
