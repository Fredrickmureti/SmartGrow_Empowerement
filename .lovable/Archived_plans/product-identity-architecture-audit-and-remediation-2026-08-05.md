# Product Identity — architecture audit and remediation

## Verdict

The platform already has the *right shape* (ADR-0102: one SQL resolver, one client hook, level-aware packaging). It does not yet have a **domain service**. What exists is a lookup table plus a matcher. Five structural gaps make the reported symptoms inevitable, and none of them are fixable at the call site.

## What I verified

- `resolve_product_identity(business, code, branch)` exists, is SECURITY DEFINER, tenant-gated, does GS1 `(01)` extraction + GTIN padding, returns `match_count`. `pos_resolve_barcode` and `resolve_barcode_v2` delegate to it.
- `product_identifiers` columns: `id, organization_id, business_id, product_id, code, kind, is_primary, notes, created_at, updated_at, created_by, packaging_id, code_norm`.
- `product_identifier_kind` = gtin, sku, pack, supplier, internal, plu, alias.
- `enroll_product_barcode` exists **twice** (4-arg and 5-arg overloads).
- EXECUTE on `resolve_product_identity`, `product_identification_queue`, and the 5-arg `enroll_product_barcode` is granted to **anon**.
- Direct client writes to `product_identifiers` from `ProductIdentifiersEditor`, `ProductPackagingEditor`, `POSBarcodeSettings`, `productBarcodeImportConfig`, `_resolveProduct`.
- `SQLiteBridge` (offline POS) contains its own independent SQL matcher over `product_identifiers`.
- `supplier_item_terms` holds commercial terms only — no supplier item code / supplier barcode column.

## The five architectural gaps

**1. Identity has no lifecycle.** There is no `status`/`is_active`, no `valid_from`/`valid_to`, no `replaced_by`, no `source`. Every negative outcome — unknown, inactive, archived, wrong tenant, duplicate, no auth — collapses into *zero rows*. The requested operator-facing taxonomy is not representable in the current data model, so it cannot be produced by any amount of UI work.

**2. The resolver returns rows, not a decision.** A `SETOF` shape cannot carry a reason code. Callers infer `not_found` from emptiness, which is why a permission failure, a tenant mismatch and a genuinely unknown code all read as "unknown barcode".

**3. Writes bypass the service.** Reads funnel through one resolver; writes go straight to the table from four surfaces. `is_primary` is flipped with two separate statements (clear-all, then set-one) with no transaction — the most likely mechanism behind "SKU edits appearing inconsistent" and "multiple identifiers behaving unexpectedly". Enrollment invariants only hold on the enrollment page's path.

**4. Three matchers, one concept.** SQL resolver (online), `SQLiteBridge` (offline POS), and `_resolveProduct` (importer) each implement matching differently — only the SQL one does GS1 and GTIN padding. A code that scans online can miss offline. GS1 is also parsed twice: `src/lib/gs1/parseGs1.ts` and again inside the SQL function.

**5. Identity stops at the product.** Supplier item codes have a `kind` but nowhere to record *which supplier*, so ASN/EDI matching on a supplier part number is unmodelled. Lots, serials, license plates and locations each resolve through their own path. There is no single "resolve whatever was scanned" entry point.

Symptom mapping: RPC 5xx/300 class → duplicate `enroll_product_barcode` overloads + anon grants (candidate ambiguity, unauthenticated calls reaching a definer function). Identifier inconsistency → gap 3. Scans failing despite identifiers existing → gaps 1 and 4.

## Plan

**Phase 0 — Confirm the failure, don't assume it.** Reproduce the barcode 5xx against the live RPCs and capture the actual PostgREST code before changing anything. If it is not overload ambiguity, the phase order stands but the Phase 1 fix is re-derived from the captured error.

**Phase 1 — Close the drift (small, immediate).** Drop the redundant `enroll_product_barcode` overload; revoke `anon` EXECUTE on `resolve_product_identity`, `product_identification_queue`, `enroll_product_barcode`. Guard test: no identity RPC is anon-executable, none is overloaded.

**Phase 2 — Model identity as a first-class entity.** Migration adding to `product_identifiers`: `status` (active / inactive / archived), `valid_from`, `valid_to`, `source` (manual / import / asn / gs1 / migration), `supplier_id` (nullable FK, required when `kind='supplier'`), `replaced_by_id`. Backfill to active/manual. Partial unique index on active codes only, so an archived code can be re-issued. Grants + RLS mirrored from the current table.

**Phase 3 — Resolver returns a decision.** `resolve_product_identity` returns a structured envelope: `status` ∈ `resolved | ambiguous | not_found | inactive | archived | expired | foreign_tenant | unauthorized`, plus candidate and `match_count`. The SKU fallback moves out of the resolver and becomes an explicit caller flag (typing paths only) — labels and WMS never get it. Legacy row-shape wrappers keep `pos_resolve_barcode` working during migration.

**Phase 4 — One client seam, one taxonomy.** `useResolveProductIdentity` maps every status to operator copy plus a remediation action (enrol, review duplicate, reactivate, contact admin). `useWmsIdentityGate` and POS consume that map — no surface writes its own message. POS's parallel envelope in `useResolveBarcode` is deleted, keeping only its pricing/tax layer on top of the shared identity result.

**Phase 5 — Writes through the service.** All identifier mutation moves behind `upsert_product_identifier` / `retire_product_identifier` RPCs enforcing primary-uniqueness atomically, level ownership, and status transitions. `ProductIdentifiersEditor`, `ProductPackagingEditor`, `POSBarcodeSettings` and the importer call those. `identity-resolver-single-seam.test.ts` extended to fail on any direct `.from("product_identifiers")` write outside the service.

**Phase 6 — One grammar, one matcher.** GS1 parsing collapses to a single implementation with one AI table. `SQLiteBridge`'s offline matcher is regenerated from the same normalisation rules (padding, `upper(btrim())`, packaging conversion), with a shared test-vector table proving online and offline agree.

**Phase 7 — Identity beyond the product.** `resolve_scanned_token(business, code, context)` dispatches to product / location / license plate / lot / serial resolvers and returns a tagged union. Existing product and location hooks become thin callers. This is the seam ASN, picking, packing and future manufacturing consume.

**Phase 8 — Supplier and import.** Supplier item codes become real identifiers (`kind='supplier'` + `supplier_id`), so ASN/EDI lines match on supplier part number. Product import moves from rigid per-file templates to identifier discovery: any column recognised as an identifier kind becomes an identifier row; multiple codes and multiple packaging levels per product in one file. ASN/EDI parsing stays owned by Procurement/Receiving; it *consumes* the identity service and never queries `product_identifiers`.

## Ownership after this work

| Concern | Owner |
| --- | --- |
| Product master, packaging levels | Inventory |
| All identifiers, resolution, GS1 grammar | Product Identity service |
| Lot / serial / license plate registries | Warehouse (via the Phase 7 dispatcher) |
| Supplier terms, ASN/EDI parsing | Procurement |
| Price, tax, weighted rules | POS (layered on identity, never re-matching) |
| Locations / bins | Warehouse |

## Scope notes

- Phases 1 and 2 are non-breaking. Phases 3–5 change call sites; each ships with its wrapper so no surface breaks mid-migration.
- No backward-compatibility shims survive past Phase 6 — `resolve_barcode_v2` and the POS-only envelope are deleted.
- ADR-0102 gets an amendment (or ADR-0110) recording the lifecycle model, the decision envelope, and the write-through-service rule; `mem/features/product-identification.md` updated in the same pass.