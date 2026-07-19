CREATE OR REPLACE FUNCTION public.ensure_business_event_outbox_idempotency_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.idempotency_key IS NULL OR btrim(NEW.idempotency_key) = '' THEN
    NEW.idempotency_key := concat_ws(
      ':',
      'business_event',
      COALESCE(NEW.event_type, 'unknown_event'),
      COALESCE(NEW.source_doc_type, 'unknown_source'),
      COALESCE(NEW.source_doc_id::text, NEW.id::text, gen_random_uuid()::text)
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_business_event_outbox_ensure_idempotency_key
ON public.business_event_outbox;

CREATE TRIGGER trg_business_event_outbox_ensure_idempotency_key
BEFORE INSERT ON public.business_event_outbox
FOR EACH ROW
EXECUTE FUNCTION public.ensure_business_event_outbox_idempotency_key();

CREATE OR REPLACE FUNCTION public.pos_emit_register_period_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_topic text;
  v_payload jsonb;
  v_idempotency_key text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_topic := 'shift.opened';
  ELSIF TG_OP = 'UPDATE'
        AND OLD.status = 'open'
        AND NEW.status <> 'open' THEN
    IF NEW.force_closed_by IS NOT NULL AND OLD.force_closed_by IS NULL THEN
      v_topic := 'shift.force_closed';
    ELSIF NEW.actual_cash IS NULL THEN
      v_topic := 'shift.blind_closed';
    ELSE
      v_topic := 'shift.closed';
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  v_payload := jsonb_build_object(
    'shift_id',            NEW.id,
    'shift_number',        NEW.shift_number,
    'business_id',         NEW.business_id,
    'branch_id',           NEW.branch_id,
    'register_id',         NEW.register_id,
    'user_id',             NEW.user_id,
    'opened_at',           NEW.opened_at,
    'closed_at',           NEW.closed_at,
    'closed_by',           NEW.closed_by,
    'opening_cash',        NEW.opening_cash,
    'expected_cash',       NEW.expected_cash,
    'actual_cash',         NEW.actual_cash,
    'cash_difference',     NEW.cash_difference,
    'status',              NEW.status,
    'force_closed_by',     NEW.force_closed_by,
    'force_close_reason',  NEW.force_close_reason
  );

  v_idempotency_key := concat_ws(':', 'pos_shift', v_topic, NEW.id::text);

  INSERT INTO public.business_event_outbox (
    org_id, branch_id, event_type, source_doc_type, source_doc_id,
    payload, idempotency_key, actor_user_id, handler_scope
  ) VALUES (
    NEW.organization_id, NEW.branch_id, v_topic,
    'pos_shift', NEW.id, v_payload, v_idempotency_key, NEW.user_id, 'server'
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN NEW;
END;
$$;