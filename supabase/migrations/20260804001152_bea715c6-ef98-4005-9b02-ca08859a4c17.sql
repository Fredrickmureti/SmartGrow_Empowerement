-- =====================================================================
-- Phase 1c / 3 — policy engine, idempotent raise, ownership, escalation.
-- =====================================================================

-- ---------------------------------------------- 1. seed default policies
INSERT INTO public.wms_exception_policies
  (kind, class, default_severity, sla_minutes, owner_role, escalation_after_mins,
   escalation_role, requires_evidence, required_evidence_types, notify_channels)
VALUES
  -- inbound / receiving
  ('receiving_discrepancy','operational',3,240,'receiving_lead',240,'warehouse_supervisor',true, ARRAY['photo']::public.wms_exception_evidence_type[], ARRAY['in_app','email']),
  ('over_receipt','financial',3,240,'receiving_lead',240,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  ('under_receipt','financial',3,240,'receiving_lead',240,'procurement',false,'{}',ARRAY['in_app','email']),
  ('missing_carton','operational',3,180,'receiving_lead',180,'warehouse_supervisor',true, ARRAY['photo']::public.wms_exception_evidence_type[], ARRAY['in_app']),
  ('wrong_supplier','compliance',3,480,'procurement',480,'warehouse_supervisor',false,'{}',ARRAY['in_app','email']),
  ('wrong_asn','operational',2,480,'receiving_lead',480,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  ('asn_mismatch','operational',2,480,'receiving_lead',480,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  ('damaged_goods','quality',4,120,'quality_inspector',120,'warehouse_supervisor',true, ARRAY['photo']::public.wms_exception_evidence_type[], ARRAY['in_app','email']),
  ('failed_inspection','quality',4,120,'quality_inspector',120,'warehouse_supervisor',true, ARRAY['inspection_report']::public.wms_exception_evidence_type[], ARRAY['in_app','email']),
  ('qc_fail','quality',4,120,'quality_inspector',120,'warehouse_supervisor',true, ARRAY['inspection_report']::public.wms_exception_evidence_type[], ARRAY['in_app','email']),
  ('return_discrepancy','operational',2,480,'receiving_lead',480,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  -- inventory accuracy
  ('negative_inventory','financial',5,60,'inventory_controller',60,'warehouse_supervisor',false,'{}',ARRAY['in_app','email']),
  ('phantom_inventory','financial',4,240,'inventory_controller',240,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  ('duplicate_serial','compliance',4,240,'inventory_controller',240,'it_support',false,'{}',ARRAY['in_app']),
  ('batch_mismatch','quality',4,120,'quality_inspector',120,'inventory_controller',false,'{}',ARRAY['in_app']),
  ('expired_stock','compliance',4,120,'quality_inspector',120,'warehouse_supervisor',false,'{}',ARRAY['in_app','email']),
  ('unexpected_movement','operational',3,240,'inventory_controller',240,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  ('count_variance','financial',3,480,'inventory_controller',480,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  ('repeated_discrepancy','financial',4,480,'inventory_controller',480,'warehouse_supervisor',false,'{}',ARRAY['in_app','email']),
  -- storage
  ('capacity_exceeded','operational',3,120,'warehouse_supervisor',120,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  ('invalid_bin','operational',2,120,'inventory_controller',120,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  ('wrong_location','operational',2,240,'inventory_controller',240,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  ('unsafe_storage','safety',5,30,'warehouse_supervisor',30,'warehouse_supervisor',true, ARRAY['photo']::public.wms_exception_evidence_type[], ARRAY['in_app','email','sms']),
  ('quarantine_violation','compliance',5,60,'quality_inspector',60,'warehouse_supervisor',true, ARRAY['photo']::public.wms_exception_evidence_type[], ARRAY['in_app','email']),
  ('damaged_lpn','operational',3,240,'warehouse_supervisor',240,'warehouse_supervisor',true, ARRAY['photo']::public.wms_exception_evidence_type[], ARRAY['in_app']),
  -- picking
  ('short_pick','customer_impact',3,60,'pick_lead',60,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  ('wrong_item_picked','customer_impact',4,60,'pick_lead',60,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  ('wrong_batch_picked','quality',4,60,'quality_inspector',60,'pick_lead',false,'{}',ARRAY['in_app']),
  ('pick_sla_breach','customer_impact',3,30,'pick_lead',30,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  -- packing
  ('weight_mismatch','quality',3,60,'pack_lead',60,'warehouse_supervisor',true, ARRAY['weight']::public.wms_exception_evidence_type[], ARRAY['in_app']),
  ('incorrect_package','customer_impact',2,120,'pack_lead',120,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  ('carton_missing','customer_impact',4,60,'pack_lead',60,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  -- shipping
  ('wrong_carrier','customer_impact',3,60,'shipping_lead',60,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  ('missed_dispatch','customer_impact',4,30,'shipping_lead',30,'warehouse_supervisor',false,'{}',ARRAY['in_app','email']),
  ('shipment_blocked','customer_impact',4,60,'shipping_lead',60,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  -- dock
  ('missed_appointment','operational',2,120,'dock_coordinator',120,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  ('dock_congestion','operational',3,60,'dock_coordinator',60,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  ('incorrect_trailer','operational',3,60,'dock_coordinator',60,'yard_marshal',false,'{}',ARRAY['in_app']),
  -- yard
  ('trailer_overstay','financial',2,480,'yard_marshal',480,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  ('seal_mismatch','compliance',5,30,'yard_marshal',30,'warehouse_supervisor',true, ARRAY['photo']::public.wms_exception_evidence_type[], ARRAY['in_app','email']),
  -- cross-dock
  ('demand_disappeared','operational',2,240,'warehouse_supervisor',240,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  ('routing_conflict','operational',3,120,'warehouse_supervisor',120,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  -- labour
  ('abandoned_task','operational',2,60,'labour_planner',60,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  ('stale_task','operational',2,30,'labour_planner',30,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  ('productivity_target_missed','informational',1,1440,'labour_planner',1440,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  -- equipment
  ('device_offline','operational',3,60,'maintenance',60,'it_support',false,'{}',ARRAY['in_app']),
  ('printer_offline','operational',3,60,'maintenance',60,'it_support',false,'{}',ARRAY['in_app']),
  ('scanner_offline','operational',3,60,'maintenance',60,'it_support',false,'{}',ARRAY['in_app']),
  ('rfid_failure','operational',3,120,'maintenance',120,'it_support',false,'{}',ARRAY['in_app']),
  ('conveyor_failure','safety',5,30,'maintenance',30,'warehouse_supervisor',false,'{}',ARRAY['in_app','email','sms']),
  ('scale_failure','operational',3,120,'maintenance',120,'it_support',false,'{}',ARRAY['in_app']),
  ('sensor_failure','operational',3,120,'maintenance',120,'it_support',false,'{}',ARRAY['in_app']),
  -- misc / integration
  ('unknown_scan','operational',2,60,'warehouse_supervisor',60,'it_support',false,'{}',ARRAY['in_app']),
  ('integration_failure','operational',4,60,'it_support',60,'warehouse_supervisor',false,'{}',ARRAY['in_app','email']),
  ('data_sync_failure','operational',3,120,'it_support',120,'warehouse_supervisor',false,'{}',ARRAY['in_app']),
  ('billing_unpriced','financial',2,480,'finance',480,'finance',false,'{}',ARRAY['in_app']),
  ('other','operational',2,240,'warehouse_supervisor',240,'warehouse_supervisor',false,'{}',ARRAY['in_app'])
ON CONFLICT DO NOTHING;

-- ------------------------------------------------- 2. policy resolution
CREATE OR REPLACE FUNCTION public._wms_exception_policy(
  p_kind public.wms_exception_kind,
  p_warehouse_id uuid,
  p_business_id uuid
) RETURNS public.wms_exception_policies
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT p.* FROM public.wms_exception_policies p
  WHERE p.kind = p_kind AND p.is_active
    AND (p.warehouse_id = p_warehouse_id
         OR (p.warehouse_id IS NULL AND p.business_id = p_business_id)
         OR (p.warehouse_id IS NULL AND p.business_id IS NULL))
  ORDER BY (p.warehouse_id IS NOT NULL) DESC, (p.business_id IS NOT NULL) DESC
  LIMIT 1
$$;

-- --------------------------------------------------- 3. history helper
CREATE OR REPLACE FUNCTION public._wms_exception_log(
  p_exception_id uuid,
  p_event_type public.wms_exception_event_type,
  p_from public.wms_exception_state DEFAULT NULL,
  p_to public.wms_exception_state DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_ex RECORD;
BEGIN
  SELECT organization_id, business_id, owner_role INTO v_ex
    FROM public.wms_exceptions WHERE id = p_exception_id;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO public.wms_exception_events
    (organization_id, business_id, exception_id, event_type, from_state, to_state,
     actor_id, actor_role, reason, payload)
  VALUES
    (v_ex.organization_id, v_ex.business_id, p_exception_id, p_event_type, p_from, p_to,
     auth.uid(), v_ex.owner_role, p_reason, COALESCE(p_payload,'{}'::jsonb));
END $$;

-- ------------------------------------------ 4. policy-driven raise (v2)
DROP FUNCTION IF EXISTS public.wms_raise_exception(uuid, public.wms_exception_kind, text, text, uuid, uuid, uuid, smallint, jsonb);

CREATE OR REPLACE FUNCTION public.wms_raise_exception(
  p_warehouse_id uuid,
  p_kind public.wms_exception_kind,
  p_reason text,
  p_aggregate_type text DEFAULT NULL,
  p_aggregate_id uuid DEFAULT NULL,
  p_task_id uuid DEFAULT NULL,
  p_lpn_id uuid DEFAULT NULL,
  p_severity smallint DEFAULT NULL,
  p_details jsonb DEFAULT '{}'::jsonb,
  p_idempotency_key text DEFAULT NULL,
  p_class public.wms_exception_class DEFAULT NULL,
  p_owner_role public.wms_exception_owner_role DEFAULT NULL,
  p_source_system text DEFAULT 'wms',
  p_links jsonb DEFAULT '[]'::jsonb,
  p_evidence jsonb DEFAULT '[]'::jsonb,
  p_financial_impact numeric DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_wh      RECORD;
  v_pol     public.wms_exception_policies;
  v_id      uuid;
  v_sev     smallint;
  v_class   public.wms_exception_class;
  v_role    public.wms_exception_owner_role;
  v_sla     integer;
  v_key     text;
  v_item    jsonb;
BEGIN
  SELECT id, organization_id, business_id, branch_id INTO v_wh
    FROM public.warehouses WHERE id = p_warehouse_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Warehouse not found' USING ERRCODE='P0002'; END IF;

  -- Deterministic key: same divergence never yields two rows.
  v_key := COALESCE(
    p_idempotency_key,
    'wms.exception:' || p_kind::text || ':' ||
      COALESCE(p_aggregate_type,'-') || ':' ||
      COALESCE(p_aggregate_id::text, p_task_id::text, p_lpn_id::text, gen_random_uuid()::text)
  );

  SELECT id INTO v_id FROM public.wms_exceptions
   WHERE idempotency_key = v_key
     AND state NOT IN ('resolved','wont_fix');
  IF v_id IS NOT NULL THEN
    UPDATE public.wms_exceptions
       SET details    = details || COALESCE(p_details,'{}'::jsonb),
           updated_at = now()
     WHERE id = v_id;
    RETURN v_id;
  END IF;

  v_pol   := public._wms_exception_policy(p_kind, p_warehouse_id, v_wh.business_id);
  v_sev   := COALESCE(p_severity, v_pol.default_severity, 2);
  v_class := COALESCE(p_class, v_pol.class, 'operational');
  v_role  := COALESCE(p_owner_role, v_pol.owner_role);
  v_sla   := COALESCE(v_pol.sla_minutes, 240);

  INSERT INTO public.wms_exceptions (
    organization_id, business_id, branch_id, warehouse_id,
    kind, state, severity, class, owner_role, aggregate_type, aggregate_id,
    task_id, lpn_id, reason, details, raised_by, due_by,
    idempotency_key, source_system, financial_impact
  ) VALUES (
    v_wh.organization_id, v_wh.business_id, v_wh.branch_id, p_warehouse_id,
    p_kind, 'open', v_sev, v_class, v_role, p_aggregate_type, p_aggregate_id,
    p_task_id, p_lpn_id, p_reason, COALESCE(p_details,'{}'::jsonb), auth.uid(),
    now() + make_interval(mins => v_sla),
    v_key, COALESCE(p_source_system,'wms'), p_financial_impact
  ) RETURNING id INTO v_id;

  -- Attach related business documents.
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_links,'[]'::jsonb)) LOOP
    INSERT INTO public.wms_exception_links
      (organization_id, business_id, exception_id, link_type, record_id, record_label, route_path, created_by)
    VALUES (
      v_wh.organization_id, v_wh.business_id, v_id,
      (v_item->>'link_type')::public.wms_exception_link_type,
      NULLIF(v_item->>'record_id','')::uuid,
      v_item->>'record_label',
      v_item->>'route_path',
      auth.uid()
    ) ON CONFLICT DO NOTHING;
  END LOOP;

  -- Attach machine-captured evidence.
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_evidence,'[]'::jsonb)) LOOP
    INSERT INTO public.wms_exception_evidence
      (organization_id, business_id, exception_id, evidence_type, label,
       numeric_value, unit, text_value, storage_bucket, storage_path, external_url,
       device_id, captured_by, metadata)
    VALUES (
      v_wh.organization_id, v_wh.business_id, v_id,
      (v_item->>'evidence_type')::public.wms_exception_evidence_type,
      v_item->>'label',
      NULLIF(v_item->>'numeric_value','')::numeric,
      v_item->>'unit',
      v_item->>'text_value',
      v_item->>'storage_bucket',
      v_item->>'storage_path',
      v_item->>'external_url',
      NULLIF(v_item->>'device_id','')::uuid,
      auth.uid(),
      COALESCE(v_item->'metadata','{}'::jsonb)
    );
  END LOOP;

  PERFORM public._wms_exception_log(
    v_id, 'created', NULL, 'open', p_reason,
    jsonb_build_object('kind', p_kind, 'class', v_class, 'severity', v_sev,
                       'owner_role', v_role, 'sla_minutes', v_sla,
                       'source_system', COALESCE(p_source_system,'wms'))
  );

  PERFORM public._wms_emit_outbox(
    'warehouse.exception.raised',
    'wms.exception:' || v_id::text || ':raised',
    v_wh.organization_id, v_wh.business_id,
    jsonb_build_object(
      'aggregate_id', v_id, 'kind', p_kind, 'class', v_class, 'severity', v_sev,
      'owner_role', v_role, 'warehouse_id', p_warehouse_id, 'branch_id', v_wh.branch_id,
      'actor_id', auth.uid(), 'occurred_at', now(),
      'task_id', p_task_id, 'lpn_id', p_lpn_id, 'reason', p_reason,
      'details', COALESCE(p_details,'{}'::jsonb)
    )
  );
  RETURN v_id;
END $$;

-- ------------------------------------------------- 5. assign / acknowledge
CREATE OR REPLACE FUNCTION public.wms_assign_exception(
  p_exception_id uuid,
  p_row_version integer,
  p_assignee uuid DEFAULT NULL,
  p_owner_role public.wms_exception_owner_role DEFAULT NULL,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.wms_exceptions%ROWTYPE; v_rv integer; v_reassign boolean;
BEGIN
  SELECT * INTO v_row FROM public.wms_exceptions WHERE id = p_exception_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exception not found' USING ERRCODE='P0002'; END IF;
  IF v_row.row_version <> p_row_version THEN
    RAISE EXCEPTION 'Row version mismatch (have %, expected %)', v_row.row_version, p_row_version USING ERRCODE='40001';
  END IF;
  IF v_row.state IN ('resolved','wont_fix') THEN
    RAISE EXCEPTION 'WMS_EXCEPTION_CLOSED: cannot assign a closed exception' USING ERRCODE='22023';
  END IF;
  v_reassign := v_row.assigned_to IS NOT NULL;
  v_rv := v_row.row_version + 1;

  UPDATE public.wms_exceptions SET
    assigned_to = COALESCE(p_assignee, assigned_to),
    owner_role  = COALESCE(p_owner_role, owner_role),
    assigned_at = now(), assigned_by = auth.uid(),
    row_version = v_rv, updated_at = now()
  WHERE id = p_exception_id;

  PERFORM public._wms_exception_log(
    p_exception_id, CASE WHEN v_reassign THEN 'reassigned' ELSE 'assigned' END,
    v_row.state, v_row.state, p_reason,
    jsonb_build_object('assignee', p_assignee, 'owner_role', p_owner_role,
                       'previous_assignee', v_row.assigned_to)
  );

  PERFORM public._wms_emit_outbox(
    'warehouse.exception.assigned',
    'wms.exception:' || p_exception_id::text || ':assigned:' || v_rv::text,
    v_row.organization_id, v_row.business_id,
    jsonb_build_object('aggregate_id', p_exception_id, 'warehouse_id', v_row.warehouse_id,
                       'assignee', p_assignee, 'owner_role', COALESCE(p_owner_role, v_row.owner_role),
                       'severity', v_row.severity, 'kind', v_row.kind,
                       'actor_id', auth.uid(), 'occurred_at', now())
  );
  RETURN jsonb_build_object('row_version', v_rv);
END $$;

CREATE OR REPLACE FUNCTION public.wms_acknowledge_exception(
  p_exception_id uuid,
  p_row_version integer,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.wms_exceptions%ROWTYPE; v_rv integer;
BEGIN
  SELECT * INTO v_row FROM public.wms_exceptions WHERE id = p_exception_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exception not found' USING ERRCODE='P0002'; END IF;
  IF v_row.row_version <> p_row_version THEN
    RAISE EXCEPTION 'Row version mismatch (have %, expected %)', v_row.row_version, p_row_version USING ERRCODE='40001';
  END IF;
  IF v_row.state <> 'open' THEN
    RAISE EXCEPTION 'Only an open exception can be acknowledged' USING ERRCODE='22023';
  END IF;
  v_rv := v_row.row_version + 1;
  UPDATE public.wms_exceptions SET
    state='acknowledged', acknowledged_at=now(), acknowledged_by=auth.uid(),
    assigned_to = COALESCE(assigned_to, auth.uid()),
    row_version=v_rv, updated_at=now()
  WHERE id = p_exception_id;

  PERFORM public._wms_exception_log(p_exception_id,'acknowledged','open','acknowledged',p_note,'{}'::jsonb);
  PERFORM public._wms_emit_outbox(
    'warehouse.exception.acknowledged',
    'wms.exception:' || p_exception_id::text || ':acknowledged:' || v_rv::text,
    v_row.organization_id, v_row.business_id,
    jsonb_build_object('aggregate_id', p_exception_id, 'warehouse_id', v_row.warehouse_id,
                       'actor_id', auth.uid(), 'occurred_at', now(),
                       'response_minutes', EXTRACT(EPOCH FROM (now() - v_row.created_at))/60)
  );
  RETURN jsonb_build_object('row_version', v_rv, 'state', 'acknowledged');
END $$;

-- ---------------------------------------- 6. resolve: history + evidence gate
CREATE OR REPLACE FUNCTION public.wms_resolve_exception(
  p_exception_id uuid,
  p_to_state public.wms_exception_state,
  p_row_version integer,
  p_resolution text DEFAULT NULL,
  p_resolution_kind public.wms_exception_resolution_kind DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_row public.wms_exceptions%ROWTYPE;
  v_from public.wms_exception_state;
  v_allowed boolean := false;
  v_new_rv integer;
  v_terminal boolean;
  v_pol public.wms_exception_policies;
  v_missing public.wms_exception_evidence_type[];
BEGIN
  SELECT * INTO v_row FROM public.wms_exceptions WHERE id = p_exception_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exception not found' USING ERRCODE='P0002'; END IF;
  IF v_row.row_version <> p_row_version THEN
    RAISE EXCEPTION 'Row version mismatch (have %, expected %)', v_row.row_version, p_row_version USING ERRCODE='40001';
  END IF;
  v_from := v_row.state;
  v_terminal := p_to_state IN ('resolved','wont_fix');

  v_allowed := CASE
    WHEN v_from = 'open'          AND p_to_state IN ('acknowledged','investigating','escalated','resolved','wont_fix') THEN true
    WHEN v_from = 'acknowledged'  AND p_to_state IN ('investigating','escalated','resolved','wont_fix')                THEN true
    WHEN v_from = 'investigating' AND p_to_state IN ('escalated','resolved','wont_fix')                                 THEN true
    WHEN v_from = 'escalated'     AND p_to_state IN ('investigating','resolved','wont_fix')                             THEN true
    ELSE false
  END;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Illegal exception transition % → %', v_from, p_to_state USING ERRCODE='22023';
  END IF;

  IF v_terminal AND COALESCE(p_resolution_kind, v_row.resolution_kind) IS NULL THEN
    RAISE EXCEPTION 'WMS_RESOLUTION_KIND_REQUIRED: pick a resolution category to close this exception' USING ERRCODE='22023';
  END IF;
  IF v_terminal AND length(trim(COALESCE(p_resolution, v_row.resolution, ''))) = 0 THEN
    RAISE EXCEPTION 'WMS_RESOLUTION_NOTES_REQUIRED: resolution notes are required to close this exception' USING ERRCODE='22023';
  END IF;

  -- Policy-mandated evidence must be present before a terminal move.
  IF v_terminal AND p_to_state = 'resolved' THEN
    v_pol := public._wms_exception_policy(v_row.kind, v_row.warehouse_id, v_row.business_id);
    IF v_pol.requires_evidence AND array_length(v_pol.required_evidence_types,1) IS NOT NULL THEN
      SELECT array_agg(t) INTO v_missing
        FROM unnest(v_pol.required_evidence_types) t
       WHERE NOT EXISTS (
         SELECT 1 FROM public.wms_exception_evidence e
          WHERE e.exception_id = p_exception_id AND e.evidence_type = t
       );
      IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'WMS_EVIDENCE_REQUIRED: attach % before resolving', array_to_string(v_missing, ', ')
          USING ERRCODE='22023';
      END IF;
    END IF;
  END IF;

  v_new_rv := v_row.row_version + 1;
  UPDATE public.wms_exceptions SET
    state           = p_to_state,
    row_version     = v_new_rv,
    resolution      = COALESCE(p_resolution, resolution),
    resolution_kind = COALESCE(p_resolution_kind, resolution_kind),
    acknowledged_at = CASE WHEN acknowledged_at IS NULL THEN now() ELSE acknowledged_at END,
    escalated_at    = CASE WHEN p_to_state = 'escalated' THEN now() ELSE escalated_at END,
    resolved_by     = CASE WHEN v_terminal THEN auth.uid() ELSE resolved_by END,
    resolved_at     = CASE WHEN v_terminal THEN now() ELSE resolved_at END,
    updated_at      = now()
  WHERE id = p_exception_id;

  PERFORM public._wms_exception_log(
    p_exception_id,
    CASE WHEN p_to_state='resolved' THEN 'resolved'
         WHEN p_to_state='escalated' THEN 'escalated'
         WHEN p_to_state='wont_fix' THEN 'closed'
         ELSE 'state_changed' END,
    v_from, p_to_state, p_resolution,
    jsonb_build_object('resolution_kind', COALESCE(p_resolution_kind, v_row.resolution_kind),
                       'sla_breached', (v_row.due_by IS NOT NULL AND now() > v_row.due_by),
                       'resolution_minutes', EXTRACT(EPOCH FROM (now() - v_row.created_at))/60)
  );

  PERFORM public._wms_emit_outbox(
    'warehouse.exception.' || p_to_state::text,
    'wms.exception:' || p_exception_id::text || ':' || p_to_state::text,
    v_row.organization_id, v_row.business_id,
    jsonb_build_object(
      'aggregate_id', p_exception_id, 'warehouse_id', v_row.warehouse_id,
      'branch_id', v_row.branch_id, 'actor_id', auth.uid(), 'occurred_at', now(),
      'from_state', v_from, 'to_state', p_to_state, 'kind', v_row.kind,
      'severity', v_row.severity, 'class', v_row.class,
      'resolution', p_resolution,
      'resolution_kind', COALESCE(p_resolution_kind, v_row.resolution_kind),
      'sla_breached', (v_row.due_by IS NOT NULL AND now() > v_row.due_by)
    )
  );
  RETURN jsonb_build_object('row_version', v_new_rv, 'state', p_to_state);
END $$;

-- ------------------------------------------------ 7. escalation sweep
CREATE OR REPLACE FUNCTION public.wms_escalate_overdue_exceptions(
  p_warehouse_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.wms_exceptions%ROWTYPE; v_pol public.wms_exception_policies; v_n integer := 0;
BEGIN
  FOR v_row IN
    SELECT * FROM public.wms_exceptions
     WHERE state IN ('open','acknowledged','investigating')
       AND due_by IS NOT NULL AND now() > due_by
       AND (p_warehouse_id IS NULL OR warehouse_id = p_warehouse_id)
     ORDER BY due_by ASC
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  LOOP
    v_pol := public._wms_exception_policy(v_row.kind, v_row.warehouse_id, v_row.business_id);
    IF v_row.escalation_level >= COALESCE(v_pol.max_escalation_level, 2) THEN
      -- Ladder exhausted: mark the breach once, stop churning.
      IF v_row.sla_breached_at IS NULL THEN
        UPDATE public.wms_exceptions
           SET sla_breached_at = now(), updated_at = now(), row_version = row_version + 1
         WHERE id = v_row.id;
        PERFORM public._wms_exception_log(v_row.id,'sla_breached',v_row.state,v_row.state,
          'SLA breached; escalation ladder exhausted','{}'::jsonb);
      END IF;
      CONTINUE;
    END IF;

    UPDATE public.wms_exceptions SET
      state            = 'escalated',
      escalation_level = v_row.escalation_level + 1,
      escalated_at     = now(),
      sla_breached_at  = COALESCE(sla_breached_at, now()),
      owner_role       = COALESCE(v_pol.escalation_role, owner_role),
      severity         = LEAST(5, v_row.severity + 1),
      due_by           = now() + make_interval(mins => COALESCE(v_pol.escalation_after_mins, v_pol.sla_minutes, 240)),
      row_version      = v_row.row_version + 1,
      updated_at       = now()
    WHERE id = v_row.id;

    PERFORM public._wms_exception_log(
      v_row.id,'escalated',v_row.state,'escalated','SLA breached — auto-escalated',
      jsonb_build_object('level', v_row.escalation_level + 1,
                         'escalation_role', v_pol.escalation_role)
    );
    PERFORM public._wms_emit_outbox(
      'warehouse.exception.escalated',
      'wms.exception:' || v_row.id::text || ':escalated:' || (v_row.escalation_level + 1)::text,
      v_row.organization_id, v_row.business_id,
      jsonb_build_object('aggregate_id', v_row.id, 'warehouse_id', v_row.warehouse_id,
                         'kind', v_row.kind, 'class', v_row.class,
                         'severity', LEAST(5, v_row.severity + 1),
                         'escalation_level', v_row.escalation_level + 1,
                         'owner_role', COALESCE(v_pol.escalation_role, v_row.owner_role),
                         'occurred_at', now(), 'auto', true)
    );
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

GRANT EXECUTE ON FUNCTION public.wms_assign_exception(uuid,integer,uuid,public.wms_exception_owner_role,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_acknowledge_exception(uuid,integer,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_escalate_overdue_exceptions(uuid,integer) TO authenticated, service_role;
