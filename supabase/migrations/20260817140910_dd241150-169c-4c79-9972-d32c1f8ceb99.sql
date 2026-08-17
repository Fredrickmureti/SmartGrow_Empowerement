-- 1. Resolution state on warehouse count lines -------------------------------
ALTER TABLE public.wms_count_lines
  ADD COLUMN IF NOT EXISTS approval_state text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS approval_actor_id uuid,
  ADD COLUMN IF NOT EXISTS approval_at timestamptz,
  ADD COLUMN IF NOT EXISTS approval_note text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wms_count_lines_approval_state_check'
  ) THEN
    ALTER TABLE public.wms_count_lines
      ADD CONSTRAINT wms_count_lines_approval_state_check
      CHECK (approval_state IN ('pending','approved','rejected'));
  END IF;
END $$;

-- 2. Actor is mandatory on the count lifecycle RPCs ---------------------------
CREATE OR REPLACE FUNCTION public.physical_count_submit(p_count_id uuid, p_user_id uuid, p_allow_self boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_c RECORD; v_flagged int := 0; v_actor uuid;
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

  RETURN jsonb_build_object('success', true, 'lines_flagged_recount', v_flagged);
END $function$;

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

CREATE OR REPLACE FUNCTION public.physical_count_cancel(p_count_id uuid, p_user_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_c RECORD; v_actor uuid;
BEGIN
  v_actor := COALESCE(p_user_id, auth.uid());
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'A signed-in user is required to cancel a count.'
      USING ERRCODE='42501', HINT='GOV_ACTOR_REQUIRED';
  END IF;

  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'physical count % not found', p_count_id USING ERRCODE='P0001'; END IF;
  IF v_c.state IN ('posted','cancelled','superseded') THEN
    RAISE EXCEPTION 'cannot cancel count in state %', v_c.state USING ERRCODE='P0001',
      HINT='use physical_count_supersede to reverse a posted count';
  END IF;

  UPDATE public.physical_counts
     SET state = 'cancelled', cancelled_at = now(), cancelled_by = v_actor,
         cancellation_reason = p_reason
   WHERE id = p_count_id;

  INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
  VALUES (p_count_id, v_c.organization_id, 'cancelled', v_actor,
          jsonb_build_object('reason', p_reason));

  RETURN jsonb_build_object('success', true);
END $function$;

-- physical_count_post: actor guard only; body otherwise unchanged.
CREATE OR REPLACE FUNCTION public.physical_count_post(p_count_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_c RECORD;
  v_line RECORD;
  v_adj_id uuid;
  v_existing_adj_id uuid;
  v_journal_id uuid;
  v_wh_active boolean;
  v_period_id uuid;
  v_period_status text;
  v_reconciled numeric;
  v_final_variance numeric;
  v_last_mv_ts timestamptz;
  v_adj_number text;
  v_processed int := 0;
  v_lines_inserted int := 0;
  v_client_key uuid;
  v_approve_result jsonb;
  v_adj_created_by uuid;
  v_surplus numeric := 0;
  v_shrinkage numeric := 0;
  v_prev_override text;
  v_actor uuid;
BEGIN
  v_actor := COALESCE(p_user_id, auth.uid());
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'A signed-in user is required to post a count.'
      USING ERRCODE='42501', HINT='GOV_ACTOR_REQUIRED';
  END IF;

  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Physical count not found.' USING ERRCODE = 'P0001';
  END IF;

  IF v_c.state = 'posted' THEN
    RETURN jsonb_build_object(
      'success', true,
      'count_id', p_count_id,
      'adjustment_id', CASE WHEN array_length(v_c.posted_adjustment_ids, 1) >= 1 THEN v_c.posted_adjustment_ids[1] ELSE NULL END,
      'journal_entry_id', v_c.posted_journal_entry_id,
      'lines_processed', 0,
      'already_posted', true
    );
  END IF;

  IF v_c.state <> 'approved' THEN
    RAISE EXCEPTION 'Only approved counts can be posted. Current state: %.', v_c.state USING ERRCODE = 'P0001';
  END IF;

  PERFORM public.governance_assert_not_self(
    v_actor, v_c.approved_by, 'inventory.post_count',
    v_c.organization_id, 'physical_count', p_count_id
  );

  SELECT is_active INTO v_wh_active
    FROM public.warehouses
   WHERE id = v_c.warehouse_id
     AND organization_id = v_c.organization_id
     AND business_id = v_c.business_id;
  IF COALESCE(v_wh_active, false) = false THEN
    RAISE EXCEPTION 'The warehouse for this count is inactive. Reactivate it before posting.'
      USING ERRCODE = 'P0001',
            HINT = 'Open Inventory → Warehouses and set the warehouse to active.';
  END IF;

  SELECT id, status INTO v_period_id, v_period_status
    FROM public.fiscal_periods
   WHERE organization_id = v_c.organization_id
     AND business_id = v_c.business_id
     AND CURRENT_DATE BETWEEN start_date AND end_date
   ORDER BY start_date DESC
   LIMIT 1;

  IF v_period_id IS NULL THEN
    RAISE EXCEPTION 'No fiscal period is defined for today (%). Open Accounting → Fiscal Periods and create a period.', CURRENT_DATE
      USING ERRCODE = 'P0001';
  END IF;
  IF v_period_status = 'closed' THEN
    RAISE EXCEPTION 'The fiscal period covering today is closed. Reopen it or wait for the next period.'
      USING ERRCODE = 'P0001';
  END IF;

  v_client_key := ('00000000-0000-0000-0000-' || substr(replace(p_count_id::text, '-', ''), 1, 12))::uuid;

  SELECT id INTO v_existing_adj_id
    FROM public.stock_adjustments
   WHERE organization_id = v_c.organization_id
     AND business_id     = v_c.business_id
     AND client_request_id = v_client_key
   LIMIT 1;

  IF v_existing_adj_id IS NOT NULL THEN
    v_adj_id := v_existing_adj_id;
  ELSE
    v_adj_created_by := COALESCE(
      NULLIF(v_c.approved_by,  v_actor),
      NULLIF(v_c.submitted_by, v_actor),
      NULLIF(v_c.created_by,   v_actor),
      NULLIF(v_c.frozen_by,    v_actor),
      v_actor
    );

    v_adj_number := 'PCADJ-' || v_c.count_number;

    INSERT INTO public.stock_adjustments (
      organization_id, business_id, branch_id, warehouse_id,
      adjustment_number, adjustment_date, reason, notes, status,
      created_by, allow_negative, client_request_id
    ) VALUES (
      v_c.organization_id, v_c.business_id, v_c.branch_id, v_c.warehouse_id,
      v_adj_number, CURRENT_DATE, 'count_variance',
      'Physical count ' || v_c.count_number, 'draft', v_adj_created_by, true,
      v_client_key
    ) RETURNING id INTO v_adj_id;
  END IF;

  FOR v_line IN
    SELECT pcl.*, fm.last_movement_id
      FROM public.physical_count_lines pcl
      LEFT JOIN public.physical_count_freeze_movements fm
        ON fm.count_id = pcl.count_id
       AND fm.product_id = pcl.product_id
     WHERE pcl.count_id = p_count_id
       AND pcl.counted_qty IS NOT NULL
  LOOP
    SELECT COALESCE(SUM(CASE
             WHEN sm.movement_type IN ('receipt','purchase','transfer_in','opening','return_in') AND sm.quantity > 0 THEN sm.quantity
             WHEN sm.movement_type IN ('sale','delivery','pos_sale','transfer','scrap','return_out','pos_return') THEN -ABS(sm.quantity)
             ELSE sm.quantity
           END), 0),
           MAX(sm.created_at)
      INTO v_reconciled, v_last_mv_ts
      FROM public.stock_movements sm
     WHERE sm.warehouse_id = v_c.warehouse_id
       AND sm.product_id = v_line.product_id
       AND (v_line.last_movement_id IS NULL OR sm.id <> v_line.last_movement_id)
       AND (v_line.last_movement_id IS NULL OR sm.created_at > (
             SELECT created_at FROM public.stock_movements WHERE id = v_line.last_movement_id
           ));

    v_final_variance := COALESCE(v_line.recount_qty, v_line.counted_qty, 0)
                      - (v_line.system_qty_at_freeze + v_reconciled);

    INSERT INTO public.physical_count_post_reconciliations (
      count_id, line_id, organization_id, business_id,
      product_id, warehouse_id, reconciled_qty, final_variance_qty,
      movement_cutoff, posted_at, posted_by
    ) VALUES (
      p_count_id, v_line.id, v_c.organization_id, v_c.business_id,
      v_line.product_id, v_c.warehouse_id, v_reconciled, v_final_variance,
      v_last_mv_ts, now(), v_actor
    )
    ON CONFLICT (count_id, line_id) DO UPDATE
       SET reconciled_qty     = EXCLUDED.reconciled_qty,
           final_variance_qty = EXCLUDED.final_variance_qty,
           movement_cutoff    = EXCLUDED.movement_cutoff,
           posted_at          = EXCLUDED.posted_at,
           posted_by          = EXCLUDED.posted_by;

    IF v_line.status <> 'approved' THEN
      UPDATE public.physical_count_lines SET status = 'approved', updated_at = now() WHERE id = v_line.id;
    END IF;

    v_processed := v_processed + 1;

    IF v_final_variance = 0 THEN CONTINUE; END IF;

    INSERT INTO public.stock_adjustment_items (
      adjustment_id, product_id, quantity_before, quantity_adjustment,
      quantity_after, unit_cost, warehouse_id, branch_id, notes
    ) VALUES (
      v_adj_id, v_line.product_id,
      v_line.system_qty_at_freeze + v_reconciled,
      v_final_variance,
      COALESCE(v_line.recount_qty, v_line.counted_qty, 0),
      COALESCE(v_line.unit_cost_snapshot, 0),
      v_c.warehouse_id, v_c.branch_id,
      'Physical count ' || v_c.count_number || ': system+recon=' ||
      (v_line.system_qty_at_freeze + v_reconciled)::text ||
      ' final=' || COALESCE(v_line.recount_qty, v_line.counted_qty, 0)::text
    );
    v_lines_inserted := v_lines_inserted + 1;

    IF v_final_variance > 0 THEN
      v_surplus := v_surplus + v_final_variance * COALESCE(v_line.unit_cost_snapshot, 0);
    ELSE
      v_shrinkage := v_shrinkage + (-v_final_variance) * COALESCE(v_line.unit_cost_snapshot, 0);
    END IF;
  END LOOP;

  IF v_lines_inserted > 0 THEN
    BEGIN
      v_prev_override := current_setting('app.physical_count_freeze_override', true);
    EXCEPTION WHEN OTHERS THEN
      v_prev_override := NULL;
    END;
    PERFORM set_config('app.physical_count_freeze_override', 'on', true);

    PERFORM public.physical_count_release_freeze_before_post(p_count_id);

    v_approve_result := public.approve_stock_adjustment_atomic(v_adj_id, v_actor);

    PERFORM set_config('app.physical_count_freeze_override', COALESCE(v_prev_override, ''), true);

    IF NOT COALESCE((v_approve_result->>'success')::boolean, false) THEN
      RAISE EXCEPTION 'Physical count posting failed inside stock adjustment approval: %',
        COALESCE(v_approve_result->>'error', 'unknown error')
        USING ERRCODE = 'P0001';
    END IF;

    v_journal_id := NULLIF(v_approve_result->>'journal_entry_id','')::uuid;
  ELSE
    v_journal_id := NULL;
  END IF;

  UPDATE public.physical_counts
     SET state = 'posted',
         posted_at = now(),
         posted_by = v_actor,
         posted_adjustment_ids = ARRAY[v_adj_id],
         posted_journal_entry_id = v_journal_id,
         updated_at = now()
   WHERE id = p_count_id;

  INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
  VALUES (
    p_count_id, v_c.organization_id, 'posted', v_actor,
    jsonb_build_object(
      'adjustment_id', v_adj_id,
      'journal_entry_id', v_journal_id,
      'lines_processed', v_processed,
      'lines_with_variance', v_lines_inserted,
      'surplus_value', v_surplus,
      'shrinkage_value', v_shrinkage,
      'delegated_to', 'approve_stock_adjustment_atomic'
    )
  );

  INSERT INTO public.business_event_outbox (
    org_id, branch_id, warehouse_id, event_type,
    source_doc_type, source_doc_id, payload, status, source,
    actor_user_id, idempotency_key
  ) VALUES (
    v_c.organization_id, v_c.branch_id, v_c.warehouse_id,
    'inventory.physical_count.posted', 'physical_count', p_count_id,
    jsonb_build_object(
      'count_id', p_count_id,
      'business_id', v_c.business_id,
      'warehouse_id', v_c.warehouse_id,
      'adjustment_id', v_adj_id,
      'journal_entry_id', v_journal_id
    ),
    'pending'::public.business_event_status,
    'system', v_actor,
    'inventory.physical_count.posted:' || p_count_id::text
  )
  ON CONFLICT (org_id, idempotency_key) DO NOTHING;

  RETURN jsonb_build_object(
    'success', true,
    'count_id', p_count_id,
    'adjustment_id', v_adj_id,
    'journal_entry_id', v_journal_id,
    'lines_processed', v_processed,
    'lines_with_variance', v_lines_inserted,
    'surplus_value', v_surplus,
    'shrinkage_value', v_shrinkage
  );
END;
$function$;

-- 3. A missing actor is now recorded, never silently ignored ------------------
CREATE OR REPLACE FUNCTION public.governance_assert_not_self(p_actor uuid, p_subject uuid, p_action text, p_org uuid DEFAULT NULL::uuid, p_entity_type text DEFAULT NULL::text, p_entity_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mode text;
  v_override public.self_action_overrides;
  v_actor_role public.app_role;
  v_org_mode text;
  v_governance_operator_count integer;
  v_policy_exists boolean := false;
BEGIN
  -- An unidentified actor can never be proven distinct from the subject.
  -- Callers that own a lifecycle decision must supply one (they now raise
  -- GOV_ACTOR_REQUIRED); background guards only get an audit trail so the
  -- gap is visible instead of invisible.
  IF p_actor IS NULL AND p_subject IS NOT NULL THEN
    IF p_org IS NOT NULL AND NOT public._is_teardown_for_org(p_org) THEN
      BEGIN
        INSERT INTO public.audit_logs(organization_id,user_id,action,entity_type,entity_id,new_values)
        VALUES (p_org,NULL,'sod.self_action_actor_missing',COALESCE(p_entity_type,'unknown'),p_entity_id,
          jsonb_build_object('action_key',p_action,'subject',p_subject));
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    END IF;
    RETURN;
  END IF;

  IF p_actor IS NULL OR p_subject IS NULL OR p_actor <> p_subject THEN RETURN; END IF;
  IF p_org IS NOT NULL AND public._is_teardown_for_org(p_org) THEN RETURN; END IF;

  IF p_org IS NOT NULL THEN
    SELECT ur.role INTO v_actor_role
      FROM public.user_roles ur
     WHERE ur.user_id = p_actor AND ur.organization_id = p_org AND ur.is_active = true
     ORDER BY CASE ur.role WHEN 'super_admin' THEN 0 WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 9 END
     LIMIT 1;

    SELECT governance_mode INTO v_org_mode FROM public.organizations WHERE id = p_org;
    v_org_mode := COALESCE(v_org_mode, 'standard');

    SELECT mode INTO v_mode
      FROM public.self_action_policy
     WHERE organization_id = p_org
       AND action_key = p_action
       AND (applies_to_role = v_actor_role OR applies_to_role IS NULL)
     ORDER BY (applies_to_role IS NULL) ASC
     LIMIT 1;
    v_policy_exists := v_mode IS NOT NULL;

    IF v_mode IS NULL AND v_org_mode = 'solo'
       AND v_actor_role IN ('super_admin', 'owner', 'admin') THEN
      SELECT count(DISTINCT user_id) INTO v_governance_operator_count
        FROM public.user_roles
       WHERE organization_id = p_org AND is_active = true
         AND role IN ('super_admin', 'owner', 'admin');
      INSERT INTO public.audit_logs(organization_id,user_id,action,entity_type,entity_id,new_values)
      VALUES (p_org,p_actor,'sod.self_action_auto_allowed',COALESCE(p_entity_type,'unknown'),p_entity_id,
        jsonb_build_object('action_key',p_action,'reason','solo_governance_mode','governance_mode',v_org_mode,
                           'actor_role',v_actor_role,'governance_operator_count',COALESCE(v_governance_operator_count,0)));
      RETURN;
    END IF;

    IF v_mode IS NULL THEN
      IF v_org_mode = 'standard' AND v_actor_role IN ('owner','super_admin','admin') THEN
        v_mode := 'warn';
      ELSE
        v_mode := 'block';
      END IF;
    END IF;
  END IF;

  v_mode := COALESCE(v_mode, 'block');
  IF v_mode = 'allow' THEN RETURN; END IF;
  IF v_mode = 'warn' THEN
    IF p_org IS NOT NULL THEN
      INSERT INTO public.audit_logs(organization_id,user_id,action,entity_type,entity_id,new_values)
      VALUES (p_org,p_actor,'sod.self_action_warn',COALESCE(p_entity_type,'unknown'),p_entity_id,
        jsonb_build_object('action_key',p_action,'subject',p_subject,
                           'source',CASE WHEN v_policy_exists THEN 'policy' ELSE 'mode_default' END));
    END IF;
    RETURN;
  END IF;

  IF p_org IS NOT NULL THEN
    SELECT * INTO v_override FROM public.self_action_overrides o
     WHERE o.organization_id = p_org AND o.actor_user_id = p_actor
       AND o.subject_user_id = p_subject AND o.action_key = p_action
       AND (p_entity_id IS NULL OR o.entity_id IS NULL OR o.entity_id = p_entity_id)
       AND o.expires_at > now() AND o.consumed_at IS NULL
     ORDER BY o.created_at DESC LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      PERFORM set_config('app.self_action_consume','true',true);
      UPDATE public.self_action_overrides SET consumed_at=now(),consumed_entity_id=p_entity_id WHERE id=v_override.id;
      PERFORM set_config('app.self_action_consume','false',true);
      INSERT INTO public.audit_logs(organization_id,user_id,action,entity_type,entity_id,new_values)
      VALUES (p_org,p_actor,'sod.self_action_override_consumed',COALESCE(p_entity_type,'unknown'),p_entity_id,
              jsonb_build_object('action_key',p_action,'override_id',v_override.id));
      RETURN;
    END IF;
  END IF;
  RAISE EXCEPTION 'Self-approval blocked for action "%".', p_action
    USING ERRCODE='42501', HINT='GOV_SELF_ACTION';
END;
$function$;

-- 4. Mirror the Inventory decision back onto the warehouse count lines --------
CREATE OR REPLACE FUNCTION public._wms_count_mirror_physical_state()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_session record;
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state AND NEW.state IN ('posted','cancelled') THEN
    SELECT * INTO v_session FROM public.wms_count_sessions WHERE physical_count_id = NEW.id;
    IF FOUND AND v_session.state NOT IN ('posted','cancelled') THEN
      UPDATE public.wms_count_sessions
         SET state = CASE WHEN NEW.state = 'posted' THEN 'posted'::public.wms_count_state
                          ELSE 'cancelled'::public.wms_count_state END,
             posted_at = CASE WHEN NEW.state = 'posted' THEN now() ELSE posted_at END,
             posted_by = CASE WHEN NEW.state = 'posted' THEN NEW.posted_by ELSE posted_by END
       WHERE id = v_session.id;

      -- The tolerance outcome stays as captured; the resolution is recorded
      -- separately so reports stop claiming a posted count awaits approval.
      UPDATE public.wms_count_lines l
         SET approval_state = CASE WHEN NEW.state = 'posted' THEN 'approved' ELSE 'rejected' END,
             approval_actor_id = COALESCE(NEW.approved_by, NEW.posted_by, NEW.cancelled_by),
             approval_at = COALESCE(NEW.approved_at, NEW.cancelled_at, now()),
             approval_note = CASE
               WHEN NEW.state = 'posted' AND COALESCE(NEW.approved_by, NEW.posted_by) IS NULL
                 THEN 'approver not recorded'
               ELSE NULL END
       WHERE l.session_id = v_session.id
         AND NOT EXISTS (
           SELECT 1 FROM public.wms_count_lines r WHERE r.recount_of_line_id = l.id
         );

      BEGIN
        INSERT INTO public.business_event_outbox (
          org_id, branch_id, warehouse_id, event_type,
          source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
        ) VALUES (
          v_session.organization_id, v_session.branch_id, v_session.warehouse_id,
          CASE WHEN NEW.state = 'posted' THEN 'warehouse.count.posted'
               ELSE 'warehouse.count.cancelled' END,
          'wms_count_session', v_session.id,
          jsonb_build_object(
            'session_id', v_session.id,
            'business_id', v_session.business_id,
            'physical_count_id', NEW.id
          ),
          'wms.count.' || NEW.state || ':' || v_session.id::text,
          'pending', COALESCE(NEW.posted_by, NEW.cancelled_by)
        );
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'wms count mirror outbox emit failed: %', SQLERRM;
      END;
    END IF;
  END IF;
  RETURN NEW;
END $function$;

-- 5. Expose the resolution through the single sanctioned read path ------------
DROP FUNCTION IF EXISTS public.get_count_lines(uuid);
CREATE OR REPLACE FUNCTION public.get_count_lines(p_session_id uuid)
 RETURNS TABLE(id uuid, location_id uuid, location_code text, location_name text, product_id uuid, product_sku text, product_name text, lot_number text, system_qty numeric, counted_qty numeric, entered_qty numeric, packaging_id uuid, packaging_name text, variance_qty numeric, variance_reason text, tolerance_outcome text, approval_state text, approval_actor_id uuid, approval_at timestamp with time zone, approval_note text, assigned_to uuid, serial_numbers text[], expiry_date date, recount_of_line_id uuid, recount_round integer, counted_at timestamp with time zone, counted_by uuid, is_blind boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_session record; v_hide boolean;
BEGIN
  SELECT * INTO v_session FROM public.wms_count_sessions WHERE wms_count_sessions.id = p_session_id;
  IF v_session.id IS NULL THEN RAISE EXCEPTION 'session % not found', p_session_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_session.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;

  v_hide := v_session.is_blind AND v_session.state IN ('draft','counting');

  RETURN QUERY
  SELECT l.id,
         l.location_id, sl.code, sl.name,
         l.product_id, p.sku, p.name,
         l.lot_number,
         CASE WHEN v_hide THEN NULL ELSE l.system_qty END,
         l.counted_qty,
         l.entered_qty,
         l.packaging_id,
         pk.name,
         CASE WHEN v_hide THEN NULL ELSE l.variance_qty END,
         l.variance_reason::text,
         l.tolerance_outcome,
         l.approval_state,
         l.approval_actor_id,
         l.approval_at,
         l.approval_note,
         l.assigned_to,
         l.serial_numbers,
         l.expiry_date,
         l.recount_of_line_id,
         l.recount_round,
         l.counted_at,
         l.counted_by,
         v_session.is_blind
    FROM public.wms_count_lines l
    LEFT JOIN public.stock_locations sl ON sl.id = l.location_id
    LEFT JOIN public.products p ON p.id = l.product_id
    LEFT JOIN public.product_packaging pk ON pk.id = l.packaging_id
   WHERE l.session_id = p_session_id
   ORDER BY sl.code NULLS LAST, p.name;
END $function$;

GRANT EXECUTE ON FUNCTION public.get_count_lines(uuid) TO authenticated, service_role;

-- 6. Sign-off facts for a session, resolved to names --------------------------
CREATE OR REPLACE FUNCTION public.get_count_signoffs(p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_session record;
  v_pc record;
  v_counters jsonb;
BEGIN
  SELECT * INTO v_session FROM public.wms_count_sessions WHERE id = p_session_id;
  IF v_session.id IS NULL THEN RAISE EXCEPTION 'session % not found', p_session_id; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_session.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  SELECT * INTO v_pc FROM public.physical_counts WHERE id = v_session.physical_count_id;

  SELECT jsonb_agg(DISTINCT jsonb_build_object(
           'user_id', l.counted_by,
           'name', COALESCE(pr.full_name, pr.email)))
    INTO v_counters
    FROM public.wms_count_lines l
    LEFT JOIN public.profiles pr ON pr.user_id = l.counted_by
   WHERE l.session_id = p_session_id AND l.counted_by IS NOT NULL;

  RETURN jsonb_build_object(
    'counted_by', COALESCE(v_counters, '[]'::jsonb),
    'reviewed_by', jsonb_build_object(
      'user_id', v_pc.submitted_by,
      'name', (SELECT COALESCE(full_name, email) FROM public.profiles WHERE user_id = v_pc.submitted_by),
      'at', v_pc.submitted_at),
    'approved_by', jsonb_build_object(
      'user_id', v_pc.approved_by,
      'name', (SELECT COALESCE(full_name, email) FROM public.profiles WHERE user_id = v_pc.approved_by),
      'at', v_pc.approved_at),
    'posted_by', jsonb_build_object(
      'user_id', COALESCE(v_pc.posted_by, v_session.posted_by),
      'name', (SELECT COALESCE(full_name, email) FROM public.profiles WHERE user_id = COALESCE(v_pc.posted_by, v_session.posted_by)),
      'at', COALESCE(v_pc.posted_at, v_session.posted_at))
  );
END $function$;

GRANT EXECUTE ON FUNCTION public.get_count_signoffs(uuid) TO authenticated, service_role;

-- 7. Backfill already-resolved sessions ---------------------------------------
UPDATE public.wms_count_lines l
   SET approval_state = 'approved',
       approval_actor_id = COALESCE(pc.approved_by, pc.posted_by, ev.actor_id),
       approval_at = COALESCE(pc.approved_at, pc.posted_at),
       approval_note = CASE
         WHEN COALESCE(pc.approved_by, pc.posted_by, ev.actor_id) IS NULL
           THEN 'approver not recorded (pre-fix)'
         ELSE NULL END
  FROM public.wms_count_sessions s
  JOIN public.physical_counts pc ON pc.id = s.physical_count_id
  LEFT JOIN LATERAL (
    SELECT actor_id FROM public.physical_count_events e
     WHERE e.count_id = pc.id AND e.event_type = 'approved' AND e.actor_id IS NOT NULL
     ORDER BY e.created_at DESC LIMIT 1
  ) ev ON true
 WHERE l.session_id = s.id
   AND pc.state = 'posted'
   AND l.approval_state = 'pending';

UPDATE public.wms_count_lines l
   SET approval_state = 'rejected',
       approval_actor_id = pc.cancelled_by,
       approval_at = pc.cancelled_at
  FROM public.wms_count_sessions s
  JOIN public.physical_counts pc ON pc.id = s.physical_count_id
 WHERE l.session_id = s.id
   AND pc.state = 'cancelled'
   AND l.approval_state = 'pending';