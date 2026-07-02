-- Collapse create_product_with_opening_stock_atomic to a single canonical overload.
-- The unnamed-arg (jsonb) shim was a legacy forwarder; its lack of parameter
-- names makes PostgREST unable to disambiguate overloads, returning 404/PGRST202
-- on every call from the frontend.

DROP FUNCTION IF EXISTS public.create_product_with_opening_stock_atomic(jsonb);

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
  FROM pg_proc p
  JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND p.proname = 'create_product_with_opening_stock_atomic';
  IF n <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one overload of create_product_with_opening_stock_atomic, found %', n;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';