
-- ============================================================
-- Phase B.1 — Per-item state machine for payroll_payment_batch_items
-- ============================================================

-- 1) Item-specific status enum (decoupled from batch lifecycle)
DO $$ BEGIN
  CREATE TYPE public.payroll_payment_item_status AS ENUM (
    'pending', 'held', 'exported', 'sent',
    'paid', 'failed', 'cancelled', 'reversed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) New column with mapped values, then swap
ALTER TABLE public.payroll_payment_batch_items
  ADD COLUMN IF NOT EXISTS item_status public.payroll_payment_item_status;

UPDATE public.payroll_payment_batch_items
SET item_status = CASE status::text
  WHEN 'paid' THEN 'paid'::public.payroll_payment_item_status
  WHEN 'failed' THEN 'failed'::public.payroll_payment_item_status
  WHEN 'cancelled' THEN 'cancelled'::public.payroll_payment_item_status
  WHEN 'reversed' THEN 'reversed'::public.payroll_payment_item_status
  WHEN 'exported' THEN 'exported'::public.payroll_payment_item_status
  WHEN 'transmitted' THEN 'sent'::public.payroll_payment_item_status
  WHEN 'confirmed' THEN 'paid'::public.payroll_payment_item_status
  ELSE 'pending'::public.payroll_payment_item_status
END
WHERE item_status IS NULL;

ALTER TABLE public.payroll_payment_batch_items
  ALTER COLUMN item_status SET NOT NULL,
  ALTER COLUMN item_status SET DEFAULT 'pending';

-- Drop the old shared-enum status column (the new item_status replaces it).
-- Keep status as a generated alias for backward compatibility during rollout.
ALTER TABLE public.payroll_payment_batch_items
  ALTER COLUMN status DROP NOT NULL,
  ALTER COLUMN status DROP DEFAULT;

-- 3) Additional per-item stamps
ALTER TABLE public.payroll_payment_batch_items
  ADD COLUMN IF NOT EXISTS held_reason TEXT,
  ADD COLUMN IF NOT EXISTS held_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS held_by UUID,
  ADD COLUMN IF NOT EXISTS exported_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_reference TEXT,
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by UUID,
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_by UUID,
  ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(18,4);

-- 4) Lifecycle validation trigger
CREATE OR REPLACE FUNCTION public.validate_payroll_payment_item_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from public.payroll_payment_item_status;
  v_to   public.payroll_payment_item_status;
  v_ok   BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- only pending or held allowed at insert
    IF NEW.item_status NOT IN ('pending', 'held') THEN
      RAISE EXCEPTION 'payroll_payment_batch_items: new row must start as pending or held (got %)', NEW.item_status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  v_from := OLD.item_status;
  v_to   := NEW.item_status;
  IF v_from = v_to THEN RETURN NEW; END IF;

  -- terminal states are frozen
  IF v_from IN ('paid','cancelled','reversed') THEN
    RAISE EXCEPTION 'payroll_payment_batch_items: cannot transition out of terminal status %', v_from
      USING ERRCODE = 'check_violation';
  END IF;

  -- legal transitions
  v_ok := (v_from, v_to) IN (
    ('pending',  'held'),
    ('pending',  'exported'),
    ('pending',  'sent'),
    ('pending',  'paid'),
    ('pending',  'failed'),
    ('pending',  'cancelled'),
    ('held',     'pending'),
    ('held',     'cancelled'),
    ('exported', 'sent'),
    ('exported', 'paid'),
    ('exported', 'failed'),
    ('exported', 'cancelled'),
    ('sent',     'paid'),
    ('sent',     'failed'),
    ('failed',   'pending'),   -- retry
    ('failed',   'cancelled'),
    ('failed',   'paid'),       -- manual resolution
    ('paid',     'reversed'),
    ('sent',     'reversed'),
    ('exported', 'reversed')
  );
  IF NOT v_ok THEN
    RAISE EXCEPTION 'payroll_payment_batch_items: illegal status transition % -> %', v_from, v_to
      USING ERRCODE = 'check_violation';
  END IF;

  -- required stamps per target
  IF v_to = 'paid' AND NEW.paid_at IS NULL THEN
    NEW.paid_at := now();
  END IF;
  IF v_to = 'failed' AND NEW.failed_at IS NULL THEN
    NEW.failed_at := now();
  END IF;
  IF v_to = 'sent' AND NEW.sent_at IS NULL THEN
    NEW.sent_at := now();
  END IF;
  IF v_to = 'exported' AND NEW.exported_at IS NULL THEN
    NEW.exported_at := now();
  END IF;
  IF v_to = 'held' THEN
    IF NEW.held_at IS NULL THEN NEW.held_at := now(); END IF;
    IF NEW.held_reason IS NULL OR length(btrim(NEW.held_reason)) = 0 THEN
      RAISE EXCEPTION 'payroll_payment_batch_items: held_reason required when holding item'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF v_to = 'cancelled' THEN
    IF NEW.cancelled_at IS NULL THEN NEW.cancelled_at := now(); END IF;
    IF NEW.cancel_reason IS NULL OR length(btrim(NEW.cancel_reason)) = 0 THEN
      RAISE EXCEPTION 'payroll_payment_batch_items: cancel_reason required when cancelling item'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF v_to = 'reversed' AND NEW.reversed_at IS NULL THEN
    NEW.reversed_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_payroll_payment_item_lifecycle
  ON public.payroll_payment_batch_items;
CREATE TRIGGER trg_validate_payroll_payment_item_lifecycle
  BEFORE INSERT OR UPDATE OF item_status, paid_at, sent_at, exported_at,
                              failed_at, held_at, cancelled_at, reversed_at,
                              held_reason, cancel_reason
  ON public.payroll_payment_batch_items
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_payroll_payment_item_lifecycle();

-- 5) Per-item lifecycle RPCs
CREATE OR REPLACE FUNCTION public.payroll_payment_item_hold(
  _item_id UUID,
  _reason TEXT
) RETURNS public.payroll_payment_batch_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r public.payroll_payment_batch_items;
BEGIN
  UPDATE public.payroll_payment_batch_items
    SET item_status = 'held',
        held_reason = _reason,
        held_by = auth.uid(),
        held_at = now()
  WHERE id = _item_id
  RETURNING * INTO r;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Item not found %', _item_id; END IF;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_payment_item_release(
  _item_id UUID
) RETURNS public.payroll_payment_batch_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r public.payroll_payment_batch_items;
BEGIN
  UPDATE public.payroll_payment_batch_items
    SET item_status = 'pending',
        held_reason = NULL,
        held_at = NULL,
        held_by = NULL
  WHERE id = _item_id
  RETURNING * INTO r;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Item not found %', _item_id; END IF;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_payment_item_cancel(
  _item_id UUID,
  _reason TEXT
) RETURNS public.payroll_payment_batch_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r public.payroll_payment_batch_items;
BEGIN
  UPDATE public.payroll_payment_batch_items
    SET item_status = 'cancelled',
        cancel_reason = _reason,
        cancelled_by = auth.uid(),
        cancelled_at = now()
  WHERE id = _item_id
  RETURNING * INTO r;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Item not found %', _item_id; END IF;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_payment_item_mark_failed(
  _item_id UUID,
  _failure_reason TEXT
) RETURNS public.payroll_payment_batch_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r public.payroll_payment_batch_items;
BEGIN
  UPDATE public.payroll_payment_batch_items
    SET item_status = 'failed',
        failure_reason = _failure_reason,
        failed_at = now()
  WHERE id = _item_id
  RETURNING * INTO r;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Item not found %', _item_id; END IF;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_payment_item_retry(
  _item_id UUID
) RETURNS public.payroll_payment_batch_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r public.payroll_payment_batch_items;
BEGIN
  UPDATE public.payroll_payment_batch_items
    SET item_status = 'pending',
        retry_count = COALESCE(retry_count,0) + 1,
        last_retry_at = now(),
        failure_reason = NULL
  WHERE id = _item_id AND item_status = 'failed'
  RETURNING * INTO r;
  IF r.id IS NULL THEN
    RAISE EXCEPTION 'Item % is not in failed status', _item_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_payment_item_mark_paid(
  _item_id UUID,
  _payment_reference TEXT DEFAULT NULL,
  _paid_amount NUMERIC DEFAULT NULL
) RETURNS public.payroll_payment_batch_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r public.payroll_payment_batch_items;
BEGIN
  UPDATE public.payroll_payment_batch_items
    SET item_status = 'paid',
        payment_reference = COALESCE(_payment_reference, payment_reference),
        paid_amount = COALESCE(_paid_amount, paid_amount, amount),
        paid_at = now()
  WHERE id = _item_id
  RETURNING * INTO r;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Item not found %', _item_id; END IF;
  RETURN r;
END $$;

GRANT EXECUTE ON FUNCTION public.payroll_payment_item_hold(uuid, text)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_payment_item_release(uuid)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_payment_item_cancel(uuid, text)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_payment_item_mark_failed(uuid, text)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_payment_item_retry(uuid)              TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_payment_item_mark_paid(uuid, text, numeric) TO authenticated;

-- 6) Batch roll-up: after item update, set partially_paid/paid/failed
CREATE OR REPLACE FUNCTION public.rollup_payroll_payment_batch_from_items()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch UUID := COALESCE(NEW.batch_id, OLD.batch_id);
  v_total INT;
  v_paid  INT;
  v_failed INT;
  v_cancelled INT;
  v_pending INT;
  v_current TEXT;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE item_status = 'paid'),
         count(*) FILTER (WHERE item_status = 'failed'),
         count(*) FILTER (WHERE item_status = 'cancelled'),
         count(*) FILTER (WHERE item_status IN ('pending','held','exported','sent'))
    INTO v_total, v_paid, v_failed, v_cancelled, v_pending
    FROM public.payroll_payment_batch_items
    WHERE batch_id = v_batch;

  SELECT status::text INTO v_current
    FROM public.payroll_payment_batches WHERE id = v_batch;

  -- Only roll up when batch is in an in-flight state
  IF v_current IN ('paid','cancelled','reversed') THEN
    RETURN NEW;
  END IF;

  IF v_paid > 0 AND v_pending = 0 AND v_failed = 0 THEN
    -- everything paid (cancelled items ignored)
    -- defer to edge fn to post JE & flip to 'paid'; only mark partially when mixed
    NULL;
  ELSIF v_paid > 0 AND (v_pending > 0 OR v_failed > 0) THEN
    UPDATE public.payroll_payment_batches
       SET status = 'partially_paid', updated_at = now()
     WHERE id = v_batch AND status NOT IN ('partially_paid','paid','cancelled','reversed');
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_rollup_payroll_payment_batch_from_items
  ON public.payroll_payment_batch_items;
CREATE TRIGGER trg_rollup_payroll_payment_batch_from_items
  AFTER UPDATE OF item_status ON public.payroll_payment_batch_items
  FOR EACH ROW
  EXECUTE FUNCTION public.rollup_payroll_payment_batch_from_items();

-- 7) Helpful index
CREATE INDEX IF NOT EXISTS idx_payroll_payment_batch_items_batch_status
  ON public.payroll_payment_batch_items(batch_id, item_status);
