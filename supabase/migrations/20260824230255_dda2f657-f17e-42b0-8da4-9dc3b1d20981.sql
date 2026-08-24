CREATE OR REPLACE FUNCTION public._crm_lead_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_stage_branch uuid;
  v_reason_branch uuid;
  v_found boolean;
BEGIN
  IF NEW.stage_id IS NOT NULL THEN
    SELECT s.branch_id, true INTO v_stage_branch, v_found
      FROM public.crm_stages s
     WHERE s.id = NEW.stage_id AND s.business_id = NEW.business_id;
    IF NOT coalesce(v_found, false) THEN
      RAISE EXCEPTION 'CRM: stage % does not belong to business %', NEW.stage_id, NEW.business_id
        USING ERRCODE = '23514';
    END IF;
    IF v_stage_branch IS NOT NULL AND v_stage_branch IS DISTINCT FROM NEW.branch_id THEN
      RAISE EXCEPTION 'CRM: stage % belongs to branch %, not the lead branch %',
        NEW.stage_id, v_stage_branch, NEW.branch_id USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.lost_reason_id IS NOT NULL THEN
    v_found := NULL;
    SELECT r.branch_id, true INTO v_reason_branch, v_found
      FROM public.crm_lost_reasons r
     WHERE r.id = NEW.lost_reason_id AND r.business_id = NEW.business_id;
    IF NOT coalesce(v_found, false) THEN
      RAISE EXCEPTION 'CRM: lost reason % does not belong to business %', NEW.lost_reason_id, NEW.business_id
        USING ERRCODE = '23514';
    END IF;
    IF v_reason_branch IS NOT NULL AND v_reason_branch IS DISTINCT FROM NEW.branch_id THEN
      RAISE EXCEPTION 'CRM: lost reason % belongs to branch %, not the lead branch %',
        NEW.lost_reason_id, v_reason_branch, NEW.branch_id USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.contact_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.contacts c
        WHERE c.id = NEW.contact_id AND c.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'CRM: contact % does not belong to business %', NEW.contact_id, NEW.business_id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.company_contact_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.contacts c
        WHERE c.id = NEW.company_contact_id AND c.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'CRM: company contact % does not belong to business %',
      NEW.company_contact_id, NEW.business_id USING ERRCODE = '23514';
  END IF;

  IF NEW.assigned_to IS NOT NULL
     AND NEW.assigned_to IS DISTINCT FROM coalesce(OLD.assigned_to, '00000000-0000-0000-0000-000000000000'::uuid)
     AND NOT public.user_can_access_business(NEW.assigned_to, NEW.business_id) THEN
    RAISE EXCEPTION 'CRM: assignee % is not a member of business %', NEW.assigned_to, NEW.business_id
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;