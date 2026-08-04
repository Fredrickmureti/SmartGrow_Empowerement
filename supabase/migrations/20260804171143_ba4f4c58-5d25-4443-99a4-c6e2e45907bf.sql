
DO $$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'wms_replay_guarded_call';

  IF v_def IS NULL THEN RAISE EXCEPTION 'wms_replay_guarded_call missing'; END IF;

  v_new := replace(
    v_def,
    'v_result := public.complete_putaway_task((p_args->>''p_task_id'')::uuid);',
    'v_result := public.complete_putaway_task(
        (p_args->>''p_task_id'')::uuid,
        NULLIF(p_args->>''p_location_id'','''')::uuid,
        NULLIF(p_args->>''p_override_reason'','''')
      );'
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'could not patch complete_putaway_task dispatch branch';
  END IF;

  v_def := v_new;
  v_new := replace(
    v_def,
    'WHEN ''complete_pack_task'' THEN',
    'WHEN ''wms_split_putaway_task'' THEN
      v_result := public.wms_split_putaway_task(
        (p_args->>''p_task_id'')::uuid,
        (p_args->>''p_quantity'')::numeric,
        NULLIF(p_args->>''p_location_id'','''')::uuid,
        NULLIF(p_args->>''p_reason'','''')
      );
      SELECT t.business_id, t.organization_id, t.warehouse_id
        INTO v_business, v_org, v_warehouse
        FROM public.wms_tasks t WHERE t.id = (p_args->>''p_task_id'')::uuid;

    WHEN ''wms_report_putaway_exception'' THEN
      v_result := public.wms_report_putaway_exception(
        (p_args->>''p_task_id'')::uuid,
        (p_args->>''p_kind'')::public.wms_exception_kind,
        p_args->>''p_reason'',
        COALESCE(p_args->''p_details'', ''{}''::jsonb)
      );
      SELECT t.business_id, t.organization_id, t.warehouse_id
        INTO v_business, v_org, v_warehouse
        FROM public.wms_tasks t WHERE t.id = (p_args->>''p_task_id'')::uuid;

    WHEN ''complete_pack_task'' THEN'
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'could not add putaway split/exception dispatch branches';
  END IF;

  EXECUTE v_new;
END $$;
