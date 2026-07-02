
-- ============================================================================
-- Phase 3: Payroll Batch posting / payment / close
-- ============================================================================

-- Link payment batches back to their parent payroll batch.
ALTER TABLE public.payroll_payment_batches
  ADD COLUMN IF NOT EXISTS source_batch_id uuid
    REFERENCES public.payroll_run_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_payment_batches_source_batch
  ON public.payroll_payment_batches(source_batch_id)
  WHERE source_batch_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- payroll_batch_mark_posted  ::  approved -> posted
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_batch_mark_posted(p_batch_id uuid)
RETURNS public.payroll_run_groups
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_batch       public.payroll_run_groups;
  v_children    int;
  v_unposted    int;
BEGIN
  SELECT * INTO v_batch FROM public.payroll_run_groups WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'batch % not found', p_batch_id USING ERRCODE = 'P0002';
  END IF;
  IF v_batch.status <> 'approved' THEN
    RAISE EXCEPTION 'batch % must be approved to mark posted (currently %)', p_batch_id, v_batch.status
      USING ERRCODE = '22023';
  END IF;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE status NOT IN ('posted','paid'))
    INTO v_children, v_unposted
  FROM public.payroll_runs WHERE group_id = p_batch_id;

  IF v_children = 0 THEN
    RAISE EXCEPTION 'batch % has no child runs', p_batch_id USING ERRCODE = '22023';
  END IF;
  IF v_unposted > 0 THEN
    RAISE EXCEPTION 'batch % has % child run(s) not yet posted', p_batch_id, v_unposted
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.payroll_run_groups
     SET status     = 'posted',
         posted_by  = auth.uid(),
         posted_at  = now(),
         updated_at = now()
   WHERE id = p_batch_id
   RETURNING * INTO v_batch;

  PERFORM public._payroll_batch_emit_event(v_batch, 'payroll_batch.posted',
    jsonb_build_object('child_run_count', v_children));

  RETURN v_batch;
END
$$;

GRANT EXECUTE ON FUNCTION public.payroll_batch_mark_posted(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- payroll_batch_mark_paid  ::  posted -> paid
--   Requires every child run paid AND at least one payment batch linked via
--   source_batch_id. The first such payment batch is stamped onto the
--   batch.payment_batch_id pointer.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_batch_mark_paid(p_batch_id uuid)
RETURNS public.payroll_run_groups
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_batch        public.payroll_run_groups;
  v_unpaid       int;
  v_pay_batch_id uuid;
BEGIN
  SELECT * INTO v_batch FROM public.payroll_run_groups WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'batch % not found', p_batch_id USING ERRCODE = 'P0002';
  END IF;
  IF v_batch.status <> 'posted' THEN
    RAISE EXCEPTION 'batch % must be posted to mark paid (currently %)', p_batch_id, v_batch.status
      USING ERRCODE = '22023';
  END IF;

  SELECT COUNT(*) INTO v_unpaid
  FROM public.payroll_runs
  WHERE group_id = p_batch_id AND status <> 'paid';
  IF v_unpaid > 0 THEN
    RAISE EXCEPTION 'batch % has % child run(s) not yet paid', p_batch_id, v_unpaid
      USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_pay_batch_id
  FROM public.payroll_payment_batches
  WHERE source_batch_id = p_batch_id
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_pay_batch_id IS NULL THEN
    RAISE EXCEPTION 'batch % has no linked payment batch (set payroll_payment_batches.source_batch_id)',
      p_batch_id USING ERRCODE = '22023';
  END IF;

  UPDATE public.payroll_run_groups
     SET status           = 'paid',
         paid_by          = auth.uid(),
         paid_at          = now(),
         payment_batch_id = v_pay_batch_id,
         updated_at       = now()
   WHERE id = p_batch_id
   RETURNING * INTO v_batch;

  PERFORM public._payroll_batch_emit_event(v_batch, 'payroll_batch.paid',
    jsonb_build_object('payment_batch_id', v_pay_batch_id));

  RETURN v_batch;
END
$$;

GRANT EXECUTE ON FUNCTION public.payroll_batch_mark_paid(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- payroll_batch_close  ::  paid -> closed
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_batch_close(p_batch_id uuid)
RETURNS public.payroll_run_groups
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_batch public.payroll_run_groups;
BEGIN
  SELECT * INTO v_batch FROM public.payroll_run_groups WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'batch % not found', p_batch_id USING ERRCODE = 'P0002';
  END IF;
  IF v_batch.status <> 'paid' THEN
    RAISE EXCEPTION 'batch % must be paid to close (currently %)', p_batch_id, v_batch.status
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.payroll_run_groups
     SET status     = 'closed',
         closed_at  = now(),
         updated_at = now()
   WHERE id = p_batch_id
   RETURNING * INTO v_batch;

  PERFORM public._payroll_batch_emit_event(v_batch, 'payroll_batch.closed');

  RETURN v_batch;
END
$$;

GRANT EXECUTE ON FUNCTION public.payroll_batch_close(uuid) TO authenticated;
