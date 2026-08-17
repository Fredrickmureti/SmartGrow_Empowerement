-- 1. Give the token-generating functions access to the encryption helpers.
DO $fix$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND pg_get_functiondef(p.oid) LIKE '%gen_random_bytes%'
       AND COALESCE(array_to_string(p.proconfig, ','), '') NOT LIKE '%extensions%'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, extensions', r.sig);
  END LOOP;
END $fix$;

-- 2. Wave readiness: compare lifecycle states as text so unknown labels cannot abort the check.
CREATE OR REPLACE FUNCTION public.wms_wave_readiness(p_wave_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_wave        public.wms_pick_waves;
  v_policy      public.wms_wave_policies;
  v_rules       jsonb;
  v_lines       int := 0;
  v_short_lines int := 0;
  v_open_units  numeric := 0;
  v_cover_units numeric := 0;
  v_labour      record;
  v_need_sec    numeric;
  v_exceptions  int := 0;
  v_qc          int := 0;
  v_frozen      int := 0;
  v_open_tasks  int := 0;
  v_operators   int := 0;
  v_raw         jsonb := '[]'::jsonb;
  v_checks      jsonb := '[]'::jsonb;
  v_c           jsonb;
  v_mode        text;
  v_eff         text;
  v_state       text := 'ready';
BEGIN
  SELECT * INTO v_wave FROM public.wms_pick_waves WHERE id = p_wave_id;
  IF v_wave.id IS NULL THEN
    RAISE EXCEPTION 'wave % not found', p_wave_id USING ERRCODE = 'P0002';
  END IF;
  PERFORM public._wms_assert_business_access(v_wave.business_id);

  SELECT * INTO v_policy FROM public.wms_wave_policies p
  WHERE p.business_id = v_wave.business_id
    AND (p.warehouse_id = v_wave.warehouse_id OR p.warehouse_id IS NULL)
  ORDER BY (p.warehouse_id IS NOT NULL) DESC, p.is_default DESC, p.created_at
  LIMIT 1;

  v_rules := COALESCE(v_policy.readiness_rules, jsonb_build_object(
    'stock','block','labour','warn','departure','warn','exceptions','warn',
    'quality','block','freeze','warn','congestion','warn'));

  -- stock coverage ------------------------------------------------------
  SELECT count(*),
         count(*) FILTER (WHERE cover.available < l.qty_open),
         COALESCE(sum(l.qty_open), 0),
         COALESCE(sum(LEAST(l.qty_open, cover.available)), 0)
    INTO v_lines, v_short_lines, v_open_units, v_cover_units
  FROM (
    SELECT wl.product_id, wl.lot_number,
           GREATEST(COALESCE(wl.quantity_ordered,0) - COALESCE(wl.quantity_picked,0), 0) AS qty_open
    FROM public.wms_pick_wave_lines wl
    WHERE wl.wave_id = p_wave_id
  ) l
  JOIN LATERAL (
    SELECT COALESCE(sum(GREATEST(sq.quantity - COALESCE(sq.reserved_quantity,0), 0)), 0) AS available
    FROM public.stock_quants sq
    JOIN public.stock_locations sl ON sl.id = sq.location_id
    WHERE sq.product_id = l.product_id
      AND sl.warehouse_id = v_wave.warehouse_id
      AND sl.is_active
      AND COALESCE(sl.is_blocked, false) = false
      AND COALESCE(sl.is_receiving_staging, false) = false
      AND (l.lot_number IS NULL OR sq.lot_number = l.lot_number)
  ) cover ON true;

  v_raw := v_raw || jsonb_build_object(
    'check', 'stock',
    'state', CASE WHEN v_lines = 0 THEN 'blocked'
                  WHEN v_cover_units <= 0 THEN 'blocked'
                  WHEN v_short_lines > 0 THEN 'at_risk'
                  ELSE 'ready' END,
    'detail', jsonb_build_object(
      'lines', v_lines, 'short_lines', v_short_lines,
      'open_units', v_open_units, 'covered_units', v_cover_units,
      'coverage_pct', CASE WHEN v_open_units > 0
                           THEN ROUND(100 * v_cover_units / v_open_units, 1) ELSE 0 END),
    'reason', CASE WHEN v_lines = 0 THEN 'wave has no open lines'
                   WHEN v_cover_units <= 0 THEN 'no pickable stock for any line'
                   WHEN v_short_lines > 0 THEN v_short_lines || ' line(s) short' END
  );

  -- labour --------------------------------------------------------------
  SELECT * INTO v_labour
  FROM public.wms_labour_plan(v_wave.warehouse_id, current_date, current_date) LIMIT 1;

  v_need_sec := COALESCE(v_wave.estimated_pick_minutes, v_lines * 1.5) * 60;

  v_raw := v_raw || jsonb_build_object(
    'check', 'labour',
    'state', CASE
      WHEN COALESCE(v_labour.planned_operators, 0) = 0 THEN 'at_risk'
      WHEN COALESCE(v_labour.planned_seconds, 0) - COALESCE(v_labour.required_seconds, 0) < v_need_sec THEN 'at_risk'
      ELSE 'ready' END,
    'detail', jsonb_build_object(
      'required_seconds', v_need_sec,
      'planned_seconds', COALESCE(v_labour.planned_seconds, 0),
      'committed_seconds', COALESCE(v_labour.required_seconds, 0),
      'planned_operators', COALESCE(v_labour.planned_operators, 0)),
    'reason', CASE
      WHEN COALESCE(v_labour.planned_operators, 0) = 0
        THEN 'no operators planned for today'
      WHEN COALESCE(v_labour.planned_seconds,0) - COALESCE(v_labour.required_seconds,0) < v_need_sec
        THEN 'planned labour does not cover this wave on top of committed work' END
  );

  -- departure -----------------------------------------------------------
  v_raw := v_raw || jsonb_build_object(
    'check', 'departure',
    'state', CASE
      WHEN v_wave.cutoff_at IS NOT NULL AND v_wave.cutoff_at < now() THEN 'blocked'
      WHEN v_wave.dock_id IS NULL AND v_wave.appointment_id IS NULL THEN 'at_risk'
      WHEN v_wave.cutoff_at IS NOT NULL
           AND v_wave.cutoff_at < now() + (COALESCE(v_wave.estimated_pick_minutes,0) || ' minutes')::interval
        THEN 'at_risk'
      ELSE 'ready' END,
    'detail', jsonb_build_object(
      'dock_id', v_wave.dock_id, 'appointment_id', v_wave.appointment_id,
      'cutoff_at', v_wave.cutoff_at, 'carrier_id', v_wave.carrier_id),
    'reason', CASE
      WHEN v_wave.cutoff_at IS NOT NULL AND v_wave.cutoff_at < now() THEN 'cut-off has passed'
      WHEN v_wave.dock_id IS NULL AND v_wave.appointment_id IS NULL THEN 'no dock or appointment assigned'
      WHEN v_wave.cutoff_at IS NOT NULL
           AND v_wave.cutoff_at < now() + (COALESCE(v_wave.estimated_pick_minutes,0) || ' minutes')::interval
        THEN 'estimated pick time runs past the cut-off' END
  );

  -- exceptions ----------------------------------------------------------
  SELECT count(*) INTO v_exceptions
  FROM public.wms_exceptions e
  WHERE e.aggregate_type = 'wms_pick_wave'
    AND e.aggregate_id = p_wave_id
    AND e.state::text NOT IN ('resolved','wont_fix','cancelled');

  v_raw := v_raw || jsonb_build_object(
    'check', 'exceptions',
    'state', CASE WHEN v_exceptions > 0 THEN 'at_risk' ELSE 'ready' END,
    'detail', jsonb_build_object('open', v_exceptions),
    'reason', CASE WHEN v_exceptions > 0 THEN v_exceptions || ' open exception(s)' END
  );

  -- quality holds on the wave's products --------------------------------
  SELECT count(*) INTO v_qc
  FROM public.wms_qc_inspections q
  WHERE q.warehouse_id = v_wave.warehouse_id
    AND q.state::text NOT IN ('closed','cancelled','completed','passed','accepted','resolved')
    AND EXISTS (
      SELECT 1 FROM public.wms_pick_wave_lines wl
      WHERE wl.wave_id = p_wave_id AND wl.product_id = q.product_id
    );

  v_raw := v_raw || jsonb_build_object(
    'check', 'quality',
    'state', CASE WHEN v_qc > 0 THEN 'blocked' ELSE 'ready' END,
    'detail', jsonb_build_object('open_inspections', v_qc),
    'reason', CASE WHEN v_qc > 0
      THEN v_qc || ' open quality inspection(s) on this wave''s products' END
  );

  -- inventory freeze (live counts over the wave's products) --------------
  SELECT count(DISTINCT cs.id) INTO v_frozen
  FROM public.wms_count_sessions cs
  JOIN public.wms_count_lines cl ON cl.session_id = cs.id
  WHERE cs.warehouse_id = v_wave.warehouse_id
    AND cs.state::text NOT IN ('posted','cancelled','closed','completed')
    AND EXISTS (
      SELECT 1 FROM public.wms_pick_wave_lines wl
      WHERE wl.wave_id = p_wave_id AND wl.product_id = cl.product_id
    );

  v_raw := v_raw || jsonb_build_object(
    'check', 'freeze',
    'state', CASE WHEN v_frozen > 0 THEN 'blocked' ELSE 'ready' END,
    'detail', jsonb_build_object('active_count_sessions', v_frozen),
    'reason', CASE WHEN v_frozen > 0
      THEN v_frozen || ' active count session(s) freeze stock this wave needs' END
  );

  -- floor congestion -----------------------------------------------------
  SELECT count(*) INTO v_open_tasks
  FROM public.wms_tasks t
  WHERE t.warehouse_id = v_wave.warehouse_id
    AND t.state::text IN ('pending','assigned','in_progress','available','claimed');

  SELECT count(DISTINCT s.operator_id) INTO v_operators
  FROM public.wms_operator_shifts s
  WHERE s.warehouse_id = v_wave.warehouse_id
    AND s.shift_date = current_date
    AND COALESCE(s.status::text,'planned') NOT IN ('cancelled','no_show');

  v_raw := v_raw || jsonb_build_object(
    'check', 'congestion',
    'state', CASE
      WHEN v_open_tasks = 0 THEN 'ready'
      WHEN v_operators = 0 THEN 'blocked'
      WHEN v_open_tasks::numeric / v_operators > 60 THEN 'blocked'
      WHEN v_open_tasks::numeric / v_operators > 30 THEN 'at_risk'
      ELSE 'ready' END,
    'detail', jsonb_build_object(
      'open_tasks', v_open_tasks, 'operators_on_shift', v_operators,
      'tasks_per_operator', CASE WHEN v_operators > 0
        THEN ROUND(v_open_tasks::numeric / v_operators, 1) ELSE NULL END),
    'reason', CASE
      WHEN v_open_tasks > 0 AND v_operators = 0 THEN 'open work on the floor with nobody on shift'
      WHEN v_operators > 0 AND v_open_tasks::numeric / v_operators > 30
        THEN 'floor is already congested (' || ROUND(v_open_tasks::numeric / v_operators, 1) || ' open tasks per operator)' END
  );

  -- policy mapping -------------------------------------------------------
  FOR v_c IN SELECT * FROM jsonb_array_elements(v_raw) LOOP
    v_mode := COALESCE(v_rules->>(v_c->>'check'), 'warn');
    v_eff := CASE
      WHEN v_c->>'state' = 'ready' THEN 'ready'
      WHEN v_mode = 'ignore' THEN 'ready'
      WHEN v_mode = 'block'  THEN 'blocked'
      ELSE 'at_risk' END;
    v_checks := v_checks || (v_c
      || jsonb_build_object('raw_state', v_c->>'state', 'mode', v_mode, 'state', v_eff));
  END LOOP;

  SELECT CASE
    WHEN bool_or(c->>'state' = 'blocked') THEN 'blocked'
    WHEN bool_or(c->>'state' = 'at_risk') THEN 'at_risk'
    ELSE 'ready' END
  INTO v_state
  FROM jsonb_array_elements(v_checks) c;

  RETURN jsonb_build_object(
    'wave_id', p_wave_id, 'state', v_state, 'checked_at', now(),
    'policy_id', v_policy.id, 'policy_name', v_policy.name,
    'allow_force', COALESCE(v_policy.allow_force, true),
    'checks', v_checks);
END;
$function$;

-- 3. Attribute outbound work to a 3PL client through task -> wave -> order -> customer.
CREATE OR REPLACE FUNCTION public._wms_resolve_client_id(_business_id uuid, _payload jsonb, _aggregate_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_client uuid;
  v_lpn    uuid;
  v_wave   uuid;
BEGIN
  IF _business_id IS NULL THEN RETURN NULL; END IF;

  v_client := NULLIF(_payload->>'client_id','')::uuid;
  IF v_client IS NOT NULL THEN RETURN v_client; END IF;

  v_lpn := COALESCE(NULLIF(_payload->>'lpn_id','')::uuid,
                    NULLIF(_payload->>'license_plate_id','')::uuid);
  IF v_lpn IS NOT NULL THEN
    SELECT client_id INTO v_client FROM public.wms_license_plates WHERE id = v_lpn;
    IF v_client IS NOT NULL THEN RETURN v_client; END IF;
  END IF;

  IF _aggregate_id IS NOT NULL THEN
    SELECT client_id INTO v_client FROM public.wms_license_plates WHERE id = _aggregate_id;
    IF v_client IS NOT NULL THEN RETURN v_client; END IF;
    SELECT client_id INTO v_client FROM public.wms_receiving_sessions WHERE id = _aggregate_id;
    IF v_client IS NOT NULL THEN RETURN v_client; END IF;
    SELECT client_id INTO v_client FROM public.wms_loading_manifests WHERE id = _aggregate_id;
    IF v_client IS NOT NULL THEN RETURN v_client; END IF;
    SELECT client_id INTO v_client FROM public.wms_trailer_visits WHERE id = _aggregate_id;
    IF v_client IS NOT NULL THEN RETURN v_client; END IF;
  END IF;

  SELECT client_id INTO v_client FROM public.wms_receiving_sessions
   WHERE id = NULLIF(_payload->>'receiving_session_id','')::uuid;
  IF v_client IS NOT NULL THEN RETURN v_client; END IF;
  SELECT client_id INTO v_client FROM public.wms_loading_manifests
   WHERE id = NULLIF(_payload->>'manifest_id','')::uuid;
  IF v_client IS NOT NULL THEN RETURN v_client; END IF;
  SELECT client_id INTO v_client FROM public.wms_trailer_visits
   WHERE id = NULLIF(_payload->>'trailer_visit_id','')::uuid;
  IF v_client IS NOT NULL THEN RETURN v_client; END IF;

  -- Outbound execution work: task -> wave -> sales order -> customer -> client.
  v_wave := COALESCE(
    NULLIF(_payload->>'wave_id','')::uuid,
    (SELECT t.wave_id FROM public.wms_tasks t WHERE t.id = _aggregate_id));
  IF v_wave IS NOT NULL THEN
    SELECT bc.id INTO v_client
      FROM public.wms_pick_wave_lines wl
      JOIN public.sales_orders so ON so.id = wl.sales_order_id
      JOIN public.wms_billing_clients bc
        ON bc.business_id = _business_id
       AND bc.is_active
       AND (bc.contact_id = so.contact_id OR bc.client_business_id = so.business_id)
     WHERE wl.wave_id = v_wave
     LIMIT 1;
    IF v_client IS NOT NULL THEN RETURN v_client; END IF;
  END IF;

  RETURN NULL;
END; $function$;