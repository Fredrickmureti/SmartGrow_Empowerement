-- 1. Caller authorization for the manual "Post now" verb -----------------
CREATE OR REPLACE FUNCTION public.accounting_post_event(
  p_event_id uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_evt      public.accounting_events%ROWTYPE;
  v_key      text;
  v_pos_res  jsonb;
  v_je       uuid;
  v_outcome  text;
  v_diag     jsonb;
  v_result   jsonb;
  v_caller   uuid := auth.uid();
BEGIN
  SELECT * INTO v_evt FROM public.accounting_events
   WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting_post_event: event % not found', p_event_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Interactive callers must hold access to the event's company.
  -- Background workers (service_role / outbox dispatcher) have no
  -- auth.uid() and keep their existing unattended path.
  IF v_caller IS NOT NULL
     AND NOT public.user_has_business_access(v_caller, v_evt.business_id) THEN
    RAISE EXCEPTION
      'accounting_post_event: caller lacks access to business %', v_evt.business_id
      USING ERRCODE = '42501';
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

  IF v_evt.producer = 'pos' AND v_evt.event_kind = 'shift_close' THEN
    -- Orphaned event: the producing document no longer exists (e.g. the
    -- org's transactional data was wiped). Never leave it "ready" to be
    -- retried forever; cancel it with proof.
    IF NOT EXISTS (SELECT 1 FROM public.pos_statements s
                    WHERE s.id = v_evt.producer_doc_id) THEN
      v_diag := jsonb_build_object('reason','producer_doc_missing',
                                   'producer_doc_id', v_evt.producer_doc_id);
      UPDATE public.accounting_events
         SET state = 'cancelled', last_diagnostic = v_diag, updated_at = now()
       WHERE id = v_evt.id;
      RETURN jsonb_build_object('event_id', v_evt.id, 'outcome','cancelled',
                                'diagnostics', v_diag);
    END IF;

    BEGIN
      v_pos_res := public.post_pos_statement_gl(v_evt.producer_doc_id, v_key);
    EXCEPTION
      WHEN check_violation THEN
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

  v_diag := jsonb_build_object(
    'reason','no_builder',
    'producer', v_evt.producer, 'event_kind', v_evt.event_kind);
  UPDATE public.accounting_events
     SET state='invalid', last_diagnostic=v_diag, updated_at=now()
   WHERE id=v_evt.id;
  RETURN jsonb_build_object(
    'event_id', v_evt.id, 'outcome', 'invalid',
    'diagnostics', v_diag);
END
$function$;

REVOKE ALL ON FUNCTION public.accounting_post_event(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accounting_post_event(uuid, text) TO authenticated, service_role;

-- 2. POS teardown must also clear the accounting pipeline ----------------
CREATE OR REPLACE FUNCTION public.reset_module__pos(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  IF to_regclass('public.pos_split_bill_items') IS NOT NULL THEN
    WITH d AS (
      DELETE FROM pos_split_bill_items
       WHERE portion_id IN (
         SELECT p.id FROM pos_split_bill_portions p
         JOIN pos_split_bills b ON b.id = p.split_bill_id
         WHERE b.organization_id = org_id
       )
       RETURNING 1
    ) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_split_bill_items', n);
  END IF;

  IF to_regclass('public.pos_split_bill_portions') IS NOT NULL THEN
    WITH d AS (
      DELETE FROM pos_split_bill_portions
       WHERE split_bill_id IN (SELECT id FROM pos_split_bills WHERE organization_id = org_id)
       RETURNING 1
    ) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_split_bill_portions', n);
  END IF;

  IF to_regclass('public.pos_split_bills') IS NOT NULL THEN
    WITH d AS (DELETE FROM pos_split_bills WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_split_bills', n);
  END IF;

  IF to_regclass('public.pos_kitchen_tickets') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM pos_kitchen_tickets WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('pos_kitchen_tickets', n);
  END IF;

  IF to_regclass('public.pos_kitchen_orders') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM pos_kitchen_orders WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('pos_kitchen_orders', n);
  END IF;

  IF to_regclass('public.pos_table_sessions') IS NOT NULL THEN
    WITH d AS (DELETE FROM pos_table_sessions WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_table_sessions', n);
  END IF;

  IF to_regclass('public.pos_gift_card_transactions') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM pos_gift_card_transactions WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('pos_gift_card_transactions', n);
  END IF;

  IF to_regclass('public.pos_held_transactions') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM pos_held_transactions WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('pos_held_transactions', n);
  END IF;

  IF to_regclass('public.pos_transaction_items') IS NOT NULL THEN
    WITH d AS (DELETE FROM pos_transaction_items WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_transaction_items', n);
  END IF;

  IF to_regclass('public.pos_transactions') IS NOT NULL THEN
    WITH d AS (DELETE FROM pos_transactions WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_transactions', n);
  END IF;

  -- Ledger aggregates that FK to pos_shifts with ON DELETE RESTRICT.
  IF to_regclass('public.pos_statements') IS NOT NULL THEN
    WITH d AS (DELETE FROM pos_statements WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_statements', n);
  END IF;

  IF to_regclass('public.pos_shifts') IS NOT NULL THEN
    WITH d AS (DELETE FROM pos_shifts WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_shifts', n);
  END IF;

  IF to_regclass('public.cashier_registers') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM cashier_registers WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('cashier_registers', n);
  END IF;

  -- Posting-engine projections of the POS documents deleted above.
  -- Without this the Accounting Events workspace keeps showing shift
  -- closes whose statements no longer exist, and the outbox dispatcher
  -- keeps retrying messages for deleted documents.
  IF to_regclass('public.accounting_events') IS NOT NULL THEN
    WITH d AS (
      DELETE FROM accounting_events
       WHERE org_id = reset_module__pos.org_id AND producer = 'pos'
       RETURNING 1
    ) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('accounting_events', n);
  END IF;

  IF to_regclass('public.business_event_outbox') IS NOT NULL THEN
    WITH d AS (
      DELETE FROM business_event_outbox
       WHERE org_id = reset_module__pos.org_id
         AND source_doc_type IN ('pos_transaction','pos_shift','pos_statement',
                                 'pos_payment_session','pos_split_bill')
       RETURNING 1
    ) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('business_event_outbox', n);
  END IF;

  IF to_regclass('public.business_event_outbox_dead') IS NOT NULL THEN
    WITH d AS (
      DELETE FROM business_event_outbox_dead
       WHERE org_id = reset_module__pos.org_id
         AND source_doc_type IN ('pos_transaction','pos_shift','pos_statement',
                                 'pos_payment_session','pos_split_bill')
       RETURNING 1
    ) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('business_event_outbox_dead', n);
  END IF;

  RETURN v;
END;
$function$;

-- 3. One-time cleanup of the rows the previous wipe left behind ----------
DELETE FROM public.accounting_events e
 WHERE e.producer = 'pos'
   AND NOT EXISTS (SELECT 1 FROM public.pos_statements s WHERE s.id = e.producer_doc_id);

DELETE FROM public.business_event_outbox o
 WHERE o.source_doc_type = 'pos_transaction'
   AND NOT EXISTS (SELECT 1 FROM public.pos_transactions t WHERE t.id = o.source_doc_id);

DELETE FROM public.business_event_outbox o
 WHERE o.source_doc_type = 'pos_statement'
   AND NOT EXISTS (SELECT 1 FROM public.pos_statements s WHERE s.id = o.source_doc_id);

DELETE FROM public.business_event_outbox o
 WHERE o.source_doc_type = 'pos_shift'
   AND NOT EXISTS (SELECT 1 FROM public.pos_shifts s WHERE s.id = o.source_doc_id);

DELETE FROM public.business_event_outbox o
 WHERE o.source_doc_type = 'pos_payment_session'
   AND NOT EXISTS (SELECT 1 FROM public.pos_payment_sessions s WHERE s.id = o.source_doc_id);