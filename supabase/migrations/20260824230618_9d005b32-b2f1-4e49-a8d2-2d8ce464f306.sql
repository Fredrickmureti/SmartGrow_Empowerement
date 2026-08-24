CREATE OR REPLACE FUNCTION public._crm_assert_lead_access(p_lead_id uuid, p_operation text)
RETURNS crm_leads
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_lead public.crm_leads%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'CRM: authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_lead FROM public.crm_leads WHERE crm_leads.id = p_lead_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead % not found', p_lead_id USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.user_can_access_business(auth.uid(), v_lead.business_id) THEN
    RAISE EXCEPTION 'CRM: not a member of the business owning lead %', p_lead_id
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_module_permission(
            auth.uid(), v_lead.organization_id, v_lead.business_id,
            'sales', p_operation) THEN
    RAISE EXCEPTION 'CRM: missing sales.% permission', p_operation
      USING ERRCODE = '42501';
  END IF;

  IF v_lead.branch_id IS NOT NULL
     AND NOT public.user_can_access_branch(auth.uid(), v_lead.branch_id)
     AND NOT public.has_finance_permission(auth.uid(), 'finance.view_consolidated', v_lead.business_id) THEN
    RAISE EXCEPTION 'CRM: no access to branch % of lead %', v_lead.branch_id, p_lead_id
      USING ERRCODE = '42501';
  END IF;

  RETURN v_lead;
END;
$function$;