# Product Identity Engine — audit verdict and remediation

## What I verified (not assumed)

- The write RPC `upsert_product_identifier` is correct and idempotent. It matches on
  `code_norm + status='active' + supplier scope`, updates in place when an identifier id
  is supplied, returns `idempotent: true` for a repeat of the same code on the same
  product/level, and keeps exactly one primary. It is not the duplicate source.
- `retire_product_identifier` correctly archives (never hard-deletes) and re-promotes a
  primary. It is not the duplicate source either.
- Real data confirms the shape of the corruption: one product has **4 rows for the same
  SKU code, 1 active and 3 archived** (`LMD-LM-300MLS`, kind `sku`). No other duplicate
  group exists in the whole table.

## Root cause (confirmed)

Two independent defects combine:

1. **The SKU/PLU mirror trigger is not idempotent across the lifecycle.**
   `sync_product_identifiers_from_product` fires on every product insert/update of
   `sku`/`plu_code` and inserts a mirror row with
   `ON CONFLICT (business_id, code_norm) WHERE status='active' AND supplier_id IS NULL DO NOTHING`.
   The conflict target only covers **active** rows. Once an operator deletes the mirror in
   the editor (which archives it), the very next product save no longer conflicts, so a
   brand-new active mirror row is inserted. Delete → save → delete → save produces exactly
   the observed growing pile. The mirror is also owned by two writers (the trigger and the
   editor), violating single-owner identity.

2. **Every read model ignores identifier lifecycle.**
   - `ProductIdentifiersEditor` loads `product_identifiers` with no `status` filter.
   - `useProductDetailData` (product overview) selects `*` for the product with no
     `status` filter.
   So archived rows are rendered as if they were live: "deleted identifiers come back" and
   "overview shows many". The resolver path is lifecycle-aware; only the UI reads are not.

Everything else in the identity stack (single resolver seam, decision envelope, supplier
scoping, partial unique indexes, one-primary index, packaging guard) is sound and stays.

## Remediation

### 1. Make the mirror single-owner and idempotent (database)

Rewrite `sync_product_identifiers_from_product` so a mirror is a *reconciliation*, not an
append:

- Look up the existing mirror row for `(product_id, kind, code_norm)` **regardless of
  status**. If found, reactivate it in place (`status='active'`, `valid_to=NULL`) instead
  of inserting a second row.
- Only insert when no row for that product/kind/code has ever existed.
- Respect operator intent: if the mirror was deliberately archived and the product's
  `sku`/`plu_code` has **not** changed in this UPDATE, do nothing — a save must not
  resurrect an identifier the operator retired. Resurrection happens only when the SKU
  value itself is (re)assigned.
- Keep the existing archive-on-SKU-change branch.

### 2. Harden the schema so this class of bug cannot recur

- Add `product_identifiers_product_kind_code_uidx`
  `UNIQUE (product_id, kind, code_norm)` covering **all statuses**. A product can never
  again hold two rows for the same code and kind — active or archived. (Cross-product
  re-issue after archiving still works: that is governed by the existing partial index on
  `business_id, code_norm`.)
- Data repair in the same migration, ordered after the constraint logic: collapse existing
  duplicate groups to one row per `(product_id, kind, code_norm)` — keep the active row if
  present, otherwise the newest, retarget any `replaced_by_id` references, delete the rest.
  This is corruption cleanup performed *with* the source fixed, not instead of it.

### 3. Make read models lifecycle-faithful (frontend)

- `ProductIdentifiersEditor`: load only `status = 'active'` rows, and select `status`
  explicitly so future surfaces can show retired history deliberately.
- `useProductDetailData`: filter identifiers to `status = 'active'` for the overview list.
- Add a small shared selector (`activeIdentifiersQuery`) in
  `src/features/products/identity/` so no surface hand-rolls the lifecycle predicate again.

### 4. Guard tests

- `src/test/architecture/identity-read-lifecycle.test.ts` — repo-wide scan: any query on
  `product_identifiers` in app code must go through the shared selector or carry a status
  predicate.
- SQL test `supabase/tests/product_identifier_mirror_idempotent_test.sql` — inserting a
  product, archiving its SKU mirror, and updating the product N times yields exactly one
  mirror row and does not resurrect the archived one.
- Extend `src/test/inventory/...` with a case asserting a delete → save cycle leaves one
  row.

## Explicitly out of scope

No change to the resolver, the decision envelope, supplier scoping, POS
`pos_resolve_scan`, offline parity, or labelling. Those were audited and are correct;
touching them would add risk without addressing the fault.

## Execution order

1. Migration: rewrite the mirror trigger, add the all-status unique index, repair
   existing duplicates.
2. Frontend read-model fixes + shared selector.
3. Guard tests (SQL + TS) and full test run.
