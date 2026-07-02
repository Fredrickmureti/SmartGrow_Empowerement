
-- ============================================================
-- P5/P6/P7 wiring: readiness evaluator extensions, HR lifecycle
-- garnishment integration, and dashboard support views.
-- ============================================================

-- ---- 1. Readiness evaluator: add 'sql' + remaining garnishment kinds ----
CREATE OR REPLACE FUNCTION public.payroll_readiness_eval_rule(
  p_rule public.payroll_readiness_rules,
  p_org_id uuid,
  p_business_id uuid,
  p_subject_id uuid,
  p_period_start date,
  p_period_end date
)
RETURNS TABLE(status text, reason text, missing_fields text[], details jsonb)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status     text := 'pass';
  v_reason     text;
  v_missing    text[] := ARRAY[]::text[];
  v_details    jsonb := '{}'::jsonb;
  v_invalid    text;
  v_c          public.employee_contracts;
  v_components jsonb;
  v_p_start    date := COALESCE(p_period_start, CURRENT_DATE);
  v_p_end      date := COALESCE(p_period_end,   CURRENT_DATE);
  v_hit_count  int;
  v_hit_ids    uuid[];
BEGIN
  CASE p_rule.check_kind

  WHEN 'org.localization_pack_installed' THEN
    IF NOT EXISTS (SELECT 1 FROM public.installed_localization_packs ilp WHERE ilp.organization_id = p_org_id) THEN
      v_status := 'fail'; v_reason := 'No localization pack installed for this organization.';
      v_missing := ARRAY['localization_pack'];
    END IF;

  WHEN 'org.salary_structure_active' THEN
    IF NOT EXISTS (SELECT 1 FROM public.salary_structures ss WHERE ss.organization_id = p_org_id AND ss.is_active = true) THEN
      v_status := 'fail'; v_reason := 'No active salary structure has been defined org-wide.';
      v_missing := ARRAY['salary_structure'];
    END IF;

  WHEN 'org.payroll_accounts_mapped' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.default_account_settings das
      WHERE das.organization_id = p_org_id AND das.account_id IS NOT NULL
        AND (p_business_id IS NULL OR das.business_id IS NULL OR das.business_id = p_business_id)
    ) THEN
      v_status := 'fail'; v_reason := 'Payroll GL accounts have not been mapped.';
      v_missing := ARRAY['payroll_gl_accounts'];
    END IF;

  WHEN 'org.statutory_rules_active' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.payroll_statutory_rules psr
      WHERE psr.organization_id = p_org_id AND psr.is_active = true
        AND (psr.effective_to IS NULL OR psr.effective_to >= v_p_end)
    ) THEN
      v_status := 'fail'; v_reason := 'No active statutory rules in effect for the period.';
      v_missing := ARRAY['statutory_rules'];
    END IF;

  WHEN 'org.statutory_rules_valid_method' THEN
    SELECT string_agg(psr.rule_name, ', ' ORDER BY psr.rule_name) INTO v_invalid
    FROM public.payroll_statutory_rules psr
    WHERE psr.organization_id = p_org_id AND psr.is_active = true
      AND (psr.effective_to IS NULL OR psr.effective_to >= v_p_end)
      AND (psr.computation_method IS NULL OR lower(trim(psr.computation_method)) IN ('','unknown','auto'));
    IF v_invalid IS NOT NULL AND length(v_invalid) > 0 THEN
      v_status := 'fail'; v_reason := 'Statutory rules with invalid computation_method: ' || v_invalid;
      v_missing := ARRAY['statutory_rule_method'];
      v_details := jsonb_build_object('invalid_rules', v_invalid);
    END IF;

  WHEN 'org.payroll_period_exists' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.payroll_periods pp
      WHERE pp.organization_id = p_org_id AND (p_business_id IS NULL OR pp.business_id = p_business_id)
    ) THEN
      v_status := 'fail'; v_reason := 'No payroll periods generated yet.';
      v_missing := ARRAY['payroll_periods'];
    END IF;

  WHEN 'employee.active_contract' THEN
    SELECT ec.* INTO v_c FROM public.employee_contracts ec
     WHERE ec.employee_id = p_subject_id AND ec.status IN ('running','new','active')
       AND COALESCE(ec.start_date, v_p_start) <= v_p_end
       AND (ec.end_date IS NULL OR ec.end_date >= v_p_start)
     ORDER BY ec.start_date DESC NULLS LAST LIMIT 1;
    IF NOT FOUND THEN
      v_status := 'fail'; v_reason := 'No contract effective for the selected period.';
      v_missing := ARRAY['active_contract'];
    END IF;

  WHEN 'employee.contract_has_salary' THEN
    SELECT ec.* INTO v_c FROM public.employee_contracts ec
     WHERE ec.employee_id = p_subject_id AND ec.status IN ('running','new','active')
       AND COALESCE(ec.start_date, v_p_start) <= v_p_end
       AND (ec.end_date IS NULL OR ec.end_date >= v_p_start)
     ORDER BY ec.start_date DESC NULLS LAST LIMIT 1;
    IF NOT FOUND THEN
      v_status := 'fail'; v_reason := 'No contract effective for the selected period.';
      v_missing := ARRAY['active_contract'];
    ELSIF COALESCE(v_c.wage, 0) <= 0 AND v_c.salary_structure_id IS NULL THEN
      v_status := 'fail'; v_reason := 'Active contract has neither a wage nor a salary structure.';
      v_missing := ARRAY['contract_wage'];
    END IF;

  WHEN 'employee.contract_has_schedule' THEN
    SELECT ec.* INTO v_c FROM public.employee_contracts ec
     WHERE ec.employee_id = p_subject_id AND ec.status IN ('running','new','active')
       AND COALESCE(ec.start_date, v_p_start) <= v_p_end
       AND (ec.end_date IS NULL OR ec.end_date >= v_p_start)
     ORDER BY ec.start_date DESC NULLS LAST LIMIT 1;
    IF NOT FOUND THEN
      v_status := 'fail'; v_reason := 'No contract effective for the selected period.';
      v_missing := ARRAY['active_contract'];
    ELSIF v_c.working_schedule IS NULL OR btrim(v_c.working_schedule) = '' THEN
      v_status := 'fail'; v_reason := 'Active contract has no working schedule.';
      v_missing := ARRAY['work_schedule'];
    END IF;

  WHEN 'employee.compensation_mode_set' THEN
    SELECT ec.* INTO v_c FROM public.employee_contracts ec
     WHERE ec.employee_id = p_subject_id AND ec.status IN ('running','new','active')
       AND COALESCE(ec.start_date, v_p_start) <= v_p_end
       AND (ec.end_date IS NULL OR ec.end_date >= v_p_start)
     ORDER BY ec.start_date DESC NULLS LAST LIMIT 1;
    IF NOT FOUND THEN
      v_status := 'fail'; v_reason := 'No contract effective for the selected period.';
      v_missing := ARRAY['active_contract'];
    ELSIF v_c.compensation_mode IS NULL THEN
      v_status := 'fail'; v_reason := 'Contract has no compensation method (structure or simple wage).';
      v_missing := ARRAY['compensation_mode'];
    END IF;

  WHEN 'employee.salary_structure_resolves' THEN
    SELECT ec.* INTO v_c FROM public.employee_contracts ec
     WHERE ec.employee_id = p_subject_id AND ec.status IN ('running','new','active')
       AND COALESCE(ec.start_date, v_p_start) <= v_p_end
       AND (ec.end_date IS NULL OR ec.end_date >= v_p_start)
     ORDER BY ec.start_date DESC NULLS LAST LIMIT 1;
    IF NOT FOUND THEN
      v_status := 'fail'; v_reason := 'No contract effective for the selected period.';
      v_missing := ARRAY['active_contract'];
    ELSIF v_c.compensation_mode = 'structure' THEN
      IF v_c.salary_structure_id IS NULL THEN
        v_status := 'fail'; v_reason := 'Structure-mode contract has no salary structure selected.';
        v_missing := ARRAY['salary_structure_id'];
      ELSIF NOT EXISTS (
        SELECT 1 FROM public.salary_structures ss
        WHERE ss.id = v_c.salary_structure_id AND ss.is_active = true
      ) THEN
        v_status := 'fail'; v_reason := 'Selected salary structure is inactive.';
        v_missing := ARRAY['salary_structure_active'];
      ELSE
        SELECT public.canonicalise_salary_components(v_c.salary_structure_id) INTO v_components;
        IF COALESCE(v_components, '[]'::jsonb) = '[]'::jsonb THEN
          v_status := 'fail'; v_reason := 'Selected salary structure has no active components.';
          v_missing := ARRAY['salary_components'];
        END IF;
      END IF;
    END IF;

  -- ---- Garnishment org-scope checks ----
  WHEN 'garnishment_kind_unresolved' THEN
    SELECT array_agg(eg.id), count(*) INTO v_hit_ids, v_hit_count
    FROM public.employee_garnishments eg
    WHERE eg.organization_id = p_org_id
      AND eg.is_active = true
      AND NOT EXISTS (
        SELECT 1 FROM public.localization_pack_garnishment_kinds k
        JOIN public.installed_localization_packs ilp
          ON ilp.pack_id = k.pack_id
        WHERE ilp.organization_id = p_org_id
          AND k.kind::text = eg.kind::text
      );
    IF COALESCE(v_hit_count, 0) > 0 THEN
      v_status := 'fail';
      v_reason := v_hit_count || ' active garnishment(s) reference a kind not in any installed localization pack.';
      v_missing := ARRAY['localization_pack_garnishment_kind'];
      v_details := jsonb_build_object('garnishment_ids', v_hit_ids);
    END IF;

  WHEN 'garnishment.payee_mapped' THEN
    SELECT array_agg(eg.id), count(*) INTO v_hit_ids, v_hit_count
    FROM public.employee_garnishments eg
    WHERE eg.organization_id = p_org_id
      AND eg.is_active = true
      AND (eg.payee_unmapped = true
           OR (eg.payee_contact_id IS NULL AND COALESCE(eg.payee_name, '') = ''));
    IF COALESCE(v_hit_count, 0) > 0 THEN
      v_status := 'fail';
      v_reason := v_hit_count || ' active garnishment(s) have no resolved payee.';
      v_missing := ARRAY['garnishment_payee'];
      v_details := jsonb_build_object('garnishment_ids', v_hit_ids);
    END IF;

  WHEN 'garnishment.liability_account_mapped' THEN
    IF EXISTS (
      SELECT 1 FROM public.employee_garnishments eg
      WHERE eg.organization_id = p_org_id AND eg.is_active = true
    ) AND NOT EXISTS (
      SELECT 1 FROM public.default_account_settings das
      WHERE das.organization_id = p_org_id
        AND das.account_id IS NOT NULL
        AND das.account_key = 'garnishment_payable'
        AND (p_business_id IS NULL OR das.business_id IS NULL OR das.business_id = p_business_id)
    ) THEN
      v_status := 'fail';
      v_reason := 'Active garnishments exist but no garnishment_payable GL account is mapped.';
      v_missing := ARRAY['garnishment_payable_account'];
    END IF;

  WHEN 'garnishment.evidence_document' THEN
    SELECT array_agg(eg.id), count(*) INTO v_hit_ids, v_hit_count
    FROM public.employee_garnishments eg
    WHERE eg.organization_id = p_org_id
      AND eg.is_active = true
      AND COALESCE(eg.document_url, '') = '';
    IF COALESCE(v_hit_count, 0) > 0 THEN
      v_status := 'fail';
      v_reason := v_hit_count || ' active garnishment(s) have no order document attached.';
      v_missing := ARRAY['garnishment_evidence'];
      v_details := jsonb_build_object('garnishment_ids', v_hit_ids);
    END IF;

  -- ---- Generic SQL predicate kind ----
  -- predicate_sql must SELECT a non-empty rowset of `id` (or any column)
  -- when the rule should FAIL. Bind $1 = org_id, $2 = business_id (nullable).
  WHEN 'sql' THEN
    IF p_rule.predicate_sql IS NOT NULL AND length(btrim(p_rule.predicate_sql)) > 0 THEN
      BEGIN
        EXECUTE 'SELECT count(*), COALESCE(array_agg(t.id), ARRAY[]::uuid[]) FROM (' || p_rule.predicate_sql || ' LIMIT 200) t'
          INTO v_hit_count, v_hit_ids
          USING p_org_id, p_business_id;
      EXCEPTION WHEN OTHERS THEN
        v_status := 'fail';
        v_reason := 'SQL rule failed to execute: ' || SQLERRM;
        v_missing := ARRAY['rule_predicate'];
        v_details := jsonb_build_object('error', SQLERRM, 'code', SQLSTATE);
        RETURN QUERY SELECT v_status, v_reason, v_missing, v_details;
        RETURN;
      END;
      IF COALESCE(v_hit_count, 0) > 0 THEN
        v_status := 'fail';
        v_reason := COALESCE(p_rule.description, p_rule.name) || ' (' || v_hit_count || ')';
        v_missing := ARRAY[p_rule.code];
        v_details := jsonb_build_object('matched_ids', v_hit_ids, 'matched_count', v_hit_count);
      END IF;
    END IF;

  ELSE
    NULL;
  END CASE;

  RETURN QUERY SELECT v_status, v_reason, v_missing, v_details;
END;
$function$;

-- ---- 2. HR lifecycle -> garnishment integration ----
-- Helper that applies an audited garnishment transition without the
-- end-user role check (callable from triggers / cron). SECURITY DEFINER.
CREATE OR REPLACE FUNCTION public.apply_system_garnishment_transition(
  p_garnishment_id uuid,
  p_action text,
  p_reason_code text,
  p_reason_text text,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row public.employee_garnishments;
  v_to  public.garnishment_status;
BEGIN
  SELECT * INTO v_row FROM public.employee_garnishments WHERE id = p_garnishment_id FOR UPDATE;
  IF v_row.id IS NULL THEN RETURN; END IF;

  v_to := CASE
    WHEN p_action = 'suspend'  AND v_row.status = 'active'    THEN 'suspended'::public.garnishment_status
    WHEN p_action = 'resume'   AND v_row.status = 'suspended' THEN 'active'::public.garnishment_status
    WHEN p_action = 'terminate_unsatisfied' AND v_row.status IN ('active','suspended')
      THEN 'terminated_unsatisfied'::public.garnishment_status
    WHEN p_action = 'expire'   AND v_row.status IN ('active','suspended')
      THEN 'expired'::public.garnishment_status
    ELSE NULL
  END;

  IF v_to IS NULL THEN RETURN; END IF;

  UPDATE public.employee_garnishments
     SET status = v_to,
         is_active = (v_to = 'active'),
         status_changed_at = now(),
         status_reason = COALESCE(p_reason_text, status_reason)
   WHERE id = p_garnishment_id;

  INSERT INTO public.garnishment_lifecycle_events
    (organization_id, business_id, garnishment_id, event, from_status, to_status,
     reason_code, reason_text, actor_user_id, payload)
  VALUES
    (v_row.organization_id, v_row.business_id, v_row.id, p_action, v_row.status, v_to,
     p_reason_code, p_reason_text, NULL,
     COALESCE(p_payload, '{}'::jsonb) || jsonb_build_object('source','hr_lifecycle'));
END;
$$;

-- Trigger function: react to HR lifecycle events.
CREATE OR REPLACE FUNCTION public.tg_hr_event_apply_garnishment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_g public.employee_garnishments;
  v_action text;
  v_code   text;
  v_text   text;
BEGIN
  -- Map HR event type to garnishment action.
  IF NEW.event_type IN ('terminated','offboarding_completed') THEN
    v_action := 'terminate_unsatisfied';
    v_code   := 'HR_EMPLOYEE_TERMINATED';
    v_text   := 'Employee terminated; garnishment closed as unsatisfied.';
  ELSIF NEW.event_type = 'termination_initiated' THEN
    v_action := 'suspend';
    v_code   := 'HR_TERMINATION_INITIATED';
    v_text   := 'Termination initiated; garnishment suspended pending final settlement.';
  ELSIF NEW.event_type IN ('suspended','leave_of_absence_started') THEN
    v_action := 'suspend';
    v_code   := 'HR_LEAVE_OR_SUSPENSION';
    v_text   := 'Employee placed on leave / suspended; garnishment suspended.';
  ELSIF NEW.event_type IN ('reinstated','leave_of_absence_ended') THEN
    v_action := 'resume';
    v_code   := 'HR_REINSTATED';
    v_text   := 'Employee reinstated; garnishment resumed.';
  ELSE
    RETURN NEW;
  END IF;

  FOR v_g IN
    SELECT * FROM public.employee_garnishments
    WHERE employee_id = NEW.employee_id
      AND organization_id = NEW.organization_id
      AND status IN ('active','suspended')
  LOOP
    PERFORM public.apply_system_garnishment_transition(
      v_g.id, v_action, v_code, v_text,
      jsonb_build_object('hr_event_id', NEW.id, 'event_type', NEW.event_type)
    );
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hr_event_apply_garnishment ON public.employee_lifecycle_events;
CREATE TRIGGER trg_hr_event_apply_garnishment
AFTER INSERT ON public.employee_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION public.tg_hr_event_apply_garnishment();

-- ---- 3. Dashboard read RPC ----
CREATE OR REPLACE FUNCTION public.garnishment_dashboard_summary(
  p_org_id uuid,
  p_business_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_totals jsonb;
  v_by_kind jsonb;
  v_carry  jsonb;
  v_overdue jsonb;
  v_expiring jsonb;
  v_recent jsonb;
BEGIN
  SELECT jsonb_build_object(
    'active_orders', count(*) FILTER (WHERE status = 'active'),
    'suspended_orders', count(*) FILTER (WHERE status = 'suspended'),
    'total_owed', COALESCE(sum(total_owed) FILTER (WHERE status IN ('active','suspended')), 0),
    'total_accrued', COALESCE(sum(total_accrued) FILTER (WHERE status IN ('active','suspended')), 0),
    'total_paid', COALESCE(sum(total_paid) FILTER (WHERE status IN ('active','suspended')), 0)
  )
  INTO v_totals
  FROM public.employee_garnishments
  WHERE organization_id = p_org_id
    AND (p_business_id IS NULL OR business_id IS NULL OR business_id = p_business_id);

  SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', kind, 'orders', n, 'accrued', accrued) ORDER BY n DESC), '[]'::jsonb)
  INTO v_by_kind
  FROM (
    SELECT kind::text AS kind, count(*) AS n, COALESCE(sum(total_accrued),0) AS accrued
    FROM public.employee_garnishments
    WHERE organization_id = p_org_id
      AND status IN ('active','suspended')
      AND (p_business_id IS NULL OR business_id IS NULL OR business_id = p_business_id)
    GROUP BY kind
  ) t;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', cf.id, 'garnishment_id', cf.garnishment_id, 'employee_id', cf.employee_id,
    'reason_code', cf.reason_code, 'shortfall', cf.shortfall_amount,
    'source_period_end', cf.source_period_end
  ) ORDER BY cf.created_at DESC), '[]'::jsonb)
  INTO v_carry
  FROM public.garnishment_carry_forward cf
  WHERE cf.organization_id = p_org_id
    AND cf.consumed_by_run_id IS NULL
    AND (p_business_id IS NULL OR cf.business_id IS NULL OR cf.business_id = p_business_id);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', pl.id, 'garnishment_id', pl.garnishment_id, 'amount', pl.outstanding_amount,
    'due_date', pl.due_date, 'days_overdue', CURRENT_DATE - pl.due_date
  ) ORDER BY pl.due_date), '[]'::jsonb)
  INTO v_overdue
  FROM public.payroll_liabilities pl
  WHERE pl.organization_id = p_org_id
    AND pl.garnishment_id IS NOT NULL
    AND pl.outstanding_amount > 0
    AND pl.due_date < CURRENT_DATE
    AND (p_business_id IS NULL OR pl.business_id IS NULL OR pl.business_id = p_business_id);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', eg.id, 'employee_id', eg.employee_id, 'end_date', eg.end_date,
    'days_until_expiry', eg.end_date - CURRENT_DATE, 'kind', eg.kind::text
  ) ORDER BY eg.end_date), '[]'::jsonb)
  INTO v_expiring
  FROM public.employee_garnishments eg
  WHERE eg.organization_id = p_org_id
    AND eg.status IN ('active','approved')
    AND eg.end_date IS NOT NULL
    AND eg.end_date <= (CURRENT_DATE + INTERVAL '30 days')
    AND eg.end_date >= CURRENT_DATE
    AND (p_business_id IS NULL OR eg.business_id IS NULL OR eg.business_id = p_business_id);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', le.id, 'garnishment_id', le.garnishment_id, 'event', le.event,
    'from_status', le.from_status, 'to_status', le.to_status,
    'reason_text', le.reason_text, 'effective_at', le.effective_at
  ) ORDER BY le.effective_at DESC), '[]'::jsonb)
  INTO v_recent
  FROM (
    SELECT * FROM public.garnishment_lifecycle_events
    WHERE organization_id = p_org_id
      AND (p_business_id IS NULL OR business_id IS NULL OR business_id = p_business_id)
    ORDER BY effective_at DESC LIMIT 25
  ) le;

  RETURN jsonb_build_object(
    'totals', COALESCE(v_totals, '{}'::jsonb),
    'by_kind', v_by_kind,
    'carry_forward', v_carry,
    'overdue_remittances', v_overdue,
    'expiring_orders', v_expiring,
    'recent_events', v_recent,
    'evaluated_at', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.garnishment_dashboard_summary(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_system_garnishment_transition(uuid, text, text, text, jsonb) TO service_role;
