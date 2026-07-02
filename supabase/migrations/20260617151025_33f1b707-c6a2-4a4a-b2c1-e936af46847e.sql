-- Track B
ALTER TABLE public.business_event_outbox
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'system'
    CHECK (source IN ('pos','finance','manual','system','trigger'));

CREATE OR REPLACE FUNCTION public.tg_payments_emit_received()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_event_id uuid;
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.status IN ('completed','posted'))
     OR (TG_OP = 'UPDATE' AND NEW.status IN ('completed','posted')
         AND OLD.status IS DISTINCT FROM NEW.status) THEN
    v_event_id := public.publish_business_event(
      NEW.business_id,
      NEW.branch_id,
      NULL,
      'payment.received',
      'payment',
      NEW.id,
      jsonb_build_object(
        'amount', NEW.amount,
        'method', NEW.payment_method::text,
        'contact_id', NEW.contact_id,
        'receipt_number', NEW.receipt_number
      ),
      'payment-received:' || NEW.id::text,
      auth.uid()
    );
    UPDATE public.business_event_outbox SET source = 'finance' WHERE id = v_event_id;
  END IF;
  RETURN NEW;
END;
$function$;

-- Track C — claim lease + reclaim. `running` is the claimed status in this schema.
ALTER TABLE public.hardware_command_queue
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS claim_lease_seconds int NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS worker_id text;

CREATE INDEX IF NOT EXISTS hardware_command_queue_claimed_at_idx
  ON public.hardware_command_queue (claimed_at)
  WHERE status = 'running';

CREATE OR REPLACE FUNCTION public.reclaim_stale_hardware_commands()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_count integer;
BEGIN
  WITH reclaimed AS (
    UPDATE public.hardware_command_queue
       SET status = 'pending',
           claimed_at = NULL,
           worker_id = NULL,
           attempts = attempts + 1
     WHERE status = 'running'
       AND claimed_at IS NOT NULL
       AND claimed_at < now() - (claim_lease_seconds || ' seconds')::interval
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM reclaimed;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reclaim_stale_hardware_commands() TO authenticated, service_role;

-- Track F — operator manual retry. business_event_status retryable = 'failed'; reset to 'pending'.
CREATE OR REPLACE FUNCTION public.retry_failed_business_event(p_event_id uuid)
RETURNS public.business_event_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_row public.business_event_outbox;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') AND NOT public.has_role(auth.uid(), 'owner') THEN
    RAISE EXCEPTION 'permission denied: requires admin or owner role';
  END IF;
  UPDATE public.business_event_outbox
     SET status = 'pending'::business_event_status,
         attempts = 0,
         last_error = NULL,
         updated_at = now()
   WHERE id = p_event_id
     AND status = 'failed'::business_event_status
  RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'event % not found or not in a retryable state', p_event_id;
  END IF;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.retry_failed_business_event(uuid) TO authenticated, service_role;