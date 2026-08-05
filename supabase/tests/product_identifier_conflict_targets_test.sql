-- Regression guard for the 42P10 that broke ALL product creation.
--
-- Phase D replaced the plain UNIQUE (business_id, code_norm, kind) on
-- product_identifiers with lifecycle-aware PARTIAL unique indexes. Anything
-- that still writes `ON CONFLICT (business_id, code_norm)` without the
-- matching predicate raises 42P10 at runtime, which aborted the whole
-- INSERT INTO products (the SKU sync trigger fires on every product insert).
--
-- This test pins both halves of the contract: the partial indexes exist,
-- and no function targets a conflict spec that no index can satisfy.

BEGIN;
SELECT plan(4);

SELECT has_column('public', 'product_identifiers', 'code_norm',
  'product_identifiers.code_norm generated column must exist');

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename  = 'product_identifiers'
      AND indexname  = 'product_identifiers_active_global_code_uidx'
  ),
  'partial unique index on (business_id, code_norm) for active non-supplier codes must exist'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename  = 'product_identifiers'
      AND indexname  = 'product_identifiers_active_supplier_code_uidx'
  ),
  'partial unique index on (business_id, supplier_id, code_norm) for supplier codes must exist'
);

-- Any ON CONFLICT on (business_id, code_norm) must carry the index predicate.
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND pg_get_functiondef(p.oid) ~* 'on conflict\s*\(\s*business_id\s*,\s*code_norm\s*\)\s*do'
  ),
  'no function may use ON CONFLICT (business_id, code_norm) without the WHERE predicate — that spec matches no index (42P10)'
);

SELECT * FROM finish();
ROLLBACK;