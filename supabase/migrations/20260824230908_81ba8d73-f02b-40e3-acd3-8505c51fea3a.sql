CREATE OR REPLACE FUNCTION public._crm_lead_lifecycle_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_rpc boolean := coalesce(current_setting('app.crm_lead_writer', true), '') = '1';
BEGIN
  IF v_rpc THEN
    RETURN NEW;
  END IF;

  IF NEW.status     IS DISTINCT FROM OLD.status
  OR NEW.stage_id   IS DISTINCT FROM OLD.stage_id
  OR NEW.won_at     IS DISTINCT FROM OLD.won_at
  OR NEW.lost_at    IS DISTINCT FROM OLD.lost_at
  OR NEW.probability IS DISTINCT FROM OLD.probability
  OR NEW.is_active  IS DISTINCT FROM OLD.is_active
  OR NEW.type       IS DISTINCT FROM OLD.type
  OR NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
  OR NEW.branch_id  IS DISTINCT FROM OLD.branch_id
  OR NEW.lost_reason_id IS DISTINCT FROM OLD.lost_reason_id THEN
    RAISE EXCEPTION
      'CRM: lifecycle fields must be changed through the crm_* transition functions'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.status IN ('won','lost') AND (
       NEW.expected_revenue   IS DISTINCT FROM OLD.expected_revenue
    OR NEW.contact_id         IS DISTINCT FROM OLD.contact_id
    OR NEW.company_contact_id IS DISTINCT FROM OLD.company_contact_id
    OR NEW.business_id        IS DISTINCT FROM OLD.business_id) THEN
    RAISE EXCEPTION
      'CRM: lead % is % — reopen it before changing value, customer or business', OLD.id, OLD.status
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.crm_transfer_lead_branch(p_lead_id uuid, p_branch_id uuid, p_reason text DEFAULT NULL)
RETURNS crm_leads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_lead public.crm_leads%ROWTYPE;
  v_out  public.crm_leads%ROWTYPE;
  v_branch_business uuid;
  v_branch_active boolean;
  v_stage_branch uuid;
  v_new_stage uuid;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'update');

  IF v_lead.status IN ('won','lost') THEN
    RAISE EXCEPTION 'CRM: lead % is % — reopen it before transferring branch', p_lead_id, v_lead.status
      USING ERRCODE = '42501';
  END IF;

  IF p_branch_id IS NULL THEN
    RAISE EXCEPTION 'CRM: a target branch is required' USING ERRCODE = '22004';
  END IF;

  SELECT b.business_id, coalesce(b.is_active, true) INTO v_branch_business, v_branch_active
    FROM public.branches b WHERE b.id = p_branch_id;
  IF v_branch_business IS NULL THEN
    RAISE EXCEPTION 'CRM: branch % not found', p_branch_id USING ERRCODE = '23503';
  END IF;
  IF v_branch_business <> v_lead.business_id THEN
    RAISE EXCEPTION 'CRM: branch % belongs to another business', p_branch_id USING ERRCODE = '23514';
  END IF;
  IF NOT v_branch_active THEN
    RAISE EXCEPTION 'CRM: branch % is inactive', p_branch_id USING ERRCODE = '23514';
  END IF;

  IF NOT public.user_can_access_branch(auth.uid(), p_branch_id)
     AND NOT public.has_finance_permission(auth.uid(), 'finance.view_consolidated', v_lead.business_id) THEN
    RAISE EXCEPTION 'CRM: no access to target branch %', p_branch_id USING ERRCODE = '42501';
  END IF;

  IF v_lead.branch_id IS NOT DISTINCT FROM p_branch_id THEN
    RETURN v_lead;
  END IF;

  v_new_stage := v_lead.stage_id;
  IF v_lead.stage_id IS NOT NULL THEN
    SELECT s.branch_id INTO v_stage_branch FROM public.crm_stages s WHERE s.id = v_lead.stage_id;
    IF v_stage_branch IS NOT NULL AND v_stage_branch IS DISTINCT FROM p_branch_id THEN
      SELECT s.id INTO v_new_stage
        FROM public.crm_stages s
       WHERE s.business_id = v_lead.business_id
         AND coalesce(s.is_active, true)
         AND coalesce(s.is_won, false) = false
         AND coalesce(s.is_lost, false) = false
         AND (s.branch_id IS NULL OR s.branch_id = p_branch_id)
       ORDER BY s.sequence ASC
       LIMIT 1;
      IF v_new_stage IS NULL THEN
        RAISE EXCEPTION 'CRM: branch % has no usable pipeline stage', p_branch_id USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  PERFORM set_config('app.crm_lead_reason', coalesce(p_reason, ''), true);
  PERFORM set_config('app.crm_lead_writer', '1', true);
  UPDATE public.crm_leads
     SET branch_id = p_branch_id,
         stage_id  = v_new_stage,
         updated_at = now()
   WHERE id = p_lead_id
   RETURNING * INTO v_out;
  PERFORM set_config('app.crm_lead_writer', '0', true);
  PERFORM set_config('app.crm_lead_reason', '', true);

  UPDATE public.crm_activities SET branch_id = p_branch_id WHERE lead_id = p_lead_id;

  PERFORM public._crm_log_system_activity(v_out, 'Lead transferred to another branch');
  RETURN v_out;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.crm_transfer_lead_branch(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_transfer_lead_branch(uuid, uuid, text) TO authenticated;