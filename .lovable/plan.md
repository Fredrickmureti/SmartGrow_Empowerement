# Supplier Conditions — verification result and next phases

## Phase 1 verification (done this turn, evidence-backed)

Every Phase 1–8 claim in the previous status file was checked directly against
the database and the codebase. All of them hold:

| Claim | Evidence |
|---|---|
| Price-complete resolver | `resolve_supplier_purchasing_terms(p_business_id, p_product_id, p_supplier_id, p_on_date, p_quantity, p_branch_id)` exists, SECURITY DEFINER, `authenticated`/`service_role` only |
| One price authority | `resolve_purchase_line_price` + internal `_resolve_purchase_line_price`, both branch- and quantity-aware, no `anon` grant |
| Quantity enforcer | `validate_supplier_order_quantity` present, SECURITY DEFINER |
| Governed single write path | one `upsert_supplier_item_terms` overload carrying `preferred_rank`, `order_increment`, `purchase_uom_id`, `price_break_tiers`; `supplier_terms.amend` registered and active in `governance_action_registry` |
| Server-computed status | `public.effective_status(supplier_item_terms)` exists, `authenticated` only, and the workspace hook selects it rather than computing dates in the browser |
| PO provenance | `purchase_order_items.supplier_terms_id` + `price_source` present with the stamping trigger |
| Ratchets | `purchasing-terms-single-owner.test.ts` — 8 tests, all passing |

Conclusion: the wave is genuinely at the state claimed. No closed phase is
reopened. Two real gaps surfaced during verification and are folded in below.

## Phase 9 — Purchase-price override governance

Today a PO line may carry any manual price above the resolved one and it is
recorded only as `price_source = 'manual'`, with no reason and no approval.
That is the largest remaining hole in "why did this PO use this price?".

- Add `price_override_reason text` and `price_override_approval_id uuid` to
  `purchase_order_items`; the stamping trigger requires a reason whenever the
  agreed price differs from the resolved price beyond a tolerance.
- Tolerance is business configuration (a percentage plus absolute floor) read
  from the existing settings layer, not a hardcoded constant.
- Breaching the tolerance routes through the existing `approval_route` engine
  under a new registered action key `purchase_order.price_override`; no new
  approval mechanism.
- PO entry surfaces the resolved price, the delta and the reason field; the
  refusal wording comes from the existing verdict describer.

## Phase 10 — Suspended and expired conditions are visible

The workspace hook filters `is_active = true`, so a suspended or superseded
condition disappears instead of appearing under "needs attention". Widen the
read to include inactive rows, gate them behind an explicit filter chip, and
add them to the summary counts. Status still comes from `effective_status`.

## Phase 11 — Context carry-in

Opening a condition from a product, a supplier record or a requisition line
preselects that party/product and, from a requisition, the branch and quantity
used to preview the resolved tier. Pure UI plumbing over the existing seam.

## Phase 12 — Supplier coverage view

A read-only view answering "which purchasable products have no active approved
condition, and which have only one supplier". Built as a projection over the
existing resolver and `supplier_item_terms`; no new tables, no second
reporting store.

## Phase 13 — Route slug and screen consolidation

`/purchases/price-lists` becomes `/purchases/supplier-conditions` with a legacy
redirect entry; `src/pages/VendorPriceLists.tsx` and the `price-lists` feature
folder are renamed to match the domain vocabulary so the code and the ADRs use
one name.

## Boundaries that must hold

One price authority (`resolve_purchase_line_price`), one client seam
(`supplierPurchasingTerms.ts`, reached from Purchases only via
`purchaseLineTerms.ts`), no browser arithmetic on price, quantity or validity,
and conditions create no accounting.

## Technical notes

- All SQL ships through migrations; every new function is SECURITY DEFINER,
  gated on `user_has_business_access`, `authenticated` + `service_role` only.
- Each phase adds its guard: a SQL assertion in
  `supabase/tests/supplier_purchasing_conditions_test.sql` and, where a browser
  regression is possible, an assertion in
  `src/test/architecture/purchasing-terms-single-owner.test.ts`.
- ADR 0142 gets a "purchase price override" amendment once Phase 9 lands.
