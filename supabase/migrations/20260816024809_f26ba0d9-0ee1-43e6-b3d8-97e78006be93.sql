CREATE OR REPLACE FUNCTION public.reset_module__warehouse(org_id uuid, p_business_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v        jsonb := '{}'::jsonb;
  n        bigint;
  t        text;
  v_pass   int;
  v_left   text[] := '{}';
  v_next   text[] := '{}';
  v_has_org boolean;
  v_has_biz boolean;
  v_where  text;
  v_sql    text;
  v_tables text[] := ARRAY[
    'wms_qc_inspection_checks',
    'wms_qc_inspections',
    'wms_count_lines',
    'wms_count_sessions',
    'wms_manifest_cartons',
    'wms_loading_manifests',
    'wms_pick_wave_lines',
    'wms_pick_waves',
    'wms_pack_cartons',
    'wms_return_lines',
    'wms_return_orders',
    'wms_crossdock_opportunities',
    'wms_putaway_suggestions',
    'wms_tasks',
    'wms_billable_activities',
    'wms_packaging_events',
    'wms_client_scan_receipts',
    'wms_sscc_events',
    'wms_sscc_registry',
    'wms_lpn_events',
    'wms_receiving_lines',
    'wms_receiving_sessions',
    'wms_license_plates',
    'wms_exceptions',
    'wms_dock_appointments',
    'wms_trailer_visits'
  ];
BEGIN
  IF coalesce(current_setting('app.reset_in_progress', true), '') = '' THEN
    RAISE EXCEPTION 'reset_module__warehouse must be called inside a governance teardown context'
      USING ERRCODE = '55000';
  END IF;

  -- wms_qc_inspection_checks carries neither organization_id nor business_id;
  -- it is scoped through its parent inspection.
  IF to_regclass('public.wms_qc_inspection_checks') IS NOT NULL THEN
    EXECUTE $q$
      WITH d AS (
        DELETE FROM public.wms_qc_inspection_checks
         WHERE inspection_id IN (
           SELECT id FROM public.wms_qc_inspections
            WHERE organization_id = $1
              AND ($2 IS NULL OR business_id = $2)
         )
        RETURNING 1
      ) SELECT count(*) FROM d
    $q$ INTO n USING org_id, p_business_id;
    v := v || jsonb_build_object('wms_qc_inspection_checks', n);
  END IF;

  -- stock_quants.lpn_id is ON DELETE RESTRICT: a single quant parked on a
  -- handling unit blocks wms_license_plates forever, because the retry loop
  -- below can only reorder WMS tables and the inventory sweep runs later.
  -- Clear the stock positions here; reset_module__inventory is idempotent and
  -- will simply find nothing left.
  IF to_regclass('public.stock_quants') IS NOT NULL THEN
    WITH d AS (
      DELETE FROM public.stock_quants
       WHERE organization_id = org_id
         AND (p_business_id IS NULL OR business_id = p_business_id)
      RETURNING 1
    ) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('stock_quants', n);
  END IF;

  v_left := v_tables;

  FOR v_pass IN 1..4 LOOP
    v_next := '{}';
    FOREACH t IN ARRAY v_left LOOP
      IF t = 'wms_qc_inspection_checks' THEN
        CONTINUE;
      END IF;

      IF to_regclass('public.' || t) IS NULL THEN
        CONTINUE;
      END IF;

      SELECT bool_or(column_name = 'organization_id'),
             bool_or(column_name = 'business_id')
        INTO v_has_org, v_has_biz
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = t;

      IF v_has_org AND v_has_biz THEN
        v_where := 'organization_id = $1 AND ($2 IS NULL OR business_id = $2)';
      ELSIF v_has_org THEN
        v_where := 'organization_id = $1 AND ($2 IS NULL OR $2 IS NOT NULL)';
      ELSIF v_has_biz THEN
        v_where := 'business_id IN (SELECT id FROM public.businesses WHERE organization_id = $1)'
                || ' AND ($2 IS NULL OR business_id = $2)';
      ELSE
        CONTINUE;
      END IF;

      v_sql := 'WITH d AS (DELETE FROM public.' || quote_ident(t)
            || ' WHERE ' || v_where || ' RETURNING 1) SELECT count(*) FROM d';

      BEGIN
        EXECUTE v_sql INTO n USING org_id, p_business_id;
        v := v || jsonb_build_object(t, coalesce((v->>t)::bigint, 0) + n);
      EXCEPTION WHEN foreign_key_violation THEN
        v_next := v_next || t;
      END;
    END LOOP;

    v_left := v_next;
    EXIT WHEN array_length(v_left, 1) IS NULL;
  END LOOP;

  IF array_length(v_left, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'reset_module__warehouse could not clear: %', array_to_string(v_left, ', ')
      USING ERRCODE = '23503';
  END IF;

  RETURN v;
END;
$function$;