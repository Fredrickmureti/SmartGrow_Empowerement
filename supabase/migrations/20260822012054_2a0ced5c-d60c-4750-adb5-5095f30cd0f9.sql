CREATE OR REPLACE FUNCTION public.finance_ar_customer_credit_as_of(_org_id uuid, _business_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid, _as_of date DEFAULT CURRENT_DATE)
 RETURNS TABLE(organization_id uuid, business_id uuid, branch_id uuid, contact_id uuid, currency text, credit_amount numeric, base_credit_amount numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH movements AS (
    -- Sign convention is fixed by _ccm_project_balance: 'issue' increases the
    -- customer's credit, every other kind (apply/refund/expire) consumes it.
    -- ADR 0136: never assume a denomination — fall back to the business base
    -- currency, and to NULL (an absence) when the business has none.
    SELECT m.organization_id,
           m.business_id,
           m.contact_id,
           COALESCE(NULLIF(m.currency, ''), biz.base_currency) AS currency,
           SUM(CASE WHEN m.kind = 'issue' THEN m.amount ELSE -m.amount END)::numeric AS balance
      FROM public.customer_credit_movements m
      LEFT JOIN public.businesses biz ON biz.id = m.business_id
     WHERE m.organization_id = _org_id
       AND (_business_id IS NULL OR m.business_id = _business_id)
       AND (_branch_id IS NULL OR m.branch_id = _branch_id)
       AND m.created_at::date <= _as_of
     GROUP BY m.organization_id, m.business_id, m.contact_id,
              COALESCE(NULLIF(m.currency, ''), biz.base_currency)
  )
  SELECT mv.organization_id,
         mv.business_id,
         NULL::uuid AS branch_id,
         mv.contact_id,
         mv.currency,
         mv.balance::numeric(14,2) AS credit_amount,
         (CASE WHEN mv.currency IS NULL THEN NULL
               ELSE public.to_base_amount(mv.business_id, mv.currency, mv.balance, _as_of)
          END)::numeric(14,2) AS base_credit_amount
    FROM movements mv
   WHERE mv.balance > 0.01;
END;
$function$;