# Landed Cost — Phase F: physical allocation bases proven on real data

## Why

Weight and volume allocation existed in `landed_cost_allocate_voucher` but had
never executed: `product_physical_attributes` held zero rows, so every physical
allocation hit the refusal branch. The capability was unverified.

## Defect found and fixed

`public.convert_uom(p_qty, p_from, p_to)` raised `unknown UoM` when called with
a NULL quantity and NULL source unit. `enforce_physical_attribute_integrity()`
derives gross weight as `net + COALESCE(convert_uom(tare, ...), 0)`, so **any**
product with a net weight but no packaging (tare) weight could not be saved at
all. Fixed at the canonical engine: converting an absent quantity now returns
NULL instead of raising. Unknown-unit detection for real values is unchanged.

## What was seeded (canonical paths only)

- `product_physical_attributes` for Sugar and Cooking Oil, at base-unit and
  packaging level (50 kg bag, 20 L drum). Gross weight was left NULL and
  derived by the integrity trigger — never hand-written.
- `PO-2026-0002` → received through `create_goods_receipt` (which delegates to
  `complete_goods_receipt_atomic`, i.e. real stock movements and journal), with
  two lines in different packaging: 4 bags of Sugar, 3 drums of Cooking Oil.
- Chair and Cable were deliberately left with no measures.

## Results

Weight basis — `LCV-2026-00002`, freight 8,000 KES:

| Product     | packages | measure/pack | basis (kg) | ratio    | allocated |
|-------------|----------|--------------|-----------:|---------:|----------:|
| Sugar       | 4        | 50.25        | 201.0      | 0.773672 | 6,189.38  |
| Cooking Oil | 3        | 19.60        | 58.8       | 0.226328 | 1,810.62  |

Volume basis — `LCV-2026-00003`, insurance 3,000 KES:

| Product     | packages | measure/pack | basis (L) | ratio    | allocated |
|-------------|----------|--------------|----------:|---------:|----------:|
| Sugar       | 4        | 56           | 224       | 0.780488 | 2,341.46  |
| Cooking Oil | 3        | 21           |  63       | 0.219512 |   658.54  |

Both sum exactly to the component amount, and both differ from a value-based
split (24,000 vs 15,000) — the basis genuinely changes the answer.

Refusal — `LCV-2026-00004` (Chairs received, weight basis requested):

> `cannot allocate component Inland freight by weight: no weight recorded for
> Chair — capture the product physical attributes first`

Zero allocation rows were written. The system refuses rather than fabricating a
measure, exactly as designed.

## Ratchet

`supabase/tests/landed_cost_weight_volume_test.sql` locks in: one measure
reader, refusal-by-name, measurement at the received packaging level, the
immutable basis snapshot on each allocation row, gross = net + tare, the
`convert_uom(NULL)` contract, and exact summation back to the component.

## Open item (blocked outside the database)

`landed_cost_post_voucher` routes through `approval_route`, which requires
`auth.uid()`. Tooling sessions are unauthenticated, so `LCV-2026-00002` and
`LCV-2026-00003` are left in `allocated` status: posting must be performed from
the signed-in application. This is governance working as intended, not a
defect — the posting path itself is already covered by the Phase 6.2 hardening
tests and by the posted/reversed `LCV-2026-00001`.
