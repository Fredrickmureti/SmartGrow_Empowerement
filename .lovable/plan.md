# Product Identity & Resolution Architecture — Project Plan (ADR-0110)

Authoritative status for the enterprise product identification programme
(Inventory → Warehouse → Procurement → POS → Sales).

Last updated: 2026-08-05 — **Phase 8 complete. Active next: Phase 9.**

## Architectural vision (unchanged)

One grammar, one resolver, one decision envelope, one write seam, one copy
taxonomy. A scanned code is interpreted identically online, offline and in
SQL; every non-match names *why* and blocks the line; nothing invents a
product.

---

## Completed and verified

### Phase 0–3 — One resolver, one decision
- `resolve_product_identity(business, code, branch, allow_sku_fallback, supplier)`
  is the ONLY identity resolver. Returns a decision `status`:
  `resolved | ambiguous | not_found | inactive | archived | expired |
  foreign_tenant | unauthorized | supplier_scoped`.
- `pos_resolve_barcode` and `resolve_barcode_v2` dropped; POS goes through
  `pos_resolve_scan`, which delegates to the resolver.
- Identifier lifecycle on `product_identifiers.status` + `valid_from/valid_to`;
  live-only partial uniqueness so archived codes can be re-issued.
- Guard: `src/test/architecture/no-dropped-identity-rpc.test.ts`.

### Phase 4–5 — Client seams
- Read seam: `useResolveProductIdentity`; WMS wrapper `useWmsIdentityGate`
  (blocks the line + audible feedback, never a bare toast).
- Write seam: `writeIdentifier` / `retireIdentifier` over
  `upsert_product_identifier` / `retire_product_identifier`.
- Copy taxonomy: `src/features/products/identity/identityOutcome.ts`.
- Guards: `identity-resolver-single-seam.test.ts`, `identity-write-seam.test.ts`,
  `identity-outcome-taxonomy.test.ts`.

### Phase 6 — One grammar, one matcher
- `identityCodeCandidates` (TS) and `public.identity_code_candidates` (SQL)
  are line-for-line mirrors, proven against shared vectors
  (`identityCodeVectors.ts`, `supabase/tests/identity_code_candidates_test.sql`).
- GS1 parsing is table-driven in both languages (`aiTable.ts` /
  `gs1_ai_table()`, `parse_gs1_element_string`).
- Offline parity: `resolveProductIdentityOffline` uses the same candidates and
  lifecycle predicate; local SQLite carries `code_norm/status/valid_from/valid_to`.

### Phase 7 — Scanned-token dispatcher
- `classifyScanToken` decides product | location | sscc | opaque | empty before
  any resolver runs; `describeTokenMismatch` is the shared refusal copy and
  never refuses an opaque token.
- Wired into `useWmsIdentityGate` (product) and `BinScanField` (location).
- Fixed a real GS1 bug: a separator following a fixed-length AI dropped the
  tail (lot / serial / expiry) in both parsers.
- Guard: `src/test/inventory/scan-token-dispatch.test.ts`.

### Phase 8 — Supplier identity & discovery (COMPLETE this round)
Database (migration applied 2026-08-05):
- Uniqueness is partitioned by ownership scope: global live codes unique per
  business (`product_identifiers_active_global_code_uidx`), supplier codes
  unique per `(business, supplier, code)`
  (`product_identifiers_active_supplier_code_uidx`). Two vendors may reuse the
  same part number for different goods — previously impossible.
- `upsert_product_identifier` clashes within the SAME scope only, and a
  supplier-scoped code can never become a product's primary label.
- `resolve_product_identity` gained `p_supplier_id`. Global identifiers always
  match; supplier-scoped identifiers match ONLY with supplier context. A live
  code that exists only in another supplier's catalogue returns the new
  blocking status `supplier_scoped` instead of a false "not registered".
- New `discover_supplier_identity(business, code, supplier, purchase_order)` —
  evidence-ranked candidates from open PO lines, the supplier's price list, and
  codes already known for other suppliers. `authenticated`/`service_role` only.

Client:
- `useResolveProductIdentity({ supplierId })` forwards the context and keys its
  LRU cache on it (no cross-vendor cache leakage); `supplier_scoped` mapped.
- `useWmsIdentityGate(businessId, branchId, { supplierId })` forwards it.
- `identityOutcome.ts` gained `supplier_scoped` copy + `link_supplier_code`
  remediation.
- `useSupplierCodeDiscovery` (discover → confirm → link) links only through
  `writeIdentifier` (`kind: "supplier"`, `source: "asn"`); never touches the
  table.
- Receiving: `useReceivingSessionSupplier` resolves the vendor from the
  session's inbound document; `ReceivingSessionWorkspace` passes it to the gate
  and shows `SupplierCodeDiscoveryPanel` when a scan is blocked. Linking does
  not post stock — the operator re-scans.
- Offline: local SQLite carries `supplier_id`; the offline matcher excludes
  supplier-scoped identifiers (a POS lane has no vendor context).

Verification: `tsgo --noEmit` clean; 50 tests green across
`supplier-identity-scope.test.ts` (new), `identity-outcome-taxonomy`,
`scan-token-dispatch`, `identity-write-seam`, `identity-resolver-single-seam`.

---

## Pending

### Phase 9 — Documentation & ADR (ACTIVE NEXT)
1. Write `docs/adr/0110-product-identity-and-resolution.md`: the decision
   envelope, the one grammar, the dispatcher, supplier scoping, and the two
   seams (read/write). Supersede/annotate ADR-0017, ADR-0071, ADR-0089,
   ADR-0102 where they now disagree.
2. Operator documentation: what each blocking outcome means on the dock and in
   POS, and the supplier-code linking flow.
3. SQL parity test for the supplier scope: extend
   `supabase/tests/identity_code_candidates_test.sql` (or add
   `supabase/tests/resolve_product_identity_supplier_scope_test.sql`) with
   vectors for `supplier_scoped`, cross-vendor code reuse and the
   partitioned uniqueness indexes.
4. Architecture guard that no surface calls `resolve_product_identity` with a
   supplier id it did not derive from an inbound document.

### Phase 10 — Backlog (only after Phase 9)
- Supplier code capture at PO/ASN import time (`vendor_product_code` column in
  the supplier pricelist import currently has nowhere to land — it should flow
  into `product_identifiers` as a supplier-scoped code via `writeIdentifier`).
- Returns/RMA scanning parity review against the dispatcher.

---

## Instructions for the next agent

1. **Verify Phase 8 before writing anything new.** Specifically:
   - `tsgo --noEmit -p tsconfig.app.json` is clean and
     `bunx vitest run src/test/inventory src/test/architecture` passes.
   - In the database, confirm both partial unique indexes exist, that
     `resolve_product_identity` has five arguments with `anon` revoked, and that
     `discover_supplier_identity` is `authenticated`-only.
   - Confirm the receiving workspace still captures a normal GTIN scan and that
     a supplier code only resolves while a PO-backed session is open.
2. Then resume at **Phase 9, item 1** (ADR-0110) and work its items in order.
   Do not start Phase 10 until Phase 9 is complete and documented here.
3. Keep this file current: after each implementation, move the work into
   "Completed and verified", restate the active phase, and leave fresh
   instructions in this section.
