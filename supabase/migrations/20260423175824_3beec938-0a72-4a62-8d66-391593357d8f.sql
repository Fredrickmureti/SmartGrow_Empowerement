COMMENT ON FUNCTION public.get_sales_dashboard_kpis(uuid, uuid, date, date, uuid) IS 'Sales dashboard KPIs aggregator. Cache-bust 2026-04-23 live fix.';

GRANT EXECUTE ON FUNCTION public.get_sales_dashboard_kpis(uuid, uuid, date, date, uuid) TO authenticated, anon;

NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';