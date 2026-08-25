DROP FUNCTION IF EXISTS public.project_analytic_reconciliation(uuid, date, date);

CREATE OR REPLACE FUNCTION public.project_analytic_reconciliation(
  p_business_id uuid,
  p_date_from date,
  p_date_to date
)
RETURNS TABLE(
  project_id uuid,
  project_number text,
  project_name text,
  analytic_account_id uuid,
  gl_analytic_net numeric,
  project_ledger_cost numeric,
  project_ledger_revenue numeric,
  project_ledger_net numeric,
  difference numeric,
  unconverted_entry_count integer
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT p.id,
         p.project_number,
         p.name,
         p.analytic_account_id,
         COALESCE(gl.net, 0),
         COALESCE(c.cost, 0),
         COALESCE(r.revenue, 0),
         COALESCE(c.cost, 0) - COALESCE(r.revenue, 0),
         COALESCE(gl.net, 0) - (COALESCE(c.cost, 0) - COALESCE(r.revenue, 0)),
         (COALESCE(c.unconverted, 0) + COALESCE(r.unconverted, 0))::int
    FROM public.projects p
    LEFT JOIN LATERAL (
      SELECT SUM(a.amount) AS net
        FROM public.journal_entry_line_analytics a
        JOIN public.journal_entries je ON je.id = a.journal_entry_id
       WHERE a.analytic_account_id = p.analytic_account_id
         AND a.entry_date BETWEEN p_date_from AND p_date_to
         AND je.status IN ('posted', 'reversed')
    ) gl ON true
    LEFT JOIN LATERAL (
      -- Actuals only, in base currency. Commitments (PO/SO) never hit the GL,
      -- and unconvertible rows are surfaced instead of being counted at 1:1.
      SELECT SUM(pc.amount_base) AS cost,
             COUNT(*) FILTER (WHERE pc.amount_base IS NULL) AS unconverted
        FROM public.project_cost_entries pc
       WHERE pc.project_id = p.id
         AND pc.entry_nature = 'actual'
         AND pc.posted_at::date BETWEEN p_date_from AND p_date_to
    ) c ON true
    LEFT JOIN LATERAL (
      SELECT SUM(pr.amount_base) AS revenue,
             COUNT(*) FILTER (WHERE pr.amount_base IS NULL) AS unconverted
        FROM public.project_revenue_entries pr
       WHERE pr.project_id = p.id
         AND pr.entry_nature = 'actual'
         AND pr.posted_at::date BETWEEN p_date_from AND p_date_to
    ) r ON true
   WHERE p.business_id = p_business_id
     AND public.user_can_access_business(auth.uid(), p_business_id)
     AND public.user_has_module_permission(auth.uid(), p.organization_id, p.business_id, 'financials', 'read')
   ORDER BY p.project_number NULLS LAST, p.name;
$function$;

REVOKE ALL ON FUNCTION public.project_analytic_reconciliation(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.project_analytic_reconciliation(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.project_analytic_reconciliation(uuid, date, date) TO service_role;