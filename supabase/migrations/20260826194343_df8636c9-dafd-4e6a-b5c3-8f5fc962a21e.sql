-- B0-1: one server-side definition of "revenue and expenses for a period".
-- Previously fetchGLTotals.ts re-derived this in JavaScript (account-type lookup
-- plus sign handling), which is a second source of accounting truth. This function
-- computes it from the authoritative get_account_movements RPC, using the same
-- normal-balance convention as the reporting kernel: income is credit-normal,
-- expenses are debit-normal.
CREATE OR REPLACE FUNCTION public.get_gl_pnl_totals(
  _org_id uuid,
  _date_from date,
  _date_to date,
  _business_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL
)
RETURNS TABLE(revenue numeric, expenses numeric, net_profit numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  WITH movements AS (
    SELECT mv.account_id, mv.total_debit, mv.total_credit
      FROM public.get_account_movements(_org_id, _date_from, _date_to, _business_id, _branch_id) mv
  ),
  classified AS (
    SELECT a.account_type,
           COALESCE(mv.total_debit, 0)  AS total_debit,
           COALESCE(mv.total_credit, 0) AS total_credit
      FROM movements mv
      JOIN public.accounts a ON a.id = mv.account_id
     WHERE a.organization_id = _org_id
       AND a.account_type IN ('income'::public.account_type, 'expense'::public.account_type)
  ),
  totals AS (
    SELECT
      COALESCE(SUM(CASE WHEN account_type = 'income'::public.account_type
                        THEN total_credit - total_debit END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN account_type = 'expense'::public.account_type
                        THEN total_debit - total_credit END), 0) AS expenses
      FROM classified
  )
  SELECT revenue, expenses, revenue - expenses FROM totals;
$$;

REVOKE ALL ON FUNCTION public.get_gl_pnl_totals(uuid, date, date, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_gl_pnl_totals(uuid, date, date, uuid, uuid) TO authenticated, service_role;