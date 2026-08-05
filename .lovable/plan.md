# Product Identity & Resolution — authoritative status

Roadmap: `.lovable/plan/product-identity-architecture-audit-and-remediation-2026-08-05.md` (Phases 0–8).

## Currently active
Phase 5 complete → **next active phase is Phase 6 (one grammar, one matcher)**.

## Done and verified
- **Phase 0–1** — reproduced the barcode RPC failure (PGRST203 overload ambiguity); dropped the duplicate `enroll_product_barcode`, revoked PUBLIC/anon EXECUTE on all identity RPCs (anon calls now 401).
- **Phase 2** — `product_identifiers` lifecycle: `status`, `valid_from/to`, `source`, `supplier_id`, `replaced_by_id`; invariant trigger; partial unique index on active codes.
- **Phase 3** — `resolve_product_identity(business, code, branch, allow_sku_fallback)` returns a decision: `resolved | ambiguous | not_found | inactive | archived | expired | foreign_tenant | unauthorized`.
- **Phase 4** — one client seam, one taxonomy:
  - `src/features/products/identity/identityOutcome.ts` is the only source of operator copy.
  - `useResolveProductIdentity` (+ `describeResolution`), `useWmsIdentityGate`, PhysicalCount, TransferNew, CountSession, PickList all consume it; SKU fallback is intent-driven (typing yes, scanning no).
  - POS parallel envelope removed: new `pos_resolve_scan(business, branch, code)` RPC returns the identity decision **plus** price/tax/packaging in one round trip; `useResolveBarcode` now returns `{kind:'miss', status, matchCount, productName}` and POSTerminal, SalesScanContext and InvoiceLineScanner render shared taxonomy copy instead of "Unknown barcode".
- **Phase 5** — writes through the service: `writeIdentifier` / `retireIdentifier` (`upsert_product_identifier` / `retire_product_identifier`) are the only mutation path. Cut over: ProductIdentifiersEditor, ProductPackagingEditor (level binding), POSBarcodeSettings (save + retire, no hard delete), the barcode importer, and Products.tsx import enrolment.
- Guards green: `src/test/architecture/identity-write-seam.test.ts` (no `product_identifiers` mutation outside the seam), `identity-resolver-single-seam.test.ts`, `identity-outcome-taxonomy.test.ts`, `resolve-product-identity.test.tsx`, `resolve-barcode-contract.test.ts`, `sales-scan-context.test.tsx`. Typecheck clean.
- Memory: `mem/features/product-identity-decisions.md`.

## Pending
- **Phase 6 (next)** — one GS1 grammar, one matcher. Collapse `src/lib/gs1/parseGs1.ts` and the SQL AI parsing into a single implementation with one AI table; regenerate `SQLiteBridge`'s offline matcher from the same normalisation rules (upper/btrim, GTIN padding, packaging conversion); shared test-vector table proving online and offline agree. Delete the surviving shims (`resolve_barcode_v2`, legacy `pos_resolve_barcode` row wrapper) only once no caller remains — current remaining callers are duplicate checks in `BarcodeInputField`, `ProductIdentifiersEditor`, `Products.tsx`.
- **Phase 7** — `resolve_scanned_token(business, code, context)` SQL dispatcher over product / location / license plate / lot / serial, returning a tagged union; product and location hooks become thin callers. Verify the existing locations resolver first to keep scope contained.
- **Phase 8** — supplier item codes as real identifiers (`kind='supplier'` + `supplier_id`) for ASN/EDI matching; importer moves from rigid templates to identifier discovery.
- ADR-0110 write-up (lifecycle + decision envelope + write-through rule) still to be added alongside ADR-0102.

## Instructions for the next agent
1. **Verify before building.** Confirm Phase 4/5 landed to enterprise standard: run the identity/POS test files listed above plus a typecheck; grep that no source outside `src/features/products/identity/writeIdentifier.ts` mutates `product_identifiers`; confirm `pos_resolve_scan` is `authenticated`-only and that every non-resolved POS scan renders taxonomy copy (no hand-written "Unknown barcode" strings remain in scan consumers).
2. Only then start **Phase 6**, and finish it end to end (single grammar + offline matcher parity + shared vectors + shim deletion) before touching Phase 7.
3. Keep execution chronological — no jumping to Phase 8 or unrelated domains, no partially cut-over surfaces.
4. Update this file at the end of each phase.
