CREATE OR REPLACE FUNCTION public.wms_count_governance_preview(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_s RECORD;
  v_c RECORD;
  v_rule public.approval_rules;
  v_reg public.governance_action_registry;
  v_mode text;
  v_lines int := 0;
  v_units numeric := 0;
  v_value numeric := 0;
  v_flagged int := 0;
  v_open_request public.approval_requests;
BEGIN
  SELECT * INTO v_s FROM public.wms_count_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  IF NOT public.is_org_member(auth.uid(), v_s.organization_id) THEN
    RAISE EXCEPTION 'not a member of this organization'
      USING ERRCODE = '42501', HINT = 'GOV_MISSING_PERMISSION';
  END IF;

  SELECT governance_mode::text INTO v_mode
    FROM public.organizations WHERE id = v_s.organization_id;

  SELECT * INTO v_reg FROM public.governance_action_registry
   WHERE action_key = 'warehouse.count_variance';

  SELECT COUNT(*),
         COALESCE(SUM(ABS(COALESCE(variance_qty,0))),0),
         COUNT(*) FILTER (WHERE tolerance_outcome = 'recount_required')
    INTO v_lines, v_units, v_flagged
    FROM public.wms_count_lines
   WHERE session_id = p_session_id
     AND COALESCE(variance_qty,0) <> 0;

  IF v_s.physical_count_id IS NOT NULL THEN
    SELECT * INTO v_c FROM public.physical_counts WHERE id = v_s.physical_count_id;
    SELECT COALESCE(SUM(ABS(variance_qty * COALESCE(unit_cost_snapshot,0))),0)
      INTO v_value
      FROM public.physical_count_lines
     WHERE count_id = v_s.physical_count_id AND COALESCE(variance_qty,0) <> 0;

    IF v_c.approval_request_id IS NOT NULL THEN
      SELECT * INTO v_open_request FROM public.approval_requests
       WHERE id = v_c.approval_request_id;
    END IF;
  END IF;

  v_rule := public._approval_match_rule(
    v_s.organization_id, v_s.business_id, 'physical_count',
    'warehouse.count_variance',
    jsonb_build_object(
      'variance_lines', v_lines,
      'variance_units', v_units,
      'variance_value', v_value,
      'amount', v_value,
      'lines_flagged_recount', v_flagged));

  RETURN jsonb_build_object(
    'found', true,
    'governance_mode', v_mode,
    'action_key', 'warehouse.count_variance',
    'variance_lines', v_lines,
    'variance_units', v_units,
    'variance_value', v_value,
    'lines_outside_tolerance', v_flagged,
    'gated', (v_rule.id IS NOT NULL) OR COALESCE(v_reg.requires_approval_always, false),
    'rule_id', v_rule.id,
    'rule_description', v_rule.description,
    'approver_type', v_rule.approver_type,
    'approver_role', v_rule.approver_role,
    'approval_request_id', v_open_request.id,
    'approval_status', v_open_request.status);
END;
$function$;