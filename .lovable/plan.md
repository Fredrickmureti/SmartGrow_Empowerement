# Product Identifier (Barcode) Edit Failure — Diagnosis and Permanent Fix

## 1. Root cause (VERIFIED)

Retiring a barcode does not delete the row — it sets `status = 'archived'` and keeps the code. But one of the uniqueness rules on `product_identifiers` ignores status entirely:

```text
product_identifiers_active_global_code_uidx   (business_id, code_norm)              WHERE status='active' AND supplier_id IS NULL
product_identifiers_active_supplier_code_uidx (business_id, supplier_id, code_norm)  WHERE status='active' AND supplier_id IS NOT NULL
product_identifiers_product_kind_code_uidx    (product_id, kind, code_norm)          <-- NO status filter
```

The last index treats a retired code as if it were still live. So once a code has ever been used on a product, that product can never carry it again.

Confirmed on the product from the reported error (`02882a56…`): all three of its identifiers are `archived`, including gtin `5164407725074` and gtin `6164001199034`. Re-scanning either of those codes onto that product — or renaming a live row to one of them — hits the status-blind index.

The RPC compounds this. `upsert_product_identifier` pre-checks for clashes only among `status='active'` rows, so it sees no conflict, proceeds to INSERT/UPDATE, and the index raises `unique_violation` (SQLSTATE 23505) with no handler. An unhandled exception in a PostgREST RPC surfaces as **HTTP 409** — that is exactly the 409 in the console. The client (`writeIdentifier.ts`) maps any transport error to the generic "could not be saved" text, so the real cause is invisible to the user.

Second defect in the same flow: the "delete then re-add" path archives the old row and then **inserts a brand new row** instead of reviving the archived one. That is why this product has three archived rows and zero live ones — history is accumulating landmines, each of which blocks its own code from ever returning.

## 2. Secondary root cause — the 400 (VERIFIED)

`src/hooks/inventory/useProductDetailData.ts` queries:

```text
product_reorder_rules?select=*,warehouses!inner(name,branch_id)&…&warehouses.branch_id=eq.…
```

`product_reorder_rules` has **no** `warehouse_id` column and no foreign key to `warehouses`. Its columns include `branch_id` (FK to `branches`) — reorder rules are branch-scoped, not warehouse-scoped. PostgREST cannot resolve the embedded relationship, so it rejects the request with 400. Independent defect, unrelated to the barcode save; it just runs on the same screen. The neighbouring `warehouse_stock_lots` query in the same function is correct — that table does relate to `warehouses`.

## 3. Lifecycle and the break point

```text
Editor row  -> persistRow / commit -> writeIdentifier -> upsert_product_identifier
                                                            |
                                    active-only clash pre-check passes
                                                            |
                                    INSERT/UPDATE -> product_identifiers_product_kind_code_uidx
                                                            |
                                              23505 unhandled -> 409  <== BREAK
```

Delete path: `deleteRow` -> `retire_product_identifier` -> row archived, code retained -> next add of the same code hits the same break.

## 4. Intended invariants

- A product may hold many identifiers of different kinds (gtin, sku, pack, supplier, plu, internal, alias) — the model is already multi-identifier and stays that way.
- A live code is unique per business (and per supplier for supplier codes). Unchanged — the two active-scoped indexes are correct.
- A **retired** code is history. It must not reserve the code against anyone, including the product that once held it.
- Re-adding a code a product previously carried revives that row rather than creating a duplicate lineage.
- No database exception may escape the RPC as a raw HTTP status; every outcome is a typed envelope.

## 5. Plan

**A. Migration — make the product-level index status-aware**
- Recreate `product_identifiers_product_kind_code_uidx` as a partial unique index with `WHERE status = 'active'`.
- Pre-flight the data: report any group of *active* rows sharing `(product_id, kind, code_norm)` before creating the index. Current data has none for the reported product; the migration will fail loudly rather than silently drop protection if any exist elsewhere.
- Business-scope uniqueness is untouched, so cross-product duplicates remain rejected.

**B. RPC — `upsert_product_identifier` correctness**
- Before inserting, look for an archived/inactive row on the same `(product_id, kind, code_norm)` and revive it (status active, refreshed packaging/supplier/source/validity) instead of inserting a second row. Returns `status: 'ok'` with `revived: true`.
- Wrap the INSERT/UPDATE in an `EXCEPTION WHEN unique_violation` handler that resolves the winning row and returns the existing `status: 'duplicate'` envelope with the conflicting product name — never an unhandled 409.
- Same treatment on the UPDATE branch (renaming a live row onto a code held elsewhere).
- `retire_product_identifier` keeps archiving; no delete semantics introduced.

**C. Client**
- `writeIdentifier.ts`: distinguish an RPC transport error from a domain envelope, and surface `revived` as success. Add a reason string for `code_taken` on the same product so the message is specific.

**D. The 400**
- `useProductDetailData.ts`: drop the invalid `warehouses!inner(...)` embed on `product_reorder_rules` and filter on the table's own `branch_id` column when a branch is selected.

**E. Tests**
- SQL suite `supabase/tests/product_identifier_lifecycle_test.sql` proving, in a rolled-back transaction: create; edit A→B; retire; re-add the retired code (revive, one row not two); retire-then-add-a-different-code; cross-product duplicate rejected as `duplicate`, never 409; supplier-scoped code allowed alongside a global one; repeated identical save is idempotent; concurrent same-code inserts leave exactly one active row; a live rename onto another product's code returns `duplicate`.
- Vitest guard asserting no client code embeds `warehouses` on `product_reorder_rules`, and that identifier writes go only through the RPC seam.
- Verify POS/inventory lookup paths still read `status='active'` only (`activeIdentifiers.ts`, `resolve_product_identity`) so reviving does not change resolution semantics.

## 6. Consumers checked before the change

`resolve_product_identity` (POS scan, receiving, product search), `activeIdentifiersForProduct`, label printing/ZPL builder, supplier-code discovery, product import. All filter on `status`, and all key off `product_id` or the code value — none reference the index being altered, and none see behaviour change other than a retired code becoming re-issuable.

## 7. Out of scope

No change to business-level uniqueness, to the supplier-code scope, to normalization (`code_norm` stays `upper(btrim(code))`, leading zeroes preserved), or to the retire-not-delete policy.
