-- Regression guard for the 42P10 ON CONFLICT bug in ProductIdentifiersEditor.
-- The editor upserts with onConflict="business_id,code_norm,kind" which only
-- works if there is a plain (non-expression) unique constraint covering
-- exactly those columns. If a future migration reverts to an expression
-- index on lower(code), this test fails BEFORE the user hits a 400.

BEGIN;
SELECT plan(3);

SELECT has_column('public', 'product_identifiers', 'code_norm',
  'product_identifiers.code_norm generated column must exist');

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.product_identifiers'::regclass
      AND conname  = 'product_identifiers_business_code_norm_kind_key'
      AND contype  = 'u'
  ),
  'plain UNIQUE (business_id, code_norm, kind) must exist for PostgREST on_conflict'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename  = 'product_identifiers'
      AND indexdef ILIKE '%lower(code)%'
  ),
  'no expression index on lower(code) — those break on_conflict by column name'
);

SELECT * FROM finish();
ROLLBACK;
