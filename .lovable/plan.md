# Product Identity & Resolution — verification verdict, then Phases 6–8

Roadmap: `.lovable/plan/product-identity-architecture-audit-and-remediation-2026-08-05.md`.

## Phase 1 — verification verdict (done, evidence-based)

Confirmed genuinely landed:
- **Identity RPCs exist with a single signature each** — `resolve_product_identity(business, code, branch, allow_sku_fallback)`, `pos_resolve_scan`, `upsert_product_identifier`, `retire_product_identifier`. No overload duplicates remain, so the PGRST203 ambiguity that produced the original "internal server error" is genuinely gone.
- **Grants** — every identity RPC is `authenticated` + `service_role` only; no PUBLIC/anon EXECUTE.
- **Client seam** — `src/features/products/identity/{identityOutcome,writeIdentifier}.ts` exist; a repo-wide search finds **no** direct insert/update/upsert/delete against `product_identifiers` outside the seam. Consumers (`useResolveProductIdentity`, `useWmsIdentityGate`, WMS mobile pick/count, receiving, barcode import config) route through it.
- Lifecycle columns/decision statuses are in place and reflected in project memory.

Verdict: Phases 0–5 are real, not cosmetic. But three claims are **overstated**, and they are exactly the residue that keeps producing the reported symptoms:

1. **Legacy resolver still live and still called.** `pos_resolve_barcode` and `resolve_barcode_v2` both still exist in the database, and three UI surfaces still call `pos_resolve_barcode` directly for duplicate/lookup checks: `src/components/scanner/BarcodeInputField.tsx:131`, `src/components/products/ProductIdentifiersEditor.tsx:267`, `src/pages/Products.tsx:413`. These bypass the decision envelope, so "SKU edits appear inconsistent" and "duplicate already used by X" behave differently from a real scan.
2. **A legacy write RPC survives.** `enroll_product_barcode` is still present and executable by `authenticated`. It writes identifiers without the lifecycle invariants that `upsert_product_identifier` enforces — the write seam is guarded in the client only, not in the database.
3. **Two grammars, and a third offline.** SQL resolution understands only GS1 AI `(01)` plus digit padding; the client `src/lib/gs1/{parseGs1,aiTable}.ts` implements the full AI table; and the offline POS matcher `SQLiteBridge.getProductByBarcode` matches `pi.code = ?` raw — no `code_norm`, no GTIN padding, no `status`/`valid_from`/`valid_to` filter. Offline POS will therefore resolve retired or wrongly-cased codes that online resolution blocks.

Phase 7 (token dispatcher) and Phase 8 (supplier identifiers, importer discovery) are untouched; `resolve_scanned_token` does not exist. A separate location resolver seam (`useResolveLocationIdentity`) does exist and is guarded, so Phase 7 is a unification, not a build-from-zero. ADR-0110 was never written.

## Phase 6 — one grammar, one matcher (next, execute fully)

1. **Single GS1 grammar.** Promote the client AI table to the canonical definition and mirror it into one SQL function (`parse_gs1_element_string`) generated from the same vector list: AI parsing, `code_norm = upper(btrim(code))`, GTIN-8/12/13/14 padding variants, packaging-level conversion. `resolve_product_identity` calls it; no inline `(01)` handling anywhere.
2. **Offline parity.** Rewrite `SQLiteBridge.getProductByBarcode` to normalise and pad exactly as SQL does, filter `status='active'` and `valid_from/valid_to`, and return the same decision statuses as online (including `ambiguous` on multi-match) instead of `null`-means-unknown. Sync must materialise `code_norm` and lifecycle columns into the local table.
3. **Shared test vectors.** One vector table exercised by three suites — client parser, SQL resolver, offline matcher — asserting identical decisions.
4. **Delete the shims.** Cut `BarcodeInputField`, `ProductIdentifiersEditor` and `Products.tsx` duplicate/lookup checks over to `useResolveProductIdentity` (`allowSkuFallback` true only on typing paths), then drop `resolve_barcode_v2`, the `pos_resolve_barcode` row wrapper, and `enroll_product_barcode` in one migration. Add an architecture guard forbidding those names outside `supabase/migrations` and generated types.

## Phase 7 — one scanned-token dispatcher

`resolve_scanned_token(business, code, branch, context)` returns a tagged union over product identifier / warehouse location / license plate / lot / serial. Product and location hooks become thin callers of it; `useWmsIdentityGate` and `BinScanField` keep their current operator copy, extended from `identityOutcome.ts` with the new token kinds. No surface may guess a token's type from its shape.

## Phase 8 — supplier identity and identifier-discovery import

- Supplier item codes become first-class identifiers (`kind='supplier'` + `supplier_id`), resolvable and used for ASN/EDI/PO line matching, with supplier-scoped uniqueness.
- The product importer moves from a rigid column template to identifier discovery: any recognised identifier column (barcode/EAN/UPC/GTIN, supplier SKU, manufacturer code, legacy code, pack-level codes) maps to `product_identifiers` rows through `upsert_product_identifier`, with a per-row decision report instead of a hard failure.

## Phase 9 — documentation and guardrails

ADR-0110 (identifier lifecycle + decision envelope + database-enforced write seam), memory update, and a guard test asserting no client surface authors identity failure copy.

## Technical notes

- Write-seam enforcement moves into the database: revoke direct DML on `product_identifiers` from `authenticated` so the RPCs are the only mutation path — the current guard is a lint-style test, which a future surface can bypass.
- Symptoms expected to disappear as a consequence, not as individual fixes: barcode 500s (already gone), inconsistent SKU/barcode edits (item 1), duplicate-detection mismatches (item 1), offline/online scan divergence (item 3).
