-- Phase E — read-only diagnostic exposing rows on branch-scoped tables
-- whose branch_id IS NULL on a multi-branch tenant. These rows are
-- effectively company-wide and become visible to every branch via the
-- standard applyBranchFilter convention (branch_id IS NULL always passes).
-- The diagnostic is intentionally read-only — remediation is a separate,
-- per-tenant migration.

CREATE OR REPLACE VIEW public.branch_null_diagnostic AS
SELECT 'invoices'::text         AS table_name, organization_id, business_id, id AS row_id, created_at FROM public.invoices         WHERE branch_id IS NULL
UNION ALL
SELECT 'sales_orders'::text     AS table_name, organization_id, business_id, id AS row_id, created_at FROM public.sales_orders     WHERE branch_id IS NULL
UNION ALL
SELECT 'deliveries'::text       AS table_name, organization_id, business_id, id AS row_id, created_at FROM public.deliveries       WHERE branch_id IS NULL
UNION ALL
SELECT 'payments'::text         AS table_name, organization_id, business_id, id AS row_id, created_at FROM public.payments         WHERE branch_id IS NULL
UNION ALL
SELECT 'bills'::text            AS table_name, organization_id, business_id, id AS row_id, created_at FROM public.bills            WHERE branch_id IS NULL
UNION ALL
SELECT 'journal_entries'::text  AS table_name, organization_id, business_id, id AS row_id, created_at FROM public.journal_entries  WHERE branch_id IS NULL
UNION ALL
SELECT 'pos_transactions'::text AS table_name, organization_id, business_id, id AS row_id, created_at FROM public.pos_transactions WHERE branch_id IS NULL
UNION ALL
SELECT 'bank_accounts'::text    AS table_name, organization_id, business_id, id AS row_id, created_at FROM public.bank_accounts    WHERE branch_id IS NULL;

GRANT SELECT ON public.branch_null_diagnostic TO authenticated;
GRANT SELECT ON public.branch_null_diagnostic TO service_role;

CREATE OR REPLACE FUNCTION public.branch_null_diagnostic_counts(_organization_id uuid)
RETURNS TABLE(table_name text, row_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT v.table_name, count(*)::bigint
  FROM public.branch_null_diagnostic v
  WHERE v.organization_id = _organization_id
    AND public.has_role(auth.uid(), 'admin')
  GROUP BY v.table_name
  ORDER BY v.table_name
$$;

CREATE OR REPLACE FUNCTION public.branch_null_diagnostic_rows(_organization_id uuid, _table text)
RETURNS TABLE(table_name text, organization_id uuid, business_id uuid, row_id uuid, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT v.table_name, v.organization_id, v.business_id, v.row_id, v.created_at
  FROM public.branch_null_diagnostic v
  WHERE v.organization_id = _organization_id
    AND v.table_name = _table
    AND public.has_role(auth.uid(), 'admin')
  ORDER BY v.created_at DESC
  LIMIT 500
$$;

GRANT EXECUTE ON FUNCTION public.branch_null_diagnostic_counts(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.branch_null_diagnostic_rows(uuid, text) TO authenticated;
