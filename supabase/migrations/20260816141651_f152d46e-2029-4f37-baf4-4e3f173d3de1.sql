-- ============================================================================
-- Landed Cost — Phase E: one server-side workspace summary
-- The workbench previously summed a 500-row page in the browser, so the KPIs
-- and the bucket counts silently under-reported past that page and constituted
-- a second landed-cost total. This is a set-based aggregate over every voucher.
-- Invoker rights (STABLE, no SECURITY DEFINER), exactly like
-- landed_cost_clearing_exposure, so RLS on landed_cost_vouchers scopes it.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.landed_cost_workspace_summary(p_business_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH v AS (
    SELECT status::text AS status,
           COALESCE(total_base_amount, 0) AS base_amount,
           COALESCE(capitalized_amount, 0) AS capitalized,
           COALESCE(expensed_amount, 0)    AS expensed
      FROM public.landed_cost_vouchers
     WHERE business_id = p_business_id
  )
  SELECT jsonb_build_object(
    'capture_count',      count(*) FILTER (WHERE status IN ('draft', 'pending_approval')),
    'allocated_count',    count(*) FILTER (WHERE status = 'allocated'),
    'posted_count',       count(*) FILTER (WHERE status = 'posted'),
    'closed_count',       count(*) FILTER (WHERE status IN ('reversed', 'cancelled')),
    'total_count',        count(*),
    'unposted_amount',    COALESCE(SUM(base_amount) FILTER (WHERE status IN ('draft', 'pending_approval', 'allocated')), 0),
    'capitalized_amount', COALESCE(SUM(capitalized) FILTER (WHERE status = 'posted'), 0),
    'expensed_amount',    COALESCE(SUM(expensed)    FILTER (WHERE status = 'posted'), 0),
    'by_status',          COALESCE((SELECT jsonb_object_agg(status, jsonb_build_object(
                                              'count', n, 'base_amount', amt))
                                      FROM (SELECT status, count(*) AS n, SUM(base_amount) AS amt
                                              FROM v GROUP BY status) s), '{}'::jsonb))
  FROM v;
$function$;

REVOKE ALL ON FUNCTION public.landed_cost_workspace_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landed_cost_workspace_summary(uuid) TO authenticated, service_role;