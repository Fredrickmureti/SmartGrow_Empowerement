-- 1. Warehouse becomes a governed module: the policy action for count differences.
INSERT INTO public.governance_action_registry
  (action_key, label, description, module, severity_default, subject_mode, subject_table, requires_approval_always, is_active)
VALUES
  ('warehouse.count_variance',
   'Approve a cycle count difference',
   'A cycle count found a difference outside the allowed tolerance. Governance decides whether anybody must approve it before stock moves.',
   'Warehouse', 'standard', 'actor', 'physical_count', false, true)
ON CONFLICT (action_key) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      module = EXCLUDED.module,
      is_active = true;

-- 2. The count carries its governance request, exactly like an RFQ does.
ALTER TABLE public.physical_counts
  ADD COLUMN IF NOT EXISTS approval_request_id uuid REFERENCES public.approval_requests(id);

CREATE INDEX IF NOT EXISTS physical_counts_approval_request_idx
  ON public.physical_counts(approval_request_id)
  WHERE approval_request_id IS NOT NULL;

-- 3. Submit routes the decision through the one engine, then continues when
--    policy does not gate it (canonical `approval_route` returns NULL).
CREATE OR REPLACE FUNCTION public.physical_count_submit(p_count_id uuid, p_user_id uuid, p_allow_self boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_c RECORD;
  v_flagged int := 0;
  v_actor uuid;
  v_req public.approval_requests;
  v_units numeric := 0;
  v_value numeric := 0;
  v_lines int := 0;
  v_auto boolean := false;
  v_blocked text := NULL;
BEGIN
  v_actor := COALESCE(p_user_id, auth.uid());
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'A signed-in user is required to submit a count.'
      USING ERRCODE='42501', HINT='GOV_ACTOR_REQUIRED';
  END IF;

  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'physical count % not found', p_count_id USING ERRCODE='P0001'; END IF;
  IF v_c.state <> 'counting' THEN
    RAISE EXCEPTION 'cannot submit count in state %', v_c.state USING ERRCODE='P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.physical_count_lines
     WHERE count_id = p_count_id
       AND counted_qty IS NULL
       AND status IN ('pending', 'recount_required')
  ) THEN
    RAISE EXCEPTION 'some lines still need a (re)count — record them before submitting'
      USING ERRCODE='P0001',
            HINT='recount-flagged lines were reset for re-entry; enter their new counts first';
  END IF;

  PERFORM public.governance_assert_not_self(
    v_actor, v_c.created_by, 'inventory.submit_count',
    v_c.organization_id, 'physical_count', p_count_id
  );

  WITH flagged AS (
    UPDATE public.physical_count_lines pcl
       SET status = 'recount_required'
      FROM public.physical_counts pc
     WHERE pcl.count_id = p_count_id
       AND pc.id = pcl.count_id
       AND pcl.status = 'variance'
       AND (
         (pc.tolerance_value IS NOT NULL
           AND ABS(pcl.variance_qty * COALESCE(pcl.unit_cost_snapshot,0)) > pc.tolerance_value)
         OR (pc.tolerance_pct IS NOT NULL
           AND (pcl.system_qty_at_freeze + pcl.freeze_reconciliation_qty) <> 0
           AND ABS(pcl.variance_qty) / NULLIF(ABS(pcl.system_qty_at_freeze + pcl.freeze_reconciliation_qty),0) * 100
               > pc.tolerance_pct)
       )
     RETURNING 1
  ) SELECT COUNT(*) INTO v_flagged FROM flagged;

  UPDATE public.physical_counts
     SET state = 'in_review', submitted_at = now(), submitted_by = v_actor
   WHERE id = p_count_id;

  INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
  VALUES (p_count_id, v_c.organization_id, 'submitted', v_actor,
          jsonb_build_object('lines_flagged_recount', v_flagged, 'allow_self', p_allow_self));

  -- The domain rule (a difference outside tolerance needs a decision) stays.
  -- WHO satisfies it is a governance question, answered by the one engine.
  SELECT COUNT(*),
         COALESCE(SUM(ABS(variance_qty)),0),
         COALESCE(SUM(ABS(variance_qty * COALESCE(unit_cost_snapshot,0))),0)
    INTO v_lines, v_units, v_value
    FROM public.physical_count_lines
   WHERE count_id = p_count_id AND COALESCE(variance_qty,0) <> 0;

  BEGIN
    v_req := public.approval_route(
      'warehouse.count_variance', 'physical_count', p_count_id, v_c.count_number,
      jsonb_build_object(
        'variance_lines', v_lines,
        'variance_units', v_units,
        'variance_value', v_value,
        'amount', v_value,
        'lines_flagged_recount', v_flagged),
      jsonb_build_object('organization_id', v_c.organization_id),
      'warehouse.count_variance:' || p_count_id::text,
      v_c.business_id);
  EXCEPTION WHEN OTHERS THEN
    -- Routing must never lose a submitted count. An unroutable request leaves
    -- the count in review for a human, and the reason is auditable.
    v_req := NULL;
    v_blocked := SQLERRM;
    INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
    VALUES (p_count_id, v_c.organization_id, 'governance_route_failed', v_actor,
            jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE));
  END;

  IF v_req.id IS NOT NULL THEN
    UPDATE public.physical_counts SET approval_request_id = v_req.id WHERE id = p_count_id;
    RETURN jsonb_build_object(
      'success', true,
      'lines_flagged_recount', v_flagged,
      'governance', 'approval_required',
      'approval_request_id', v_req.id,
      'approval_status', v_req.status);
  END IF;

  IF v_blocked IS NULL THEN
    -- Policy does not gate this action for this tenant (Solo, or no matching
    -- rule). Continue the lifecycle now, stamping the real actor at each step.
    -- Separation-of-duties still applies: if the tenant demands a second
    -- person, the automatic path stands down and the count waits.
    BEGIN
      PERFORM public.physical_count_approve(
        p_count_id, v_actor, true,
        CASE WHEN v_flagged > 0
             THEN 'Governance: no approval policy gates cycle count differences for this organisation'
             ELSE NULL END);
      PERFORM public.physical_count_post(p_count_id, v_actor);
      v_auto := true;
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_auto := false;
        v_blocked := SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'lines_flagged_recount', v_flagged,
    'governance', CASE WHEN v_auto THEN 'auto_satisfied' ELSE 'awaiting_second_person' END,
    'auto_posted', v_auto,
    'blocked_reason', v_blocked);
END $function$;

-- 4. Manual approval refuses while the engine owns the decision.
CREATE OR REPLACE FUNCTION public.physical_count_approve(p_count_id uuid, p_user_id uuid, p_allow_self boolean DEFAULT false, p_tolerance_override_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_c RECORD; v_flagged int; v_actor uuid;
BEGIN
  v_actor := COALESCE(p_user_id, auth.uid());
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'A signed-in user is required to approve a count.'
      USING ERRCODE='42501', HINT='GOV_ACTOR_REQUIRED';
  END IF;

  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'physical count % not found', p_count_id USING ERRCODE='P0001'; END IF;
  IF v_c.state <> 'in_review' THEN
    RAISE EXCEPTION 'cannot approve count in state %', v_c.state USING ERRCODE='P0001';
  END IF;

  IF v_c.approval_request_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.approval_requests r
     WHERE r.id = v_c.approval_request_id
       AND r.status IN ('pending','in_review','escalated')
  ) THEN
    RAISE EXCEPTION 'this count is waiting on a governance approval request'
      USING ERRCODE='42501', HINT='GOV_USE_APPROVAL_ENGINE';
  END IF;

  PERFORM public.governance_assert_not_self(
    v_actor, v_c.submitted_by, 'inventory.approve_count',
    v_c.organization_id, 'physical_count', p_count_id
  );
  PERFORM public.governance_assert_not_self(
    v_actor, v_c.created_by, 'inventory.approve_count',
    v_c.organization_id, 'physical_count', p_count_id
  );
  IF v_c.frozen_by IS NOT NULL THEN
    PERFORM public.governance_assert_not_self(
      v_actor, v_c.frozen_by, 'inventory.approve_count',
      v_c.organization_id, 'physical_count', p_count_id
    );
  END IF;

  SELECT COUNT(*) INTO v_flagged FROM public.physical_count_lines
   WHERE count_id = p_count_id AND status = 'recount_required';

  IF v_flagged > 0 AND (p_tolerance_override_reason IS NULL OR btrim(p_tolerance_override_reason) = '') THEN
    RAISE EXCEPTION '% line(s) exceed tolerance — recount them or supply a tolerance_override_reason', v_flagged
      USING ERRCODE='P0001', HINT='select the flagged rows and Request Recount, or approve with a written override';
  END IF;

  UPDATE public.physical_counts
     SET state = 'approved', approved_at = now(), approved_by = v_actor
   WHERE id = p_count_id;

  INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
  VALUES (p_count_id, v_c.organization_id, 'approved', v_actor,
          jsonb_build_object(
            'allow_self', p_allow_self,
            'tolerance_override_reason', p_tolerance_override_reason,
            'flagged_lines_at_approval', v_flagged));

  RETURN jsonb_build_object('success', true, 'flagged_lines', v_flagged);
END $function$;

-- 5. The governance decision mirrors back onto the count.
CREATE OR REPLACE FUNCTION public._mirror_approval_to_physical_count()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_c public.physical_counts;
  v_actor uuid;
BEGIN
  IF NEW.entity_type <> 'physical_count' OR NEW.action_key <> 'warehouse.count_variance' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_c FROM public.physical_counts WHERE id = NEW.entity_id;
  IF v_c.id IS NULL THEN RETURN NEW; END IF;

  SELECT h.actor_user_id INTO v_actor
    FROM public.approval_history h
   WHERE h.request_id = NEW.id AND h.actor_user_id IS NOT NULL
   ORDER BY h.recorded_at DESC
   LIMIT 1;
  v_actor := COALESCE(v_actor, auth.uid(), v_c.submitted_by);

  IF NEW.status = 'approved' AND v_c.state = 'in_review' THEN
    UPDATE public.physical_counts SET approval_request_id = NULL WHERE id = v_c.id;
    PERFORM public.physical_count_approve(
      v_c.id, v_actor, true,
      'Approved through governance request ' || NEW.id::text);
    PERFORM public.physical_count_post(v_c.id, v_actor);
    UPDATE public.physical_counts SET approval_request_id = NEW.id WHERE id = v_c.id;

  ELSIF NEW.status IN ('rejected','cancelled') AND v_c.state = 'in_review' THEN
    UPDATE public.physical_counts
       SET state = 'counting', submitted_at = NULL, submitted_by = NULL,
           approval_request_id = NULL
     WHERE id = v_c.id;
    UPDATE public.physical_count_lines
       SET status = 'recount_required', counted_qty = NULL
     WHERE count_id = v_c.id AND status = 'recount_required';
    INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
    VALUES (v_c.id, v_c.organization_id, 'governance_rejected', v_actor,
            jsonb_build_object('approval_request_id', NEW.id, 'status', NEW.status));
  END IF;

  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_mirror_approval_to_physical_count ON public.approval_requests;
CREATE TRIGGER trg_mirror_approval_to_physical_count
AFTER UPDATE ON public.approval_requests
FOR EACH ROW EXECUTE FUNCTION public._mirror_approval_to_physical_count();