CREATE OR REPLACE FUNCTION public.physical_count_submit(p_count_id uuid, p_user_id uuid, p_allow_self boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_c RECORD; v_flagged int := 0;
BEGIN
  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'physical count % not found', p_count_id USING ERRCODE='P0001'; END IF;
  IF v_c.state <> 'counting' THEN
    RAISE EXCEPTION 'cannot submit count in state %', v_c.state USING ERRCODE='P0001';
  END IF;

  -- Block submission while any line is still awaiting a first count OR a
  -- requested recount. Previously only status='pending' was checked, which
  -- let lines that were sent back for a recount (status='recount_required',
  -- counted_qty cleared) slip into review, where approval was then
  -- permanently blocked with no way to resolve them.
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

  -- Governance: submitter vs creator (engine decides based on governance_mode)
  PERFORM public.governance_assert_not_self(
    p_user_id, v_c.created_by, 'inventory.submit_count',
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
     SET state = 'in_review', submitted_at = now(), submitted_by = p_user_id
   WHERE id = p_count_id;

  INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
  VALUES (p_count_id, v_c.organization_id, 'submitted', p_user_id,
          jsonb_build_object('lines_flagged_recount', v_flagged, 'allow_self', p_allow_self));

  RETURN jsonb_build_object('success', true, 'lines_flagged_recount', v_flagged);
END $function$;