-- Force PostgREST to re-read schema by touching the function's COMMENT (bumps catalog)
COMMENT ON FUNCTION public.get_sales_dashboard_kpis(uuid, uuid, date, date) IS 'Sales dashboard KPIs aggregator. Cache-bust 2026-04-17.';

-- Re-grant to be safe
GRANT EXECUTE ON FUNCTION public.get_sales_dashboard_kpis(uuid, uuid, date, date) TO authenticated, anon;

-- Notify PostgREST to reload its schema cache (config + schema)
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';