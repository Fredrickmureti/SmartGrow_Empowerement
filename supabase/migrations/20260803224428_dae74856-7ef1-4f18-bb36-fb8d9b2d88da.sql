-- ============================================================
-- Cross-dock Phase 3 — orchestration
-- ============================================================

CREATE OR REPLACE FUNCTION public._wms_crossdock_guard(
  p_id uuid, p_row_version integer, p_allowed public.wms_crossdock_state[]
) RETURNS public.wms_crossdock_opportunities
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_row public.wms_crossdock_opportunities;
BEGIN
  SELECT * INTO v_row FROM public.wms_crossdock_opportunities WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'cross-dock opportunity not found' USING ERRCODE='P0002'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_row.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF p_row_version IS NOT NULL AND p_row_version <> v_row.row_version THEN
    RAISE EXCEPTION 'stale row (expected version %, got %)', v_row.row_version, p_row_version
      USING ERRCODE='40001';
  END IF;
  IF NOT (v_row.state = ANY(p_allowed)) THEN
    RAISE EXCEPTION 'cross-dock is % — allowed: %', v_row.state, array_to_string(p_allowed, ', ');
  END IF;
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public._wms_crossdock_staging_location(p_warehouse_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT id FROM public.stock_locations
   WHERE warehouse_id = p_warehouse_id
     AND is_active
     AND location_type = 'staging'
   ORDER BY (usage = 'ship') DESC, (usage = 'pack') DESC, is_default DESC, code
   LIMIT 1;
$$;

-- Approve ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_crossdock_approve(
  p_opportunity_id uuid,
  p_row_version integer DEFAULT NULL,
  p_outbound_dock_id uuid DEFAULT NULL,
  p_appointment_id uuid DEFAULT NULL,
  p_staging_location_id uuid DEFAULT NULL
) RETURNS public.wms_crossdock_opportunities
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.wms_crossdock_opportunities;
BEGIN
  v_row := public._wms_crossdock_guard(p_opportunity_id, p_row_version,
             ARRAY['detected','qualified']::public.wms_crossdock_state[]);

  UPDATE public.wms_crossdock_opportunities
     SET state = 'approved', approved_at = now(), approved_by = auth.uid(),
         outbound_dock_id = COALESCE(p_outbound_dock_id, outbound_dock_id),
         appointment_id = COALESCE(p_appointment_id, appointment_id),
         staging_location_id = COALESCE(p_staging_location_id, staging_location_id,
                                        public._wms_crossdock_staging_location(warehouse_id))
   WHERE id = p_opportunity_id
   RETURNING * INTO v_row;

  PERFORM public.emit_crossdock_event('warehouse.crossdock.approved', v_row);
  RETURN v_row;
END $$;

-- Reject ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_crossdock_reject(
  p_opportunity_id uuid, p_reason text, p_row_version integer DEFAULT NULL
) RETURNS public.wms_crossdock_opportunities
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.wms_crossdock_opportunities;
BEGIN
  v_row := public._wms_crossdock_guard(p_opportunity_id, p_row_version,
             ARRAY['detected','qualified','approved']::public.wms_crossdock_state[]);

  UPDATE public.wms_crossdock_opportunities
     SET state = 'rejected', reject_reason = COALESCE(p_reason, 'Rejected by supervisor')
   WHERE id = p_opportunity_id RETURNING * INTO v_row;

  PERFORM public.emit_crossdock_event('warehouse.crossdock.rejected', v_row);
  RETURN v_row;
END $$;

-- Start staging (creates the move task) ---------------------------------
CREATE OR REPLACE FUNCTION public.wms_crossdock_start_staging(
  p_opportunity_id uuid, p_row_version integer DEFAULT NULL
) RETURNS public.wms_crossdock_opportunities
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_row public.wms_crossdock_opportunities;
  v_dest uuid;
  v_task uuid;
BEGIN
  v_row := public._wms_crossdock_guard(p_opportunity_id, p_row_version,
             ARRAY['approved']::public.wms_crossdock_state[]);

  v_dest := COALESCE(v_row.staging_location_id, public._wms_crossdock_staging_location(v_row.warehouse_id));

  IF v_row.stage_task_id IS NULL THEN
    INSERT INTO public.wms_tasks (
      organization_id, business_id, branch_id, warehouse_id,
      task_type, state, priority, destination_location_id,
      product_id, quantity, source_doc_type, source_doc_id,
      sla_at, notes, created_by
    ) VALUES (
      v_row.organization_id, v_row.business_id, v_row.branch_id, v_row.warehouse_id,
      'move'::wms_task_type, 'available'::wms_task_state, 90, v_dest,
      v_row.product_id, v_row.quantity, 'wms_crossdock_opportunity', v_row.id,
      v_row.expires_at, 'Cross-dock: move receipt straight to outbound staging.', auth.uid()
    ) RETURNING id INTO v_task;
  ELSE
    v_task := v_row.stage_task_id;
  END IF;

  UPDATE public.wms_crossdock_opportunities
     SET state = 'staging', stage_task_id = v_task, staging_location_id = v_dest,
         assigned_user_id = COALESCE(assigned_user_id, auth.uid())
   WHERE id = p_opportunity_id RETURNING * INTO v_row;

  PERFORM public.emit_crossdock_event('warehouse.crossdock.staging', v_row);
  RETURN v_row;
END $$;

-- Confirm staged (closes move task, raises load task) -------------------
CREATE OR REPLACE FUNCTION public.wms_crossdock_confirm_staged(
  p_opportunity_id uuid, p_row_version integer DEFAULT NULL
) RETURNS public.wms_crossdock_opportunities
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_row public.wms_crossdock_opportunities;
  v_load uuid;
BEGIN
  v_row := public._wms_crossdock_guard(p_opportunity_id, p_row_version,
             ARRAY['approved','staging']::public.wms_crossdock_state[]);

  UPDATE public.wms_tasks
     SET state = 'completed'::wms_task_state, completed_at = now()
   WHERE id = v_row.stage_task_id
     AND state NOT IN ('completed','done','cancelled');

  INSERT INTO public.wms_tasks (
    organization_id, business_id, branch_id, warehouse_id,
    task_type, state, priority, source_location_id,
    product_id, quantity, source_doc_type, source_doc_id,
    sla_at, notes, created_by
  ) VALUES (
    v_row.organization_id, v_row.business_id, v_row.branch_id, v_row.warehouse_id,
    'load'::wms_task_type, 'available'::wms_task_state, 80, v_row.staging_location_id,
    v_row.product_id, v_row.quantity, 'wms_crossdock_opportunity', v_row.id,
    v_row.expires_at, 'Cross-dock: load staged units onto the outbound trailer.', auth.uid()
  ) RETURNING id INTO v_load;

  UPDATE public.wms_crossdock_opportunities
     SET state = 'staged', staged_at = now(), load_task_id = v_load
   WHERE id = p_opportunity_id RETURNING * INTO v_row;

  PERFORM public.emit_crossdock_event('warehouse.crossdock.staged', v_row);
  RETURN v_row;
END $$;

-- Loaded / completed ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_crossdock_mark_loaded(
  p_opportunity_id uuid, p_row_version integer DEFAULT NULL, p_manifest_id uuid DEFAULT NULL
) RETURNS public.wms_crossdock_opportunities
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.wms_crossdock_opportunities;
BEGIN
  v_row := public._wms_crossdock_guard(p_opportunity_id, p_row_version,
             ARRAY['staged']::public.wms_crossdock_state[]);

  UPDATE public.wms_tasks
     SET state = 'completed'::wms_task_state, completed_at = now()
   WHERE id = v_row.load_task_id AND state NOT IN ('completed','done','cancelled');

  UPDATE public.wms_crossdock_opportunities
     SET state = 'loaded', loaded_at = now(), manifest_id = COALESCE(p_manifest_id, manifest_id)
   WHERE id = p_opportunity_id RETURNING * INTO v_row;

  PERFORM public.emit_crossdock_event('warehouse.crossdock.loaded', v_row);
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.wms_crossdock_complete(
  p_opportunity_id uuid, p_row_version integer DEFAULT NULL
) RETURNS public.wms_crossdock_opportunities
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.wms_crossdock_opportunities;
BEGIN
  v_row := public._wms_crossdock_guard(p_opportunity_id, p_row_version,
             ARRAY['loaded','staged']::public.wms_crossdock_state[]);

  UPDATE public.wms_crossdock_opportunities
     SET state = 'completed', completed_at = now()
   WHERE id = p_opportunity_id RETURNING * INTO v_row;

  PERFORM public.emit_crossdock_event('warehouse.crossdock.completed', v_row);
  RETURN v_row;
END $$;

-- Break -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_crossdock_break(
  p_opportunity_id uuid, p_reason text, p_row_version integer DEFAULT NULL
) RETURNS public.wms_crossdock_opportunities
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.wms_crossdock_opportunities;
BEGIN
  v_row := public._wms_crossdock_guard(p_opportunity_id, p_row_version,
             ARRAY['approved','staging','staged','loaded']::public.wms_crossdock_state[]);

  UPDATE public.wms_tasks
     SET state = 'cancelled'::wms_task_state, cancel_reason = COALESCE(p_reason,'cross-dock broken')
   WHERE id IN (v_row.stage_task_id, v_row.load_task_id)
     AND state NOT IN ('completed','done','cancelled');

  UPDATE public.wms_crossdock_opportunities
     SET state = 'broken', break_reason = COALESCE(p_reason, 'Broken on the floor')
   WHERE id = p_opportunity_id RETURNING * INTO v_row;

  PERFORM public.wms_raise_exception(
    v_row.warehouse_id, 'other'::wms_exception_kind,
    'Cross-dock broken: ' || COALESCE(p_reason,'no reason given'),
    'wms_crossdock_opportunity', v_row.id, NULL, NULL, 2::smallint,
    jsonb_build_object('product_id', v_row.product_id, 'quantity', v_row.quantity,
                       'demand_doc_id', v_row.demand_doc_id)
  );

  PERFORM public.emit_crossdock_event('warehouse.crossdock.broken', v_row);
  RETURN v_row;
END $$;

-- Expiry sweep ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_crossdock_sweep_expired()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.wms_crossdock_opportunities; v_n int := 0;
BEGIN
  FOR v_row IN
    SELECT * FROM public.wms_crossdock_opportunities
     WHERE state IN ('detected','qualified','approved','staging')
       AND expires_at IS NOT NULL
       AND expires_at < now()
     FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.wms_tasks
       SET state = 'cancelled'::wms_task_state, cancel_reason = 'cross-dock window expired'
     WHERE id IN (v_row.stage_task_id, v_row.load_task_id)
       AND state NOT IN ('completed','done','cancelled');

    UPDATE public.wms_crossdock_opportunities
       SET state = 'expired', break_reason = 'Cut-off window elapsed'
     WHERE id = v_row.id RETURNING * INTO v_row;

    PERFORM public.wms_raise_exception(
      v_row.warehouse_id, 'stale_task'::wms_exception_kind,
      'Cross-dock opportunity expired before dispatch',
      'wms_crossdock_opportunity', v_row.id, NULL, NULL, 1::smallint,
      jsonb_build_object('expires_at', v_row.expires_at)
    );
    PERFORM public.emit_crossdock_event('warehouse.crossdock.expired', v_row);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

-- Legacy wrappers -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_crossdock_stage(p_opportunity_id uuid)
RETURNS public.wms_crossdock_opportunities
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.wms_crossdock_opportunities;
BEGIN
  SELECT * INTO v_row FROM public.wms_crossdock_opportunities WHERE id = p_opportunity_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'cross-dock opportunity not found'; END IF;
  IF v_row.state IN ('detected','qualified') THEN
    v_row := public.wms_crossdock_approve(p_opportunity_id, NULL);
  END IF;
  RETURN public.wms_crossdock_confirm_staged(p_opportunity_id, NULL);
END $$;

CREATE OR REPLACE FUNCTION public.cancel_crossdock_opportunity(
  p_opportunity_id uuid, p_reason text DEFAULT NULL
) RETURNS public.wms_crossdock_opportunities
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.wms_crossdock_opportunities;
BEGIN
  v_row := public._wms_crossdock_guard(p_opportunity_id, NULL,
             ARRAY['detected','qualified','approved','staging']::public.wms_crossdock_state[]);

  UPDATE public.wms_tasks
     SET state = 'cancelled'::wms_task_state, cancel_reason = COALESCE(p_reason,'cross-dock cancelled')
   WHERE id IN (v_row.stage_task_id, v_row.load_task_id)
     AND state NOT IN ('completed','done','cancelled');

  UPDATE public.wms_crossdock_opportunities
     SET state = 'cancelled', cancelled_at = now(), cancel_reason = p_reason
   WHERE id = p_opportunity_id RETURNING * INTO v_row;

  PERFORM public.emit_crossdock_event('warehouse.crossdock.cancelled', v_row);
  RETURN v_row;
END $$;

-- Hourly sweep ----------------------------------------------------------
SELECT cron.unschedule('wms-crossdock-expiry-sweep')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'wms-crossdock-expiry-sweep');

SELECT cron.schedule(
  'wms-crossdock-expiry-sweep',
  '7 * * * *',
  $cron$ SELECT public.wms_crossdock_sweep_expired(); $cron$
);