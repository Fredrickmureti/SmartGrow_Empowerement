CREATE OR REPLACE FUNCTION public.check_valuation_writer_coverage()
RETURNS TABLE (issue text, function_name text, detail text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 'unregistered_valuation_writer'::text,
         p.proname::text,
         'writes AVCO or cost layers but is absent from inventory_valuation_writers'::text
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND (
       p.prosrc ~* 'update\s+(public\.)?warehouse_stock[\s\S]{0,200}average_cost'
       OR p.prosrc ~* 'update\s+(public\.)?products[\s\S]{0,200}cost_price'
       OR p.prosrc ~* '(insert\s+into|update)\s+(public\.)?cost_layers'
     )
     AND p.proname NOT IN (SELECT w.function_name FROM public.inventory_valuation_writers w)
     AND p.proname NOT IN ('check_valuation_writer_coverage', 'check_inventory_valuation_drift',
                           'enforce_valuation_write_authority')
  UNION ALL
  SELECT 'stale_registration'::text,
         w.function_name,
         'registered valuation writer no longer exists in the database'::text
    FROM public.inventory_valuation_writers w
   WHERE NOT EXISTS (
           SELECT 1 FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = w.function_name
         );
$$;

GRANT EXECUTE ON FUNCTION public.check_valuation_writer_coverage() TO authenticated, service_role;