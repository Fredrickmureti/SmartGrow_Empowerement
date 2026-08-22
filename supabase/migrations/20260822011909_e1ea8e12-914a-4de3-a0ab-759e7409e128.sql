DROP FUNCTION IF EXISTS public.finance_ar_aging_reconciliation(uuid, uuid, uuid, date);

CREATE OR REPLACE FUNCTION public.finance_ar_aging_reconciliation(_org_id uuid, _business_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid, _as_of date DEFAULT CURRENT_DATE)
 RETURNS TABLE(aging_total numeric, control_account_balance numeric, variance numeric, in_balance boolean, unconvertible_document_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH aging AS (
    -- ADR 0136: a tie-out cannot be asserted over an incomplete population.
    SELECT (CASE WHEN COUNT(*) FILTER (WHERE o.base_residual_amount IS NULL) > 0
                 THEN NULL ELSE COALESCE(SUM(o.base_residual_amount), 0) END)::numeric AS amt,
           COUNT(*) FILTER (WHERE o.base_residual_amount IS NULL)::int AS unconvertible
      FROM public.finance_ar_open_items_as_of(_org_id, _business_id, _branch_id, _as_of) o
  ),
  credits AS (
    SELECT (CASE WHEN COUNT(*) FILTER (WHERE c.base_credit_amount IS NULL) > 0
                 THEN NULL ELSE COALESCE(SUM(c.base_credit_amount), 0) END)::numeric AS amt,
           COUNT(*) FILTER (WHERE c.base_credit_amount IS NULL)::int AS unconvertible
      FROM public.finance_ar_customer_credit_as_of(_org_id, _business_id, _branch_id, _as_of) c
  ),
  control AS (
    -- AR is a debit-balance control account: debit - credit (AP is the reverse).
    SELECT COALESCE(SUM(s.debit - s.credit), 0)::numeric AS amt
      FROM public.ar_subledger_entries s
     WHERE s.organization_id = _org_id
       AND (_business_id IS NULL OR s.business_id = _business_id)
       AND (_branch_id IS NULL OR s.branch_id = _branch_id)
       AND s.entry_date <= _as_of
  )
  SELECT
    ((SELECT amt FROM aging) - (SELECT amt FROM credits))::numeric(14,2),
    (SELECT amt FROM control)::numeric(14,2),
    (((SELECT amt FROM aging) - (SELECT amt FROM credits)) - (SELECT amt FROM control))::numeric(14,2),
    COALESCE(
      ABS(((SELECT amt FROM aging) - (SELECT amt FROM credits)) - (SELECT amt FROM control)) <= 0.01,
      false),
    ((SELECT unconvertible FROM aging) + (SELECT unconvertible FROM credits))::int;
END;
$function$;

REVOKE ALL ON FUNCTION public.finance_ar_aging_reconciliation(uuid, uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_ar_aging_reconciliation(uuid, uuid, uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finance_ar_aging_reconciliation(uuid, uuid, uuid, date) TO service_role;