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
- ONE grammar (Phase 6): scan→candidate codes comes from `identityCodeCandidates` (TS, `src/lib/gs1/identityCodes.ts`) and its exact SQL mirror `public.identity_code_candidates`, both proven against the shared vectors in `src/lib/gs1/identityCodeVectors.ts` / `supabase/tests/identity_code_candidates_test.sql`. GS1 parsing in SQL is table-driven (`gs1_ai_table`, `parse_gs1_element_string`) — never re-hardcode AI (01).
- Offline parity: `resolveProductIdentityOffline` (SQLiteBridge) uses the same candidates + lifecycle predicate (`isIdentifierLive`) and returns resolved/ambiguous/not_found; `getProductByBarcode` is a thin wrapper. Local SQLite carries `code_norm/status/valid_from/valid_to`.
- `pos_resolve_barcode` and `resolve_barcode_v2` are DROPPED. Guard: `src/test/architecture/no-dropped-identity-rpc.test.ts`. Ambiguity is counted on DISTINCT product_id.
- Phase 7 dispatcher: `classifyScanToken` (`src/lib/scan/classifyScanToken.ts`) decides the token kind (product | location | sscc | opaque | empty) BEFORE any resolver runs; `describeTokenMismatch(token, expected)` is the shared refusal copy and NEVER refuses an `opaque` token (SKU/LPN/doc no.). Wired into `useWmsIdentityGate` (expects product) and `BinScanField` (expects location). GS1 AI (00) SSCC and (414) GLN are now in both the TS AI table and SQL `gs1_ai_table()`.
- GS1 parsers (TS and SQL) skip a separator that follows a fixed-length AI — printers emit one unconditionally and the tail was previously misparsed (lot/serial dropped).
