# ADR 0114 — Product identity and resolution: one decision, one grammar, two seams

- **Status**: Accepted (2026-08-05)
- **Supersedes**: ADR 0017 (universal product acquisition — transport layer
  stands, resolution layer replaced), ADR 0102 (canonical resolver — extended
  into a decision envelope with lifecycle and supplier scope)
- **Extends**: ADR 0089 (label barcode identity policy), ADR 0071 (GS1 capture)

## Context

Identity resolution had converged on one SQL function, but the *edges* had
not. Enrollment still wrote through a legacy `enroll_product_barcode` RPC
that skipped the lifecycle, primary-label and supplier-scope invariants;
three UI surfaces called the resolver raw, so a duplicate check and a real
scan could disagree about the same code; the architecture guards were
file-list based and therefore blind to any surface they did not already
name; and the grammar helpers were executable by `anon`.

The operator-visible symptom was the familiar one: a SKU edit that "did not
stick", and a code that scanned in one module and not in another.

## Decision

**Identity is a decision, not a row — and it has exactly two seams.**

1. **Decision envelope.** `resolve_product_identity(business, code, branch,
   allow_sku_fallback, supplier)` returns a `status`: `resolved | ambiguous |
   not_found | inactive | archived | expired | supplier_scoped |
   foreign_tenant | unauthorized`. "No rows" is never re-interpreted as
   "unknown". Every non-resolved status blocks the line; only `not_found` on
   a typing path may fall back to a literal SKU.

2. **One grammar.** `identity_code_candidates` / `parse_gs1_element_string`
   own normalisation (`upper(btrim)`), GTIN padding families and the
   table-driven GS1 AI grammar, mirrored in `src/lib/gs1/` and pinned by a
   parity test on both sides.

3. **Read seam.** `useResolveProductIdentity` (hook) and
   `resolveProductIdentityOnce` (imperative, for scan callbacks and
   debounced duplicate checks) are the only client callers of the resolver.
   `useWmsIdentityGate` wraps it with the dock rule: block plus audio/haptic
   feedback, never a toast-only narration. POS uses `pos_resolve_scan`
   through `useResolveBarcode`; supplier discovery uses
   `discover_supplier_identity` through `useSupplierCodeDiscovery`.

4. **Write seam.** `src/features/products/identity/writeIdentifier.ts` is the
   only client caller of `upsert_product_identifier` and
   `retire_product_identifier`. Identifiers are retired, never deleted.
   `enroll_product_barcode` is dropped from the database.

5. **Supplier scope.** `product_identifiers.supplier_id` partitions
   uniqueness across two partial unique indexes, so vendors may reuse each
   other's part numbers. A supplier-scoped code resolves only when the caller
   supplies vendor context, and that context must be derived from the
   session's inbound document — never from operator input.

6. **Operator copy.** All failure wording comes from
   `describeIdentityOutcome` / `describeResolution`. No surface authors its
   own, and RPC/SQLSTATE detail never reaches an operator.

7. **Authenticated-only surface.** Every identity function, including the
   grammar helpers, is `authenticated` + `service_role`; `anon` and `PUBLIC`
   are revoked.

## Consequences

- A case scan posts `qty_in_base_uom` base units everywhere, because the
  conversion exists in exactly one helper (`scanToBaseUnits`).
- Enrollment, import and the editor cannot produce an identifier the resolver
  will not honour — they share the write path that enforces the invariants.
- A blocked code can no longer spawn a duplicate product master: on the
  Products page only `not_found` offers "create a new product".
- Supplier pricelist imports register the vendor product code as a
  supplier-scoped identifier instead of stringifying it into `notes`.

## Guardrails

- `src/test/architecture/identity-resolver-single-seam.test.ts` — repo-wide
  scan (not a file list): one owner per identity RPC, dropped RPCs never
  reappear, supplier context is document-derived.
- `src/test/architecture/identity-write-seam.test.ts` — no table mutation and
  no write-RPC call outside the seam.
- `src/test/inventory/identity-outcome-taxonomy.test.ts`,
  `supplier-identity-scope.test.ts`, `resolve-product-identity.test.tsx`.
- `supabase/tests/resolve_product_identity_supplier_scope_test.sql`,
  `identity_code_candidates_test.sql`.

## Out of scope

- Renaming `pos_resolve_scan` (weighted-EAN and embedded-price rules live
  there; identity itself delegates to the canonical resolver).
- Returns/RMA scanning parity, tracked separately.
