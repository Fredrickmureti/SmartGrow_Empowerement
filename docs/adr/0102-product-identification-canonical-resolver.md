# ADR 0102 — Product identification: one canonical resolver, level-aware

- **Status**: Accepted (2026-08-01)

> **Superseded in part by [ADR 0114](./0114-product-identity-and-resolution.md)** (2026-08-05):
> the decision envelope, the single read/write client seams, supplier-scoped
> identifiers and the authenticated-only identity surface replace the
> resolution rules described below. The transport/labelling rules that ADR
> 0114 does not restate remain in force.

- **Supersedes in part**: ADR 0017 (universal product acquisition), ADR 0089
  (label barcode identity policy — extended, not replaced)
- **Related**: ADR 0025 (lot-aware quants), ADR 0071 (GS1 capture)

## Context

Product identity was spread across three competing sources of truth:

- `products.barcode` (single legacy string, mirrored into the offline cache)
- `product_identifiers.pack_quantity` (a free number typed next to a code)
- `product_packaging.barcode_id` (the inverse link from a level to a code)

Nothing kept them in agreement. `pack_quantity` could say 12 while the
`Case` level said 24, and every capture surface (WMS receiving, picking,
counts, GRN, transfers) hand-rolled its own matching — mostly a
case-insensitive SKU compare, which cannot express "this barcode is the
case, not the each". A scanned case therefore posted **1** unit.

`code_norm` was also generated as `lower(code)` while every resolver
compared `upper(btrim(code))`, so alphanumeric identifiers never matched.

## Decision

**One resolver, one identity contract, level-aware end to end.**

1. **Model.** An identifier belongs to a packaging level:
   `product_identifiers.packaging_id → product_packaging.id`. That level's
   `qty_in_base_uom` is the *only* pack size. `pack_quantity` and
   `product_packaging.barcode_id` are dropped. A BEFORE trigger rejects an
   identifier bound to another product's or business's level.
   `code_norm` is `upper(btrim(code))` everywhere.

2. **SQL.** `resolve_product_identity(business, code, branch)` is the single
   resolver: tenant-gated (`user_can_access_business`), `anon` revoked,
   GS1 `(01)` GTIN extraction plus GTIN-8/12/13/14 padding variants, and a
   `match_count` so callers can tell resolved / ambiguous / not-found apart.
   `pos_resolve_barcode` and the legacy `resolve_barcode_v2` shim both
   delegate to it. `product_identification_queue` does completeness
   filtering + paging server-side for the enrollment workspace.

3. **Client.** `useResolveProductIdentity` is the only client caller: GS1
   interpretation, LRU cache, single-flight, one retry, and a tagged
   envelope `resolved | ambiguous | not_found | error`. `scanToBaseUnits`
   is the single conversion helper. `useWmsIdentityGate` adds the WMS rule:
   unknown / ambiguous / error **blocks the line** and emits audio+haptic
   feedback through `scanFeedbackBus` — never a toast-only narration.

4. **Labels.** `resolveLabelBarcode(product, level?)` is level-aware: a
   level label encodes that level's own identifier and refuses when the
   level has no identifier. It never falls back to another level's code,
   the SKU, or an internal id (ADR-0089 intact).

## Consequences

- A case scan posts `qty_in_base_uom` base units on receiving, picking,
  counts, GRN and transfers — the conversion is computed in one place.
- Ambiguity is a first-class outcome; duplicates surface to the operator
  instead of being silently `LIMIT 1`-ed.
- Adding a capture surface = call `useResolveProductIdentity` (or the WMS
  gate) and multiply by `qtyInBaseUom`. No new RPC, no new matching code.
- Guard test `src/test/architecture/identity-resolver-single-seam.test.ts`
  fails the build if a capture surface queries `product_identifiers`
  directly or reintroduces the POS-only resolver.

## Out of scope

- Renaming the `pos_resolve_barcode` RPC (weighted-EAN/embedded-price rules
  still live there; it delegates identity to the canonical resolver).
- The offline SQLite mirror keeps `product_identifiers` only; legacy
  `products.barcode` is gone from new caches and never read at runtime.
