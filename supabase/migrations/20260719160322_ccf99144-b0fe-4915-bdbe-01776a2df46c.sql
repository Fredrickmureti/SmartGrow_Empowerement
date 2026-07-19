
-- B3.1 — Single Posting Engine RPC.
-- Every producer (POS, Sales, Purchase, Payroll, ...) posts through
-- this function. The dispatcher calls it via accounting_event_id, so
-- outbox retries collapse into a single posting attempt per event.
--
-- Contract (AccountingPostingResult):
--   { event_id, outcome, journal_entry_id?, unresolved?, diagnostics }
--   outcome ∈ { 'posted','noop','needs_mapping','invalid','deferred' }
--
-- The dispatcher (B1 hardening extended in this batch) marks the
-- outbox row 'succeeded' only for outcome in ('posted','noop').
-- 'needs_mapping'|'invalid' → 'blocked' (no retry budget consumed).
-- 'deferred' or any thrown exception → 'failed' (retry with backoff).

CREATE OR REPLACE FUNCTION public.accounting_post_event(
  p_event_id uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_evt      public.accounting_events%ROWTYPE;
  v_key      text;
  v_pos_res  jsonb;
  v_je       uuid;
  v_outcome  text;
  v_diag     jsonb;
  v_result   jsonb;
BEGIN
  SELECT * INTO v_evt FROM public.accounting_events
   WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting_post_event: event % not found', p_event_id
      USING ERRCODE = 'P0002';
  END IF;

  v_key := COALESCE(p_idempotency_key, v_evt.business_idempotency_key);

  -- Terminal states are no-ops with proof.
  IF v_evt.state IN ('posted','superseded','cancelled') THEN
    RETURN jsonb_build_object(
      'event_id', v_evt.id,
      'outcome', 'noop',
      'journal_entry_id', v_evt.journal_entry_id,
      'diagnostics', jsonb_build_object('reason', 'already_' || v_evt.state)
    );
  END IF;

  -- Mark posting so concurrent workers can see the claim.
  UPDATE public.accounting_events
     SET state = 'posting', validated_at = COALESCE(validated_at, now())
   WHERE id = v_evt.id;

  -- Producer dispatch. POS is the only one wired in B3; future
  -- producers add another WHEN branch.
  IF v_evt.producer = 'pos' AND v_evt.event_kind = 'shift_close' THEN
    BEGIN
      v_pos_res := public.post_pos_statement_gl(v_evt.producer_doc_id, v_key);
    EXCEPTION
      WHEN check_violation THEN
        -- resolve_pos_tender_gl_account raises check_violation when a
        -- tender has no GL account. That's a configuration problem,
        -- not a transient failure — surface as needs_mapping.
        v_diag := jsonb_build_object('reason', 'needs_mapping',
                                     'sqlerrm', SQLERRM);
        UPDATE public.accounting_events
           SET state = 'needs_mapping',
               last_diagnostic = v_diag,
               updated_at = now()
         WHERE id = v_evt.id;
        RETURN jsonb_build_object(
          'event_id', v_evt.id, 'outcome', 'needs_mapping',
          'diagnostics', v_diag);
      WHEN OTHERS THEN
        v_diag := jsonb_build_object(
          'reason','builder_error',
          'sqlstate', SQLSTATE, 'sqlerrm', SQLERRM);
        UPDATE public.accounting_events
           SET state = 'failed',
               last_diagnostic = v_diag,
               updated_at = now()
         WHERE id = v_evt.id;
        -- Re-raise so the dispatcher records the failure and retries.
        RAISE;
    END;

    IF v_pos_res ? 'journal_entry_id' AND (v_pos_res->>'journal_entry_id') IS NOT NULL THEN
      v_je      := (v_pos_res->>'journal_entry_id')::uuid;
      v_outcome := 'posted';
    ELSIF COALESCE((v_pos_res->>'already_posted')::boolean, false) THEN
      v_je      := NULLIF(v_pos_res->>'journal_entry_id','')::uuid;
      v_outcome := 'posted';
    ELSIF COALESCE((v_pos_res->>'skipped')::boolean, false)
       OR COALESCE((v_pos_res->>'empty')::boolean, false) THEN
      v_outcome := 'noop';
    ELSE
      -- Should never happen after B1 hardening, but stay defensive.
      v_diag := jsonb_build_object(
        'reason','builder_contract_violation',
        'builder_result', v_pos_res);
      UPDATE public.accounting_events
         SET state = 'failed',
             last_diagnostic = v_diag,
             updated_at = now()
       WHERE id = v_evt.id;
      RAISE EXCEPTION
        'accounting_post_event: builder returned no posted/noop proof for event %',
        v_evt.id USING ERRCODE = 'raise_exception';
    END IF;

    v_diag := jsonb_build_object('reason', v_outcome,
                                 'builder_result', v_pos_res);
    UPDATE public.accounting_events
       SET state = CASE v_outcome WHEN 'posted' THEN 'posted' ELSE 'noop' END,
           journal_entry_id = COALESCE(v_je, journal_entry_id),
           posted_at = CASE WHEN v_outcome='posted' THEN COALESCE(posted_at, now()) ELSE posted_at END,
           last_diagnostic = v_diag,
           updated_at = now()
     WHERE id = v_evt.id;

    v_result := jsonb_build_object(
      'event_id', v_evt.id,
      'outcome', v_outcome,
      'journal_entry_id', v_je,
      'diagnostics', v_diag);
    RETURN v_result;
  END IF;

  -- Unknown producer/event_kind — never silently succeed.
  v_diag := jsonb_build_object(
    'reason','no_builder',
    'producer', v_evt.producer, 'event_kind', v_evt.event_kind);
  UPDATE public.accounting_events
     SET state='invalid', last_diagnostic=v_diag, updated_at=now()
   WHERE id=v_evt.id;
  RETURN jsonb_build_object(
    'event_id', v_evt.id, 'outcome', 'invalid',
    'diagnostics', v_diag);
END $$;

REVOKE ALL ON FUNCTION public.accounting_post_event(uuid, text) FROM PUBLIC, authenticated, anon;
GRANT  EXECUTE ON FUNCTION public.accounting_post_event(uuid, text) TO service_role;

-- Helper: resolve the accounting_event for a POS statement. Idempotent
-- and side-effect-free; the dispatcher calls it to convert from the
-- statement-shaped outbox payload to the event-shaped engine input.
CREATE OR REPLACE FUNCTION public.accounting_event_for_pos_statement(
  p_statement_id uuid
) RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT id FROM public.accounting_events
   WHERE producer='pos' AND producer_doc_type='pos_statement'
     AND producer_doc_id = p_statement_id
   ORDER BY created_at DESC
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.accounting_event_for_pos_statement(uuid) FROM PUBLIC, authenticated, anon;
GRANT  EXECUTE ON FUNCTION public.accounting_event_for_pos_statement(uuid) TO service_role;
