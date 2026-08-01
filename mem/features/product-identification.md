---
name: product-identification-canonical-resolver
description: Invariants for level-aware product identification — canonical resolver seam, base-unit conversion, ambiguity handling, level-aware labels, and the columns removed in Phase D.
type: constraint
---
- ONE resolver: SQL `resolve_product_identity(business, code, branch)` (tenant-gated, `anon` revoked, GS1 `(01)` + GTIN padding variants, returns `match_count`). `pos_resolve_barcode` and `resolve_barcode_v2` delegate to it. Client callers use `useResolveProductIdentity` only; WMS surfaces use `useWmsIdentityGate`.
- Capture surfaces (WMS receiving/picking/counts, GRN wizard, transfers, physical count) must never query `product_identifiers` directly or use the POS-only `useResolveBarcode`. Guard: `src/test/architecture/identity-resolver-single-seam.test.ts`.
- Quantity conversion goes through `scanToBaseUnits(identity, n)` — a case scan posts `qty_in_base_uom` base units. Never post 1 for a level scan.
- `ambiguous` (match_count > 1) and `error` BLOCK the line; `not_found` blocks in WMS and may fall back to a literal SKU match only on inventory count/transfer typing paths.
- Pack size lives on `product_packaging.qty_in_base_uom`. `product_identifiers.pack_quantity` and `product_packaging.barcode_id` were dropped (Phase D); the identifier→level link is `product_identifiers.packaging_id`, protected by `trg_product_identifier_packaging_guard`.
- `code_norm` is `upper(btrim(code))` everywhere — never reintroduce `lower()`.
- Labels: `resolveLabelBarcode(product, level?)` encodes the requested level's own identifier and REFUSES when absent. No fallback to another level, the SKU, or an internal id (ADR-0089 / ADR-0102).
- Enrollment queue is server-side (`product_identification_queue`); `useProductsAwaitingBarcode` is deleted.
