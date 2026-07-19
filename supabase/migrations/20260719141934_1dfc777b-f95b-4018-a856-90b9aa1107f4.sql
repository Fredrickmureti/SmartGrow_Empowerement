CREATE OR REPLACE FUNCTION public.retry_pos_statement_posting(p_statement_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_stmt        public.pos_statements%ROWTYPE;
  v_key         text;
  v_outbox_id   uuid;
  v_uid         uuid := auth.uid();
  v_allowed     boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'retry_pos_statement_posting: authentication required'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_stmt FROM public.pos_statements WHERE id = p_statement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retry_pos_statement_posting: statement % not found', p_statement_id
      USING ERRCODE = 'P0002';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = v_uid
       AND role::text IN ('admin','owner','super_admin','accountant')
       AND (organization_id IS NULL OR organization_id = v_stmt.organization_id)
  ) INTO v_allowed;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'retry_pos_statement_posting: not permitted (admin, owner, super_admin, or accountant required)'
      USING ERRCODE = '42501';
  END IF;

  IF v_stmt.posting_status = 'posted'::pos_statement_posting_status THEN
    RETURN jsonb_build_object(
      'statement_id', v_stmt.id, 'already_posted', true,
      'journal_entry_id', v_stmt.journal_entry_id);
  END IF;
  IF v_stmt.closed_at IS NULL THEN
    RAISE EXCEPTION 'retry_pos_statement_posting: statement % is not closed', v_stmt.id
      USING ERRCODE = '22023';
  END IF;
  IF v_stmt.close_kind = 'historical_backfill'::pos_statement_close_kind THEN
    RAISE EXCEPTION 'retry_pos_statement_posting: historical backfill statements do not post'
      USING ERRCODE = '22023';
  END IF;

  v_key := 'pos-stmt-post-' || v_stmt.id::text || '-retry-' || (extract(epoch FROM now())::bigint)::text;

  INSERT INTO public.business_event_outbox
    (org_id, branch_id, event_type, source_doc_type, source_doc_id,
     payload, source, idempotency_key, actor_user_id, handler_scope)
  VALUES
    (v_stmt.organization_id, v_stmt.branch_id,
     'pos.statement.posting.requested',
     'pos_statement', v_stmt.id,
     jsonb_build_object(
       'statement_id',     v_stmt.id,
       'statement_number', v_stmt.statement_number,
       'shift_id',         v_stmt.shift_id,
       'close_kind',       v_stmt.close_kind,
       'total_sales',      v_stmt.total_sales,
       'total_returns',    v_stmt.total_returns,
       'total_tax',        v_stmt.total_tax,
       'business_id',      v_stmt.business_id,
       'retry',            true,
       'requested_by',     v_uid,
       'reason',           p_reason
     ),
     'pos', v_key, v_uid, 'server')
  RETURNING id INTO v_outbox_id;

  INSERT INTO public.pos_statement_posting_retries
    (organization_id, business_id, branch_id, statement_id, shift_id,
     requested_by, reason, idempotency_key, outbox_event_id)
  VALUES
    (v_stmt.organization_id, v_stmt.business_id, v_stmt.branch_id,
     v_stmt.id, v_stmt.shift_id, v_uid, p_reason, v_key, v_outbox_id);

  RETURN jsonb_build_object(
    'statement_id', v_stmt.id,
    'outbox_event_id', v_outbox_id,
    'idempotency_key', v_key,
    'queued', true);
END $function$;

GRANT EXECUTE ON FUNCTION public.retry_pos_statement_posting(uuid, text) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';