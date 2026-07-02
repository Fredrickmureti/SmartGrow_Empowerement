-- Regression test: ensure there is exactly ONE overload of
-- create_product_with_opening_stock_atomic in the public schema.
--
-- Why this matters:
--   PostgREST cannot disambiguate function overloads when one of them has
--   unnamed arguments (proargnames IS NULL). The frontend posts JSON with
--   named keys (p_product, p_opening_items, p_user_id), but a second
--   overload like (jsonb) with no parameter name makes the route ambiguous
--   and PostgREST returns 404 / PGRST202 ("Could not find the function in
--   the schema cache"). That is the exact failure that broke the
--   Products → Add Item flow.
--
--   Keeping this invariant test in CI prevents anyone from reintroducing a
--   "legacy compatibility shim" overload that would silently break the
--   product creation pipeline again.

BEGIN;

DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
  FROM pg_proc p
  JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND p.proname = 'create_product_with_opening_stock_atomic';

  IF n <> 1 THEN
    RAISE EXCEPTION
      'create_product_with_opening_stock_atomic must have exactly 1 overload, found %', n;
  END IF;
END $$;

ROLLBACK;
