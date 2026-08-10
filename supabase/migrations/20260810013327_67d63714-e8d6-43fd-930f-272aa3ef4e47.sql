-- 1. Tie-out drift sensor must be readable by any reporting role.
GRANT EXECUTE ON FUNCTION public.is_ap_control_account(uuid) TO PUBLIC;

-- 2. One statement per (business, branch, contact, period).
CREATE UNIQUE INDEX IF NOT EXISTS customer_statements_one_per_period
  ON public.customer_statements (
    business_id,
    COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
    contact_id,
    period_start,
    period_end
  );

-- 3. Single idempotent writer. Regenerating the same period refreshes the
--    existing snapshot instead of inserting a duplicate.
CREATE OR REPLACE FUNCTION public.upsert_customer_statement_atomic(_payload jsonb)
RETURNS public.customer_statements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org       uuid := NULLIF(_payload->>'organization_id','')::uuid;
  v_business  uuid := NULLIF(_payload->>'business_id','')::uuid;
  v_branch    uuid := NULLIF(_payload->>'branch_id','')::uuid;
  v_contact   uuid := NULLIF(_payload->>'contact_id','')::uuid;
  v_row       public.customer_statements;
BEGIN
  IF v_org IS NULL OR v_business IS NULL OR v_contact IS NULL THEN
    RAISE EXCEPTION 'organization_id, business_id and contact_id are required';
  END IF;
  IF NOT public.is_org_member(auth.uid(), v_org) THEN
    RAISE EXCEPTION 'Not a member of this organization';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.contacts c
     WHERE c.id = v_contact AND c.organization_id = v_org AND c.business_id = v_business
  ) THEN
    RAISE EXCEPTION 'Contact does not belong to this business';
  END IF;

  INSERT INTO public.customer_statements (
    organization_id, business_id, branch_id, contact_id,
    statement_date, period_start, period_end,
    opening_balance, total_invoiced, total_payments, closing_balance,
    created_by
  ) VALUES (
    v_org, v_business, v_branch, v_contact,
    COALESCE(NULLIF(_payload->>'statement_date','')::date, CURRENT_DATE),
    (_payload->>'period_start')::date,
    (_payload->>'period_end')::date,
    COALESCE((_payload->>'opening_balance')::numeric, 0),
    COALESCE((_payload->>'total_invoiced')::numeric, 0),
    COALESCE((_payload->>'total_payments')::numeric, 0),
    COALESCE((_payload->>'closing_balance')::numeric, 0),
    auth.uid()
  )
  ON CONFLICT (business_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), contact_id, period_start, period_end)
  DO UPDATE SET
    statement_date  = EXCLUDED.statement_date,
    opening_balance = EXCLUDED.opening_balance,
    total_invoiced  = EXCLUDED.total_invoiced,
    total_payments  = EXCLUDED.total_payments,
    closing_balance = EXCLUDED.closing_balance
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_customer_statement_atomic(jsonb) TO authenticated, service_role;