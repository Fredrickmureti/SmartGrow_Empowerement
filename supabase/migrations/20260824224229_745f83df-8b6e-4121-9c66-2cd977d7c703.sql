CREATE OR REPLACE FUNCTION public.crm_mark_lost(p_lead_id uuid, p_reason_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS crm_leads
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE; v_stage uuid; v_reason text;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'update');
  PERFORM public._crm_assert_transition(v_lead.status, 'lost');

  IF p_reason_id IS NULL AND coalesce(btrim(p_notes), '') = '' THEN
    RAISE EXCEPTION 'CRM: a lost reason or explanatory note is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_stage FROM public.crm_stages
   WHERE business_id = v_lead.business_id AND is_lost AND is_active;

  v_reason := coalesce(nullif(btrim(coalesce(p_notes, '')), ''),
                       (SELECT name FROM public.crm_lost_reasons WHERE id = p_reason_id));

  PERFORM set_config('app.crm_lead_writer', '1', true);
  PERFORM set_config('app.crm_lead_reason', coalesce(v_reason, ''), true);
  UPDATE public.crm_leads
     SET status = 'lost', lost_at = now(), won_at = NULL, probability = 0,
         lost_reason_id = p_reason_id, lost_notes = p_notes,
         stage_id = coalesce(v_stage, stage_id), updated_at = now()
   WHERE id = p_lead_id RETURNING * INTO v_out;
  PERFORM set_config('app.crm_lead_writer', '0', true);
  PERFORM set_config('app.crm_lead_reason', '', true);

  PERFORM public._crm_log_system_activity(
    v_out, coalesce('Opportunity marked lost: ' || nullif(btrim(p_notes), ''),
                    'Opportunity marked lost'));
  RETURN v_out;
END;
$function$;

CREATE OR REPLACE FUNCTION public.crm_reopen_lead(p_lead_id uuid, p_reason text)
 RETURNS crm_leads
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'update');
  IF coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'CRM: a reason is required to reopen a closed opportunity'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public._crm_assert_transition(v_lead.status, 'qualified', true);

  PERFORM set_config('app.crm_lead_writer', '1', true);
  PERFORM set_config('app.crm_lead_reason', btrim(p_reason), true);
  UPDATE public.crm_leads
     SET status = 'qualified', won_at = NULL, lost_at = NULL,
         lost_reason_id = NULL, lost_notes = NULL, probability = 10,
         stage_id = (SELECT id FROM public.crm_stages
                      WHERE business_id = v_lead.business_id AND is_active
                        AND NOT is_won AND NOT is_lost
                      ORDER BY sequence LIMIT 1),
         updated_at = now()
   WHERE id = p_lead_id RETURNING * INTO v_out;
  PERFORM set_config('app.crm_lead_writer', '0', true);
  PERFORM set_config('app.crm_lead_reason', '', true);

  PERFORM public._crm_log_system_activity(
    v_out, format('Reopened from %s: %s', v_lead.status, btrim(p_reason)));
  RETURN v_out;
END;
$function$;

CREATE OR REPLACE FUNCTION public.crm_archive_lead(p_lead_id uuid, p_reason text)
 RETURNS crm_leads
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE; v_n integer;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'delete');
  IF coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'CRM: a reason is required to archive a lead' USING ERRCODE = '22023';
  END IF;

  SELECT (SELECT count(*) FROM public.estimates    WHERE source_lead_id = p_lead_id)
       + (SELECT count(*) FROM public.sales_orders WHERE source_lead_id = p_lead_id)
       + (SELECT count(*) FROM public.projects     WHERE source_lead_id = p_lead_id)
    INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'CRM: lead has % downstream commercial document(s) and cannot be archived', v_n
      USING ERRCODE = '23503';
  END IF;

  PERFORM set_config('app.crm_lead_writer', '1', true);
  PERFORM set_config('app.crm_lead_reason', btrim(p_reason), true);
  UPDATE public.crm_leads SET is_active = false, updated_at = now()
   WHERE id = p_lead_id RETURNING * INTO v_out;
  PERFORM set_config('app.crm_lead_writer', '0', true);
  PERFORM set_config('app.crm_lead_reason', '', true);

  PERFORM public._crm_log_system_activity(v_out, 'Lead archived: ' || btrim(p_reason));
  RETURN v_out;
END;
$function$;

CREATE OR REPLACE FUNCTION public.crm_revalue_lead(p_lead_id uuid, p_expected_revenue numeric, p_expected_close_date date DEFAULT NULL::date)
 RETURNS crm_leads
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'update');
  IF v_lead.status IN ('won','lost') THEN
    RAISE EXCEPTION 'CRM: lead is % — reopen it before changing its value', v_lead.status
      USING ERRCODE = '42501';
  END IF;
  IF p_expected_revenue IS NOT NULL AND p_expected_revenue < 0 THEN
    RAISE EXCEPTION 'CRM: expected revenue cannot be negative' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.crm_lead_writer', '1', true);
  UPDATE public.crm_leads
     SET expected_revenue = p_expected_revenue,
         expected_close_date = coalesce(p_expected_close_date, expected_close_date),
         updated_at = now()
   WHERE id = p_lead_id RETURNING * INTO v_out;
  PERFORM set_config('app.crm_lead_writer', '0', true);

  PERFORM public._crm_log_system_activity(
    v_out, format('Expected revenue changed from %s to %s',
                  coalesce(v_lead.expected_revenue, 0), coalesce(p_expected_revenue, 0)));
  RETURN v_out;
END;
$function$;