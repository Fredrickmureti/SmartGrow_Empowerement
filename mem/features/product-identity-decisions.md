---
name: product-identity-decision-envelope
description: Product identity resolution returns a decision (status) with lifecycle-aware outcomes, one shared operator copy taxonomy, and an explicit SKU-fallback intent switch.
type: constraint
---
- `resolve_product_identity(business, code, branch, allow_sku_fallback)` returns a DECISION: `status` is one of resolved | ambiguous | not_found | inactive | archived | expired | foreign_tenant | unauthorized. Never "no rows means unknown".
- SKU fallback is intent-driven: scanning paths (WMS gate, POS, labels) pass `allowSkuFallback: false` (default); typing/search paths (Physical Count, Transfer entry) pass `true`.
- Operator copy for every non-resolved outcome comes from `src/features/products/identity/identityOutcome.ts` (`describeIdentityOutcome` / `identityOutcomeLine`). Capture surfaces must not author their own failure wording, and must never surface RPC/SQLSTATE detail. Guard: `src/test/inventory/identity-outcome-taxonomy.test.ts`.
- All non-resolved outcomes BLOCK the line. `not_found` may additionally fall back to a literal SKU match only on typing paths.
- Identifier lifecycle lives on `product_identifiers.status` + `valid_from/valid_to`; only active codes can be primary; uniqueness is a partial index so archived codes can be re-issued.
- Writes go through `upsert_product_identifier` / `retire_product_identifier` — never direct table inserts/updates from the client. Client seam: `src/features/products/identity/writeIdentifier.ts` (`writeIdentifier` / `retireIdentifier`); identifiers are retired (archived), never hard-deleted. Guard: `src/test/architecture/identity-write-seam.test.ts`.
- POS scans call `pos_resolve_scan(business, branch, code)` — one round trip returning the identity decision plus price/tax/packaging. POS never re-matches identifiers and never authors its own failure copy.
- Identity RPCs are `authenticated`-only: revoke from PUBLIC and anon whenever a new one is added.