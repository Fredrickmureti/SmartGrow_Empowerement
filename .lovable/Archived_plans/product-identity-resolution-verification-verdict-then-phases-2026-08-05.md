# Product Identity & Resolution — verification verdict, then Phases 9–11

## Phase 1 verdict: what the previous engineer claimed vs. what is actually there

Verified directly against the database and the source tree.

**Genuinely landed (Phases 0–8, mostly real):**
- `resolve_product_identity(business, code, branch, allow_sku_fallback, supplier)` exists with a single 5-arg signature. `pos_resolve_barcode` and `resolve_barcode_v2` are gone from the database and nothing calls them.
- `pos_resolve_scan`, `upsert_product_identifier`, `retire_product_identifier`, `discover_supplier_identity` all exist, all `authenticated` + `service_role` only, no anon.
- Both partitioned uniqueness indexes exist: `..._active_global_code_uidx` (business, code_norm) and `..._active_supplier_code_uidx` (business, supplier, code_norm), plus supplier lookup index.
- Client seams exist and are wired: `useResolveProductIdentity`, `useWmsIdentityGate`, `writeIdentifier`/`retireIdentifier`, `identityOutcome`, `useSupplierCodeDiscovery`, `useReceivingSessionSupplier`, `SupplierCodeDiscoveryPanel`, `classifyScanToken`, shared GS1 grammar + SQL mirror and its parity test.

**Overstated or wrong — treated as pending work:**

1. **The write seam is not actually single.** The legacy `enroll_product_barcode` RPC is still in the database, still executable by `authenticated`, and still called at `src/hooks/inventory/useEnrollmentWorkflow.ts:206` — the main barcode-enrollment workspace. It writes identifiers without the lifecycle, supplier-scope and primary-label invariants that `upsert_product_identifier` enforces. This is the mechanism behind "SKU edits appearing inconsistent" and it survived the whole programme.
2. **The write-seam guard cannot see this.** `identity-write-seam.test.ts` only forbids table mutations (`.from("product_identifiers").insert/update/...`). It says nothing about legacy write RPCs, so the bypass passes the build.
3. **`ProductIdentifiersEditor.tsx:405` calls `retire_product_identifier` directly** instead of going through `retireIdentifier`, duplicating the failure-copy mapping.
4. **Three surfaces bypass the client read seam** by calling `resolve_product_identity` raw: `src/pages/Products.tsx:413`, `src/components/scanner/BarcodeInputField.tsx:132`, `src/components/products/ProductIdentifiersEditor.tsx:267`. They skip the decision envelope, the shared copy taxonomy, the candidate grammar and the cache — so a duplicate check disagrees with a real scan.
5. **The resolver guard is file-list based.** `identity-resolver-single-seam.test.ts` checks five hardcoded cutover files, so any new or untouched surface (the three above) is invisible to it. Its header comment also still names the deleted `pos_resolve_barcode` as canonical.
6. **Phase 9 is untouched**: no ADR, no operator documentation, no SQL parity test for supplier scoping.
7. **ADR number 0110 is already taken twice** (`0110-dispatch-proof-carrier-abstraction-and-documents.md`; `0102` is triple-booked). The identity ADR needs a free number, and the numbering collision itself should be recorded.
8. **Grammar helpers are `PUBLIC`-executable**: `identity_code_candidates`, `parse_gs1_element_string`, `gs1_ai_table` grant EXECUTE to PUBLIC (so anon). They read no data, but the "identity surface is authenticated-only" claim is not literally true.
9. **Supplier code capture at import still has nowhere to land** — `productSupplierImportConfig` writes the vendor product code into a free-text `notes` field (`vendor_sku=…`), not into `product_identifiers`.

Test/typecheck state: identity suites pass. Two unrelated pre-existing failures exist in `src/test/architecture` (pack token registry / pack skeleton install gate) and are out of scope here.

---

## Phase 9 — Close the seams that are still open (do first, before documentation)

9.1 **Retire `enroll_product_barcode`.** Rewrite `useEnrollmentWorkflow`'s `defaultEnroll` on top of `writeIdentifier`, mapping its result to the existing `EnrollRpcResult` shape so the reducer and the test seam are unchanged. Drop the RPC from the database in the same migration and delete `supabase/tests/enroll_product_barcode_test.sql`, replacing its coverage with `upsert_product_identifier` vectors.

9.2 **Make the write guard RPC-aware.** Extend `identity-write-seam.test.ts` so that outside `writeIdentifier.ts` no source may call `upsert_product_identifier`, `retire_product_identifier`, or any legacy identifier-write RPC by name. Cut `ProductIdentifiersEditor` over to `retireIdentifier`.

9.3 **Make the read guard repo-wide.** Replace the five-file allowlist in `identity-resolver-single-seam.test.ts` with a whole-tree scan: only `useResolveProductIdentity` may call `resolve_product_identity`; only `useResolveBarcode` may call `pos_resolve_scan`; only `useSupplierCodeDiscovery` may call `discover_supplier_identity`. Fix the stale header comment.

9.4 **Cut the three bypass surfaces over.** `Products.tsx`, `BarcodeInputField`, `ProductIdentifiersEditor` use `useResolveProductIdentity` (typing paths pass `allowSkuFallback: true`, scanning paths `false`) and render failure copy from `describeIdentityOutcome` only.

9.5 **Lock the grammar helpers down**: revoke EXECUTE from PUBLIC on `identity_code_candidates`, `parse_gs1_element_string`, `gs1_ai_table`; grant `authenticated` + `service_role`.

9.6 **Supplier-context guard.** An architecture test asserting no surface passes a `supplierId` into the resolver that it did not derive from an inbound document (`useReceivingSessionSupplier`) — never from free operator input.

## Phase 10 — SQL parity and documentation

10.1 `supabase/tests/resolve_product_identity_supplier_scope_test.sql`: cross-vendor code reuse, `supplier_scoped` blocking status without vendor context, resolution with vendor context, both partial unique indexes enforced, global code always resolving.

10.2 ADR at the next free number (`docs/adr/0114-product-identity-and-resolution.md`): decision envelope, one grammar, token dispatcher, supplier scoping, the two seams. Annotate ADR-0017, 0071, 0089, 0102 where superseded, and note the duplicate-number problem in `docs/adr/README.md`.

10.3 Operator documentation: what each blocking outcome means on the dock and in POS, and the supplier-code linking flow.

10.4 Update `mem/features/product-identity-decisions.md` with the single-write-RPC rule.

## Phase 11 — Supplier code capture at import (was Phase 10 backlog)

11.1 Route `productSupplierImportConfig`'s vendor product code into `product_identifiers` as a supplier-scoped identifier via `writeIdentifier` (`kind: "supplier"`, `source: "import"`), instead of the `notes` string. Report per-row identity outcomes in the import result rather than failing the row silently.

11.2 Returns/RMA scanning parity review against `classifyScanToken` and the identity gate.

## Technical notes

- Migrations: one for dropping `enroll_product_barcode` + the grammar-helper revokes; keep the `upsert_product_identifier` signature unchanged so no client churn.
- `useEnrollmentWorkflow` keeps its `enrollFn` injection point, so its existing tests keep working after the seam swap.
- No UI redesign in this programme — only failure copy moves to `describeIdentityOutcome`.
