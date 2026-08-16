CREATE OR REPLACE FUNCTION public.move_pos_table_session(
  p_session_id uuid,
  p_new_table_id uuid,
  p_notes text DEFAULT NULL,
  p_expected_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_session record;
  v_table record;
  v_txn record;
  v_occupied uuid;
BEGIN
  SELECT * INTO v_session FROM public.pos_table_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'session_not_found');
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_session.business_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.assert_pos_caller_branch_access(v_session.branch_id);

  IF v_session.closed_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'conflict', true, 'error', 'session_already_closed');
  END IF;

  SELECT * INTO v_table FROM public.pos_tables WHERE id = p_new_table_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'target_table_not_found');
  END IF;
  IF v_table.business_id IS DISTINCT FROM v_session.business_id
     OR v_table.branch_id IS DISTINCT FROM v_session.branch_id THEN
    RAISE EXCEPTION 'cross_scope_table_move_denied' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id INTO v_occupied FROM public.pos_table_sessions
   WHERE table_id = p_new_table_id AND closed_at IS NULL AND id <> p_session_id
   LIMIT 1;
  IF v_occupied IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'conflict', true, 'error', 'target_table_occupied');
  END IF;

  IF p_expected_version IS NOT NULL THEN
    SELECT id, version INTO v_txn FROM public.pos_transactions
     WHERE table_session_id = p_session_id AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
    IF v_txn.id IS NOT NULL AND v_txn.version IS DISTINCT FROM p_expected_version THEN
      RETURN jsonb_build_object('success', false, 'conflict', true, 'error', 'order_changed',
        'current_version', v_txn.version);
    END IF;
  END IF;

  UPDATE public.pos_table_sessions SET table_id = p_new_table_id WHERE id = p_session_id;

  INSERT INTO public.pos_table_transfers (
    organization_id, business_id, transfer_type,
    source_session_id, target_session_id, notes, created_by
  ) VALUES (
    v_session.organization_id, v_session.business_id, 'move_session',
    p_session_id, p_session_id, COALESCE(p_notes, 'Moved to another table'), auth.uid()
  );

  RETURN jsonb_build_object('success', true, 'session_id', p_session_id, 'table_id', p_new_table_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.move_pos_table_session(uuid, uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_pos_table_session(uuid, uuid, text, integer) TO authenticated, service_role;