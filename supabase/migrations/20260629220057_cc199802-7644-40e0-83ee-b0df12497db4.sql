
-- ============================================================================
-- Phase 2: Payroll Batch lifecycle RPCs + event emission
-- ============================================================================

-- Internal helper: emit a payroll_batch.* event into the outbox.
-- SECURITY DEFINER because outbox writes are an infrastructure concern;
-- the caller's authorisation is already enforced by the lifecycle RPC.
CREATE OR REPLACE FUNCTION public._payroll_batch_emit_event(
  p_batch       public.payroll_run_groups,
  p_event_type  text,
  p_extra       jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
    'pay_schedule_id',  p_batch.pay_schedule_id,
    'period_start',     p_batch.period_start,
    'period_end',       p_batch.period_end,
    'run_type',         p_batch.run_type,
    'status',           p_batch.status,
    'actor_user_id',    v_actor
  ) || COALESCE(p_extra, '{}'::jsonb);

  INSERT INTO public.business_event_outbox(
    org_id, event_type, source_doc_type, source_doc_id,
    payload, idempotency_key, actor_user_id, source
  )
  VALUES (
    p_batch.organization_id,
    p_event_type,
    'payroll_batch',
    p_batch.id,
    v_payload,
    'payroll_batch:' || p_batch.id::text || ':' || p_event_type
                    || ':' || p_batch.status,
    v_actor,
    'payroll_batch_rpc'
  )
  ON CONFLICT (idempotency_key) DO NOTHING;
END
$$;

REVOKE ALL ON FUNCTION public._payroll_batch_emit_event(public.payroll_run_groups, text, jsonb) FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- payroll_batch_create
--   Idempotent on p_idempotency_key. Returns the canonical batch row whether
--   freshly inserted or recovered from a previous call.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_batch_create(
  p_organization_id  uuid,
  p_business_id      uuid,
  p_pay_schedule_id  uuid,
  p_period_start     date,
  p_period_end       date,
  p_run_type         text DEFAULT 'regular',
  p_name             text DEFAULT NULL,
  p_idempotency_key  text DEFAULT NULL,
  p_notes            text DEFAULT NULL,
  p_country_code     text DEFAULT NULL,
  p_parent_batch_id  uuid DEFAULT NULL
)
RETURNS public.payroll_run_groups
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_idem        text;
  v_existing    public.payroll_run_groups;
  v_batch       public.payroll_run_groups;
  v_seq         int;
  v_yyyymm      text;
  v_batch_num   text;
  v_name        text;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'business_id is required for new batches' USING ERRCODE = '22023';
  END IF;
  IF p_period_start IS NULL OR p_period_end IS NULL THEN
    RAISE EXCEPTION 'period_start and period_end are required' USING ERRCODE = '22023';
  END IF;
  IF p_period_end < p_period_start THEN
    RAISE EXCEPTION 'period_end must be on or after period_start' USING ERRCODE = '22023';
  END IF;

  v_idem := COALESCE(
    p_idempotency_key,
    'auto:' || p_organization_id::text
            || ':' || p_business_id::text
            || ':' || COALESCE(p_pay_schedule_id::text,'no-sched')
            || ':' || p_period_start::text
            || ':' || p_period_end::text
            || ':' || p_run_type
  );

  -- Idempotency short-circuit.
  SELECT * INTO v_existing
  FROM public.payroll_run_groups
  WHERE idempotency_key = v_idem;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  -- Deterministic batch number: BATCH-YYYYMM-#### where #### is sequential
  -- inside (org, business, pay_schedule, year-month).
  v_yyyymm := to_char(p_period_start, 'YYYYMM');
  SELECT COALESCE(MAX(
    CASE WHEN batch_number ~ ('^BATCH-' || v_yyyymm || '-[0-9]{4}$')
         THEN substring(batch_number FROM '([0-9]{4})$')::int
         ELSE 0
    END
  ), 0) + 1
  INTO v_seq
  FROM public.payroll_run_groups
  WHERE organization_id = p_organization_id
    AND business_id     = p_business_id
    AND (pay_schedule_id IS NOT DISTINCT FROM p_pay_schedule_id);

  v_batch_num := 'BATCH-' || v_yyyymm || '-' || lpad(v_seq::text, 4, '0');
  v_name := COALESCE(p_name,
    'Payroll ' || to_char(p_period_start, 'Mon YYYY')
                || ' (' || p_run_type || ')');

  INSERT INTO public.payroll_run_groups(
    organization_id, business_id, pay_schedule_id, country_code,
    name, period_start, period_end, status,
    notes, batch_number, idempotency_key, run_type,
    parent_batch_id, created_by
  )
  VALUES (
    p_organization_id, p_business_id, p_pay_schedule_id, p_country_code,
    v_name, p_period_start, p_period_end, 'draft',
    p_notes, v_batch_num, v_idem, p_run_type,
    p_parent_batch_id, auth.uid()
  )
  RETURNING * INTO v_batch;

  PERFORM public._payroll_batch_emit_event(v_batch, 'payroll_batch.created');

  RETURN v_batch;
END
$$;

GRANT EXECUTE ON FUNCTION public.payroll_batch_create(
  uuid, uuid, uuid, date, date, text, text, text, text, text, uuid
) TO authenticated;

-- ----------------------------------------------------------------------------
-- payroll_batch_submit  ::  draft|computing -> review
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_batch_submit(p_batch_id uuid)
RETURNS public.payroll_run_groups
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_batch public.payroll_run_groups;
  v_child_count int;
BEGIN
  SELECT * INTO v_batch FROM public.payroll_run_groups WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'batch % not found', p_batch_id USING ERRCODE = 'P0002';
  END IF;
  IF v_batch.status NOT IN ('draft','computing') THEN
    RAISE EXCEPTION 'batch % cannot be submitted from status %', p_batch_id, v_batch.status
      USING ERRCODE = '22023';
  END IF;

  SELECT COUNT(*) INTO v_child_count
  FROM public.payroll_runs WHERE group_id = p_batch_id;
  IF v_child_count = 0 THEN
    RAISE EXCEPTION 'batch % has no child runs to submit', p_batch_id USING ERRCODE = '22023';
  END IF;

  UPDATE public.payroll_run_groups
     SET status = 'review', updated_at = now()
   WHERE id = p_batch_id
   RETURNING * INTO v_batch;

  PERFORM public._payroll_batch_emit_event(v_batch, 'payroll_batch.submitted',
    jsonb_build_object('child_run_count', v_child_count));

  RETURN v_batch;
END
$$;

GRANT EXECUTE ON FUNCTION public.payroll_batch_submit(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- payroll_batch_approve  ::  review -> approved
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_batch_approve(p_batch_id uuid)
RETURNS public.payroll_run_groups
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_batch public.payroll_run_groups;
  v_unready int;
BEGIN
  SELECT * INTO v_batch FROM public.payroll_run_groups WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'batch % not found', p_batch_id USING ERRCODE = 'P0002';
  END IF;
  IF v_batch.status <> 'review' THEN
    RAISE EXCEPTION 'batch % must be in review to approve (currently %)', p_batch_id, v_batch.status
      USING ERRCODE = '22023';
  END IF;

  SELECT COUNT(*) INTO v_unready
  FROM public.payroll_runs
  WHERE group_id = p_batch_id
    AND (status IS NULL OR status IN ('draft','computing'));
  IF v_unready > 0 THEN
    RAISE EXCEPTION 'batch % has % child run(s) not yet computed', p_batch_id, v_unready
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.payroll_run_groups
     SET status      = 'approved',
         approved_by = auth.uid(),
         approved_at = now(),
         updated_at  = now()
   WHERE id = p_batch_id
   RETURNING * INTO v_batch;

  PERFORM public._payroll_batch_emit_event(v_batch, 'payroll_batch.approved');

  RETURN v_batch;
END
$$;

GRANT EXECUTE ON FUNCTION public.payroll_batch_approve(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- payroll_batch_cancel  ::  any pre-posted -> cancelled (detaches children)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_batch_cancel(
  p_batch_id uuid,
  p_reason   text DEFAULT NULL
)
RETURNS public.payroll_run_groups
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_batch public.payroll_run_groups;
  v_posted_children int;
  v_detached int;
BEGIN
  SELECT * INTO v_batch FROM public.payroll_run_groups WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'batch % not found', p_batch_id USING ERRCODE = 'P0002';
  END IF;
  IF v_batch.status IN ('posted','paid','closed','cancelled','reversed') THEN
    RAISE EXCEPTION 'batch % cannot be cancelled from status %', p_batch_id, v_batch.status
      USING ERRCODE = '22023';
  END IF;

  SELECT COUNT(*) INTO v_posted_children
  FROM public.payroll_runs
  WHERE group_id = p_batch_id
    AND status IN ('posted','paid');
  IF v_posted_children > 0 THEN
    RAISE EXCEPTION 'batch % has % posted/paid child run(s); reverse them before cancelling',
      p_batch_id, v_posted_children USING ERRCODE = '22023';
  END IF;

  UPDATE public.payroll_runs
     SET group_id = NULL, updated_at = now()
   WHERE group_id = p_batch_id;
  GET DIAGNOSTICS v_detached = ROW_COUNT;

  UPDATE public.payroll_run_groups
     SET status     = 'cancelled',
         notes      = COALESCE(notes, '')
                    || CASE WHEN p_reason IS NULL THEN ''
                            ELSE E'\n[cancelled] ' || p_reason END,
         updated_at = now()
   WHERE id = p_batch_id
   RETURNING * INTO v_batch;

  PERFORM public._payroll_batch_emit_event(v_batch, 'payroll_batch.cancelled',
    jsonb_build_object('reason', p_reason, 'detached_run_count', v_detached));

  RETURN v_batch;
END
$$;

GRANT EXECUTE ON FUNCTION public.payroll_batch_cancel(uuid, text) TO authenticated;
