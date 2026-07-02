
-- ===========================================================================
-- Phase A: Payroll Payment Batch lifecycle, stamps, SoD, RPCs, events
-- ===========================================================================

-- 1. Extend status enum -----------------------------------------------------
ALTER TYPE public.payment_batch_status ADD VALUE IF NOT EXISTS 'approved';
ALTER TYPE public.payment_batch_status ADD VALUE IF NOT EXISTS 'locked';
ALTER TYPE public.payment_batch_status ADD VALUE IF NOT EXISTS 'exported';
ALTER TYPE public.payment_batch_status ADD VALUE IF NOT EXISTS 'transmitted';
ALTER TYPE public.payment_batch_status ADD VALUE IF NOT EXISTS 'reversed';
ALTER TYPE public.payment_batch_status ADD VALUE IF NOT EXISTS 'failed';

-- 2. Lifecycle stamp columns -----------------------------------------------
ALTER TABLE public.payroll_payment_batches
  ADD COLUMN IF NOT EXISTS approved_by         uuid,
  ADD COLUMN IF NOT EXISTS approved_at         timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by           uuid,
  ADD COLUMN IF NOT EXISTS locked_at           timestamptz,
  ADD COLUMN IF NOT EXISTS exported_by         uuid,
  ADD COLUMN IF NOT EXISTS exported_at         timestamptz,
  ADD COLUMN IF NOT EXISTS transmitted_by      uuid,
  ADD COLUMN IF NOT EXISTS transmitted_at      timestamptz,
  ADD COLUMN IF NOT EXISTS transmission_reference text,
  ADD COLUMN IF NOT EXISTS paid_by             uuid,
  ADD COLUMN IF NOT EXISTS paid_at             timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by        uuid,
  ADD COLUMN IF NOT EXISTS cancelled_at        timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_reason       text,
  ADD COLUMN IF NOT EXISTS reversed_by         uuid,
  ADD COLUMN IF NOT EXISTS reversed_at         timestamptz,
  ADD COLUMN IF NOT EXISTS reversal_reason     text,
  ADD COLUMN IF NOT EXISTS reversal_je_id      uuid;

-- 3. Lifecycle validation trigger ------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_payroll_payment_batch_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old text := OLD.status::text;
  v_new text := NEW.status::text;
  v_allowed boolean := false;
BEGIN
  -- Same status: allow non-status field changes unless terminal
  IF v_old = v_new THEN
    IF v_old IN ('paid','cancelled','reversed') THEN
      -- Terminal: only allow stamp/audit columns to settle (updated_at).
      -- Anything material is rejected.
      IF (NEW.total_amount IS DISTINCT FROM OLD.total_amount)
         OR (NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id)
         OR (NEW.payroll_run_id  IS DISTINCT FROM OLD.payroll_run_id)
         OR (NEW.batch_number    IS DISTINCT FROM OLD.batch_number) THEN
        RAISE EXCEPTION 'payroll_payment_batch %: terminal status (%); cannot mutate',
          OLD.id, v_old USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- Transition matrix
  v_allowed := CASE
    WHEN v_old = 'draft'         AND v_new IN ('approved','cancelled')                THEN true
    -- backward-compat: legacy 'pending' treated like draft
    WHEN v_old = 'pending'       AND v_new IN ('approved','cancelled')                THEN true
    WHEN v_old = 'approved'      AND v_new IN ('locked','cancelled')                  THEN true
    WHEN v_old = 'locked'        AND v_new IN ('exported','paid','cancelled','failed') THEN true
    WHEN v_old = 'exported'      AND v_new IN ('transmitted','paid','failed','cancelled') THEN true
    WHEN v_old = 'transmitted'   AND v_new IN ('partially_paid','paid','failed')      THEN true
    WHEN v_old = 'partially_paid' AND v_new IN ('paid','failed')                      THEN true
    WHEN v_old = 'failed'        AND v_new IN ('locked','exported','transmitted','paid','cancelled') THEN true
    WHEN v_old = 'paid'          AND v_new = 'reversed'                                THEN true
    -- legacy 'confirmed' acts like 'transmitted'
    WHEN v_old = 'confirmed'     AND v_new IN ('partially_paid','paid','failed')      THEN true
    ELSE false
  END;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'payroll_payment_batch %: illegal transition % -> %',
      OLD.id, v_old, v_new USING ERRCODE = '42501', HINT = 'PPB_INVALID_TRANSITION';
  END IF;

  -- Required stamps per transition
  IF v_new = 'approved' AND (NEW.approved_by IS NULL OR NEW.approved_at IS NULL) THEN
    RAISE EXCEPTION 'approved transition requires approved_by/at' USING ERRCODE='42501';
  END IF;
  IF v_new = 'locked' AND (NEW.locked_by IS NULL OR NEW.locked_at IS NULL) THEN
    RAISE EXCEPTION 'locked transition requires locked_by/at' USING ERRCODE='42501';
  END IF;
  IF v_new = 'exported' AND (NEW.exported_by IS NULL OR NEW.exported_at IS NULL) THEN
    RAISE EXCEPTION 'exported transition requires exported_by/at' USING ERRCODE='42501';
  END IF;
  IF v_new = 'transmitted' AND (NEW.transmitted_by IS NULL OR NEW.transmitted_at IS NULL) THEN
    RAISE EXCEPTION 'transmitted transition requires transmitted_by/at' USING ERRCODE='42501';
  END IF;
  IF v_new = 'paid' AND (NEW.paid_at IS NULL) THEN
    NEW.paid_at := now();
  END IF;
  IF v_new = 'cancelled' AND (NEW.cancelled_by IS NULL OR NEW.cancelled_at IS NULL) THEN
    RAISE EXCEPTION 'cancelled transition requires cancelled_by/at' USING ERRCODE='42501';
  END IF;
  IF v_new = 'reversed' AND (NEW.reversed_by IS NULL OR NEW.reversed_at IS NULL) THEN
    RAISE EXCEPTION 'reversed transition requires reversed_by/at' USING ERRCODE='42501';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_validate_payroll_payment_batch_lifecycle ON public.payroll_payment_batches;
CREATE TRIGGER trg_validate_payroll_payment_batch_lifecycle
  BEFORE UPDATE ON public.payroll_payment_batches
  FOR EACH ROW EXECUTE FUNCTION public.validate_payroll_payment_batch_lifecycle();

-- 4. Event emission helper -------------------------------------------------
CREATE OR REPLACE FUNCTION public._payroll_payment_batch_emit_event(
  p_batch public.payroll_payment_batches,
  p_event_type text,
  p_extra jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_payload jsonb;
BEGIN
  v_payload := jsonb_build_object(
    'batch_id',         p_batch.id,
    'batch_number',     p_batch.batch_number,
    'organization_id',  p_batch.organization_id,
    'business_id',      p_batch.business_id,
    'payroll_run_id',   p_batch.payroll_run_id,
    'status',           p_batch.status,
    'total_amount',     p_batch.total_amount,
    'bank_account_id',  p_batch.bank_account_id,
    'actor_user_id',    v_actor,
    'emitter',          'payroll_payment_batch_rpc'
  ) || COALESCE(p_extra, '{}'::jsonb);

  INSERT INTO public.business_event_outbox(
    org_id, event_type, source_doc_type, source_doc_id,
    payload, idempotency_key, actor_user_id, source
  )
  VALUES (
    p_batch.organization_id,
    p_event_type,
    'payroll_payment_batch',
    p_batch.id,
    v_payload,
    'payroll_payment_batch:' || p_batch.id::text || ':' || p_event_type || ':' || p_batch.status,
    v_actor,
    'system'
  )
  ON CONFLICT (org_id, idempotency_key) DO NOTHING;
END
$$;

-- 5. SoD guard trigger -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.sod_payroll_payment_batches_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_action text;
BEGIN
  IF v_actor IS NULL OR OLD.created_by IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.status::text = OLD.status::text THEN
    RETURN NEW;
  END IF;

  v_action := CASE NEW.status::text
    WHEN 'approved'    THEN 'payroll_payment_batch.approve'
    WHEN 'locked'      THEN 'payroll_payment_batch.lock'
    WHEN 'transmitted' THEN 'payroll_payment_batch.transmit'
    WHEN 'paid'        THEN 'payroll_payment_batch.pay'
    WHEN 'cancelled'   THEN 'payroll_payment_batch.cancel'
    WHEN 'reversed'    THEN 'payroll_payment_batch.reverse'
    ELSE NULL
  END;

  IF v_action IS NULL THEN RETURN NEW; END IF;

  PERFORM public.governance_assert_not_self(
    v_actor, OLD.created_by, v_action,
    OLD.organization_id, 'payroll_payment_batch', OLD.id
  );

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS sod_payroll_payment_batches_guard ON public.payroll_payment_batches;
CREATE TRIGGER sod_payroll_payment_batches_guard
  BEFORE UPDATE ON public.payroll_payment_batches
  FOR EACH ROW EXECUTE FUNCTION public.sod_payroll_payment_batches_guard();

-- 6. Lifecycle RPCs --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_payment_batch_approve(
  p_batch_id uuid,
  p_note text DEFAULT NULL
) RETURNS public.payroll_payment_batches
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_row public.payroll_payment_batches;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;
  UPDATE public.payroll_payment_batches
     SET status='approved'::payment_batch_status,
         approved_by=v_actor, approved_at=now(), updated_at=now()
   WHERE id=p_batch_id
   RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'batch % not found', p_batch_id; END IF;
  PERFORM public._payroll_payment_batch_emit_event(v_row, 'payroll_payment_batch.approved',
    jsonb_build_object('note', p_note));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_payment_batch_lock(p_batch_id uuid)
RETURNS public.payroll_payment_batches
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE v_actor uuid := auth.uid(); v_row public.payroll_payment_batches;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;
  UPDATE public.payroll_payment_batches
     SET status='locked'::payment_batch_status,
         locked_by=v_actor, locked_at=now(), updated_at=now()
   WHERE id=p_batch_id
   RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'batch % not found', p_batch_id; END IF;
  PERFORM public._payroll_payment_batch_emit_event(v_row, 'payroll_payment_batch.locked');
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_payment_batch_mark_exported(
  p_batch_id uuid,
  p_template_code text DEFAULT NULL
) RETURNS public.payroll_payment_batches
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE v_actor uuid := auth.uid(); v_row public.payroll_payment_batches;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;
  UPDATE public.payroll_payment_batches
     SET status='exported'::payment_batch_status,
         exported_by=v_actor, exported_at=now(), updated_at=now()
   WHERE id=p_batch_id
   RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'batch % not found', p_batch_id; END IF;
  PERFORM public._payroll_payment_batch_emit_event(v_row, 'payroll_payment_batch.exported',
    jsonb_build_object('template_code', p_template_code));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_payment_batch_mark_transmitted(
  p_batch_id uuid,
  p_reference text DEFAULT NULL
) RETURNS public.payroll_payment_batches
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE v_actor uuid := auth.uid(); v_row public.payroll_payment_batches;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;
  UPDATE public.payroll_payment_batches
     SET status='transmitted'::payment_batch_status,
         transmitted_by=v_actor, transmitted_at=now(),
         transmission_reference=COALESCE(p_reference, transmission_reference),
         updated_at=now()
   WHERE id=p_batch_id
   RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'batch % not found', p_batch_id; END IF;
  PERFORM public._payroll_payment_batch_emit_event(v_row, 'payroll_payment_batch.transmitted',
    jsonb_build_object('reference', p_reference));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_payment_batch_cancel(
  p_batch_id uuid,
  p_reason text
) RETURNS public.payroll_payment_batches
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE v_actor uuid := auth.uid(); v_row public.payroll_payment_batches;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'cancellation reason required' USING ERRCODE='22023';
  END IF;
  UPDATE public.payroll_payment_batches
     SET status='cancelled'::payment_batch_status,
         cancelled_by=v_actor, cancelled_at=now(),
         cancel_reason=p_reason, updated_at=now()
   WHERE id=p_batch_id
   RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'batch % not found', p_batch_id; END IF;
  PERFORM public._payroll_payment_batch_emit_event(v_row, 'payroll_payment_batch.cancelled',
    jsonb_build_object('reason', p_reason));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_payment_batch_reverse(
  p_batch_id uuid,
  p_reason text
) RETURNS public.payroll_payment_batches
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE v_actor uuid := auth.uid(); v_row public.payroll_payment_batches;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'reversal reason required' USING ERRCODE='22023';
  END IF;
  -- NOTE: this stamps the reversal intent. The cash-side reversal JE and
  -- per-item rollback are owned by the `reverse-payroll-payment` edge fn
  -- (Phase B) which calls this RPC after the JE is posted.
  UPDATE public.payroll_payment_batches
     SET status='reversed'::payment_batch_status,
         reversed_by=v_actor, reversed_at=now(),
         reversal_reason=p_reason, updated_at=now()
   WHERE id=p_batch_id
   RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'batch % not found', p_batch_id; END IF;
  PERFORM public._payroll_payment_batch_emit_event(v_row, 'payroll_payment_batch.reversed',
    jsonb_build_object('reason', p_reason));
  RETURN v_row;
END $$;

-- 7. Grants ----------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.payroll_payment_batch_approve(uuid, text)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_payment_batch_lock(uuid)                  TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_payment_batch_mark_exported(uuid, text)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_payment_batch_mark_transmitted(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_payment_batch_cancel(uuid, text)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_payment_batch_reverse(uuid, text)         TO authenticated;
