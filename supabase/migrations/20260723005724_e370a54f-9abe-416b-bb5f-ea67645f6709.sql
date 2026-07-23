-- ============================================================
-- Legal Orders — Phase 7 cleanup: rename physical table,
-- drop legacy free-text authority column, rebuild view and
-- functions to reference the new name.
-- ============================================================

-- 1. Drop the read view that depends on the old table name.
DROP VIEW IF EXISTS public.legal_orders CASCADE;

-- 2. Rename the physical table. Indexes, PK, FKs, triggers,
--    RLS policies and grants all follow the OID automatically.
ALTER TABLE public.employee_garnishments RENAME TO legal_orders_records;

-- 3. Drop the legacy free-text authority column.
--    Verified upstream: SELECT count(*) FROM the (empty) table
--    with authority_id IS NULL AND issuing_authority IS NOT NULL = 0.
ALTER TABLE public.legal_orders_records DROP COLUMN IF EXISTS issuing_authority;

-- 4. Re-assert grants (harmless if unchanged; keeps this migration self-contained).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.legal_orders_records TO authenticated;
GRANT ALL ON public.legal_orders_records TO service_role;

-- 5. Rebuild the `legal_orders` domain view against the renamed table.
--    New: exposes `authority_name` resolved from legal_order_authorities so
--    the employee-facing tab and reporting extracts no longer need the
--    dropped free-text column.
CREATE VIEW public.legal_orders AS
  SELECT g.id,
         g.organization_id,
         g.business_id,
         g.employee_id,
         g.employment_id,
         g.kind AS kind_code,
         g.priority,
         g.case_reference,
         g.authority_id,
         a.name AS authority_name,
         g.cap_rule,
         g.fixed_amount,
         g.percent_of_disposable,
         g.total_owed,
         g.total_paid,
         g.total_accrued,
         g.start_date,
         g.end_date,
         g.is_active,
         g.aggregate_cap_exempt,
         g.minimum_take_home_amount,
         g.status,
         g.status_changed_at,
         g.status_changed_by,
         g.status_reason,
         g.payee_name,
         g.payee_bank,
         g.payee_account,
         g.payee_reference,
         g.payee_contact_id,
         g.payee_payment_method_id,
         g.payee_unmapped,
         g.document_url,
         g.document_filename,
         g.notes,
         g.created_by,
         g.created_at,
         g.updated_at,
         d.calc_model,
         d.priority_class,
         d.protected_earnings_rule,
         d.aggregate_cap_membership,
         d.remittance_schedule_ref,
         d.evidence_requirements,
         d.completion_rule,
         d.reporting_binding_ref,
         d.source_pack_id AS legal_behavior_pack_id
    FROM public.legal_orders_records g
    LEFT JOIN public.garnishment_kind_defaults d
      ON d.organization_id = g.organization_id AND d.kind = g.kind::text
    LEFT JOIN public.legal_order_authorities a
      ON a.id = g.authority_id;

GRANT SELECT ON public.legal_orders TO authenticated;

-- 6. Repoint the 9 database functions that referenced `employee_garnishments`
--    by text (plpgsql late-binding would otherwise error on first execution).

CREATE OR REPLACE FUNCTION public.apply_garnishment_payment_to_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_garn_id uuid;
  v_org uuid;
  v_delta numeric;
  v_actor uuid;
  v_order record;
BEGIN
  v_actor := auth.uid();

  IF TG_OP = 'INSERT' THEN
    SELECT garnishment_id, organization_id INTO v_garn_id, v_org
    FROM public.payroll_liabilities WHERE id = NEW.liability_id;
    v_delta := COALESCE(NEW.amount, 0);
  ELSIF TG_OP = 'DELETE' THEN
    SELECT garnishment_id, organization_id INTO v_garn_id, v_org
    FROM public.payroll_liabilities WHERE id = OLD.liability_id;
    v_delta := -COALESCE(OLD.amount, 0);
  ELSE
    SELECT garnishment_id, organization_id INTO v_garn_id, v_org
    FROM public.payroll_liabilities WHERE id = NEW.liability_id;
    v_delta := COALESCE(NEW.amount, 0) - COALESCE(OLD.amount, 0);
  END IF;

  IF v_garn_id IS NULL OR v_delta = 0 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  UPDATE public.legal_orders_records
     SET total_paid = GREATEST(0, COALESCE(total_paid, 0) + v_delta),
         updated_at = now()
   WHERE id = v_garn_id
  RETURNING * INTO v_order;

  IF v_order.id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_delta > 0
     AND v_order.total_owed IS NOT NULL
     AND v_order.total_owed > 0
     AND v_order.total_paid >= v_order.total_owed
     AND v_order.status IN ('active','approved')
  THEN
    UPDATE public.legal_orders_records
       SET status = 'satisfied'::garnishment_status,
           status_changed_at = now(),
           status_changed_by = v_actor,
           status_reason = 'Auto-satisfied: total_paid reached total_owed',
           is_active = false,
           updated_at = now()
     WHERE id = v_garn_id;

    INSERT INTO public.garnishment_lifecycle_events
      (organization_id, business_id, garnishment_id, event,
       from_status, to_status, reason_code, reason_text,
       payload, effective_at, actor_user_id)
    VALUES (v_org, v_order.business_id, v_garn_id, 'satisfied',
            v_order.status, 'satisfied'::garnishment_status,
            'auto_satisfied',
            'Garnishment fully paid via remittance allocation',
            jsonb_build_object(
              'total_paid', v_order.total_paid,
              'total_owed', v_order.total_owed,
              'trigger', TG_OP
            ),
            now(), v_actor);
  END IF;

  RETURN COALESCE(NEW, OLD);
END
$function$;

CREATE OR REPLACE FUNCTION public.apply_system_garnishment_transition(
  p_garnishment_id uuid, p_action text, p_reason_code text, p_reason_text text,
  p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.legal_orders_records;
  v_to  public.garnishment_status;
BEGIN
  SELECT * INTO v_row FROM public.legal_orders_records WHERE id = p_garnishment_id FOR UPDATE;
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

  UPDATE public.legal_orders_records
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
$function$;

CREATE OR REPLACE FUNCTION public.garnishment_auto_expire()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer := 0;
  r public.legal_orders_records;
BEGIN
  FOR r IN
    SELECT * FROM public.legal_orders_records
     WHERE end_date IS NOT NULL
       AND end_date < current_date
       AND status IN ('active','suspended')
  LOOP
    UPDATE public.legal_orders_records
       SET status='expired', is_active=false,
           status_changed_at=now(), status_reason='end_date reached'
     WHERE id = r.id;
    INSERT INTO public.garnishment_lifecycle_events
      (organization_id, business_id, garnishment_id, event, from_status, to_status, reason_code, reason_text)
    VALUES
      (r.organization_id, r.business_id, r.id, 'expire', r.status, 'expired',
       'end_date_reached', 'Auto-expired by garnishment_auto_expire()');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $function$;

CREATE OR REPLACE FUNCTION public.garnishment_dashboard_summary(p_org_id uuid, p_business_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  FROM public.legal_orders_records
  WHERE organization_id = p_org_id
    AND (p_business_id IS NULL OR business_id IS NULL OR business_id = p_business_id);

  SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', kind, 'orders', n, 'accrued', accrued) ORDER BY n DESC), '[]'::jsonb)
  INTO v_by_kind
  FROM (
    SELECT kind::text AS kind, count(*) AS n, COALESCE(sum(total_accrued),0) AS accrued
    FROM public.legal_orders_records
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
  FROM public.legal_orders_records eg
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
$function$;

CREATE OR REPLACE FUNCTION public.garnishment_notify_employee()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
  v_org_id uuid;
  v_business_id uuid;
  v_emp_name text;
  v_kind text;
  v_status text;
  v_title text;
  v_msg text;
  v_after jsonb := COALESCE(NEW.after_state, NEW.before_state);
BEGIN
  IF NEW.action NOT IN ('created','status_changed','paid') THEN
    RETURN NEW;
  END IF;
  SELECT e.user_id, e.organization_id, e.business_id, (e.first_name || ' ' || e.last_name)
    INTO v_user_id, v_org_id, v_business_id, v_emp_name
  FROM public.legal_orders_records g
  JOIN public.employees e ON e.id = g.employee_id
  WHERE g.id = NEW.garnishment_id;
  IF v_user_id IS NULL THEN RETURN NEW; END IF;

  v_kind := COALESCE(v_after->>'kind','order');
  v_status := COALESCE(v_after->>'status','active');

  IF NEW.action = 'created' THEN
    v_title := 'New garnishment order recorded';
    v_msg := 'A ' || v_kind || ' garnishment order has been added to your payroll. Reference: ' || COALESCE(v_after->>'case_reference','—');
  ELSIF NEW.action = 'status_changed' THEN
    v_title := 'Garnishment status updated';
    v_msg := 'Your ' || v_kind || ' garnishment is now ' || v_status || '.';
  ELSIF NEW.action = 'paid' THEN
    v_title := 'Garnishment payment posted';
    v_msg := 'A payment toward your ' || v_kind || ' garnishment was deducted in the latest payroll.';
  END IF;

  INSERT INTO public.notifications(organization_id, business_id, user_id, type, category, title, message, entity_type, entity_id, priority)
  VALUES (v_org_id, v_business_id, v_user_id, 'info', 'payroll', v_title, v_msg, 'legal_order', NEW.garnishment_id,
          CASE WHEN NEW.action = 'created' THEN 2 ELSE 1 END);

  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.garnishment_transition(
  p_garnishment_id uuid, p_action text,
  p_reason_code text DEFAULT NULL::text,
  p_reason_text text DEFAULT NULL::text,
  p_evidence_url text DEFAULT NULL::text,
  p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS public.legal_orders_records
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.legal_orders_records;
  v_from public.garnishment_status;
  v_to   public.garnishment_status;
  v_actor uuid := auth.uid();
  v_action_key text;
  v_has_workflow boolean;
  v_workflow_id uuid;
  v_has_open_request boolean;
  v_has_approved_request boolean;
  v_role_ok boolean;
BEGIN
  SELECT * INTO v_row FROM public.legal_orders_records WHERE id = p_garnishment_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'GARNISHMENT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  v_role_ok := public.has_role(v_actor, 'admin')
            OR public.has_role(v_actor, 'owner')
            OR public.has_role(v_actor, 'accountant')
            OR public.has_role(v_actor, 'super_admin');
  IF p_action IN ('suspend','resume') THEN
    v_role_ok := v_role_ok OR public.has_role(v_actor, 'manager');
  END IF;
  IF NOT v_role_ok THEN
    RAISE EXCEPTION 'GARNISHMENT_FORBIDDEN: missing required role for %', p_action
      USING ERRCODE = '42501', HINT = 'GOV_MISSING_PERMISSION';
  END IF;

  v_action_key := 'payroll.legal_order.' || p_action;
  BEGIN
    PERFORM public.governance_assert_not_subject(
      v_actor, v_row.employee_id, v_action_key,
      v_row.organization_id, 'legal_order', v_row.id
    );
  EXCEPTION WHEN undefined_function THEN
    NULL;
  END;

  IF p_action IN ('activate','release','terminate_unsatisfied') THEN
    SELECT id INTO v_workflow_id FROM public.approval_workflows aw
     WHERE aw.organization_id = v_row.organization_id
       AND aw.entity_type = 'legal_order'
     LIMIT 1;
    v_has_workflow := v_workflow_id IS NOT NULL;

    IF v_has_workflow THEN
      SELECT EXISTS (
        SELECT 1 FROM public.approval_requests ar
         WHERE ar.organization_id = v_row.organization_id
           AND ar.entity_type = 'legal_order'
           AND ar.entity_id   = v_row.id
           AND ar.status      = 'approved'
      ) INTO v_has_approved_request;

      IF NOT v_has_approved_request THEN
        RAISE EXCEPTION 'GARNISHMENT_APPROVAL_REQUIRED: action % needs an approved workflow request', p_action
          USING ERRCODE = '42501', HINT = 'GOV_APPROVER_REQUIRED';
      END IF;
    END IF;
  END IF;

  v_from := v_row.status;
  v_to := CASE
    WHEN p_action = 'submit'                 AND v_from = 'draft'            THEN 'pending_approval'::public.garnishment_status
    WHEN p_action = 'approve'                AND v_from = 'pending_approval' THEN 'approved'::public.garnishment_status
    WHEN p_action = 'reject'                 AND v_from = 'pending_approval' THEN 'draft'::public.garnishment_status
    WHEN p_action = 'activate'               AND v_from IN ('draft','approved') THEN 'active'::public.garnishment_status
    WHEN p_action = 'suspend'                AND v_from = 'active'           THEN 'suspended'::public.garnishment_status
    WHEN p_action = 'resume'                 AND v_from = 'suspended'        THEN 'active'::public.garnishment_status
    WHEN p_action = 'mark_satisfied'         AND v_from IN ('active','suspended') THEN 'satisfied'::public.garnishment_status
    WHEN p_action = 'release'                AND v_from IN ('active','suspended') THEN 'released'::public.garnishment_status
    WHEN p_action = 'expire'                 AND v_from IN ('active','suspended') THEN 'expired'::public.garnishment_status
    WHEN p_action = 'terminate_unsatisfied'  AND v_from IN ('active','suspended') THEN 'terminated_unsatisfied'::public.garnishment_status
  END;
  IF v_to IS NULL THEN
    RAISE EXCEPTION 'GARNISHMENT_INVALID_TRANSITION: % from %', p_action, v_from
      USING ERRCODE = '22023';
  END IF;

  IF p_action = 'activate' AND v_row.start_date IS NOT NULL AND v_row.start_date > current_date THEN
    RAISE EXCEPTION 'GARNISHMENT_FUTURE_DATED: cannot activate before start_date %', v_row.start_date
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.legal_orders_records
     SET status = v_to,
         status_changed_at = now(),
         status_changed_by = v_actor,
         status_reason = COALESCE(p_reason_text, p_reason_code),
         is_active = (v_to = 'active'),
         document_url = COALESCE(p_evidence_url, document_url),
         updated_at = now()
   WHERE id = p_garnishment_id
   RETURNING * INTO v_row;

  IF p_action = 'submit' THEN
    SELECT id INTO v_workflow_id FROM public.approval_workflows aw
     WHERE aw.organization_id = v_row.organization_id
       AND aw.entity_type = 'legal_order'
       AND aw.is_active = true
     ORDER BY aw.created_at DESC
     LIMIT 1;
    IF v_workflow_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.approval_requests ar
         WHERE ar.organization_id = v_row.organization_id
           AND ar.entity_type = 'legal_order'
           AND ar.entity_id   = v_row.id
           AND ar.status IN ('pending','approved')
      ) INTO v_has_open_request;
      IF NOT v_has_open_request THEN
        INSERT INTO public.approval_requests(
          organization_id, business_id, workflow_id, entity_type, entity_id,
          entity_reference, current_step, status, requested_by, requested_at, notes
        ) VALUES (
          v_row.organization_id, v_row.business_id, v_workflow_id, 'legal_order', v_row.id,
          COALESCE(v_row.case_reference, v_row.id::text), 1, 'pending', v_actor, now(),
          COALESCE(p_reason_text, 'Auto-created on legal-order submit')
        );
      END IF;
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.business_event_outbox(
      organization_id, business_id, event_type, aggregate_type, aggregate_id, payload, status
    ) VALUES (
      v_row.organization_id, v_row.business_id,
      'legal_order.' || p_action, 'legal_order', v_row.id,
      jsonb_build_object(
        'from', v_from, 'to', v_to,
        'reason_code', p_reason_code, 'reason_text', p_reason_text,
        'evidence_url', p_evidence_url, 'actor', v_actor, 'payload', p_payload
      ),
      'pending'
    );
  EXCEPTION WHEN undefined_table THEN NULL; END;

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.legal_order_transition(
  p_legal_order_id uuid, p_action text,
  p_reason_code text DEFAULT NULL::text,
  p_reason_text text DEFAULT NULL::text,
  p_evidence_url text DEFAULT NULL::text,
  p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS public.legal_orders_records
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  SELECT public.garnishment_transition(p_legal_order_id, p_action, p_reason_code, p_reason_text, p_evidence_url, p_payload);
$function$;

CREATE OR REPLACE FUNCTION public.payroll_invert_correction_adjustments(_original_run_id uuid, _reversal_run_id uuid, _user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inverted int := 0;
  v_garn_updated int := 0;
  v_rec record;
BEGIN
  IF _original_run_id IS NULL THEN
    RAISE EXCEPTION 'original_run_id required' USING HINT = 'BAD_INPUT';
  END IF;

  IF _reversal_run_id IS NOT NULL THEN
    INSERT INTO public.payroll_correction_adjustments (
      organization_id, business_id, payroll_run_id, parent_run_id,
      employee_id, source_kind, source_id, signed_amount, applied_by, notes
    )
    SELECT
      organization_id, business_id, _reversal_run_id, payroll_run_id,
      employee_id, source_kind, source_id, -signed_amount, _user_id,
      'Inversion of correction run ' || _original_run_id::text
    FROM public.payroll_correction_adjustments
    WHERE payroll_run_id = _original_run_id
    ON CONFLICT (payroll_run_id, source_kind, source_id) DO NOTHING;
    GET DIAGNOSTICS v_inverted = ROW_COUNT;
  END IF;

  FOR v_rec IN
    SELECT source_id, SUM(signed_amount) AS delta
    FROM public.payroll_correction_adjustments
    WHERE payroll_run_id = _original_run_id
      AND source_kind = 'garnishment'
    GROUP BY source_id
  LOOP
    UPDATE public.legal_orders_records g
    SET total_paid = LEAST(
      COALESCE(g.total_amount, GREATEST(g.total_paid - v_rec.delta, 0)),
      GREATEST(COALESCE(g.total_paid, 0) - v_rec.delta, 0)
    )
    WHERE g.id = v_rec.source_id;
    IF FOUND THEN
      v_garn_updated := v_garn_updated + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'inverted', v_inverted,
    'garnishments_updated', v_garn_updated,
    'original_run_id', _original_run_id,
    'reversal_run_id', _reversal_run_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_hr_event_apply_garnishment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_g public.legal_orders_records;
  v_action text;
  v_code   text;
  v_text   text;
BEGIN
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
    SELECT * FROM public.legal_orders_records
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
$function$;