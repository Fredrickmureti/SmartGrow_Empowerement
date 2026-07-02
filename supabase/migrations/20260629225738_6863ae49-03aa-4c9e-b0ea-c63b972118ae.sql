
-- Drop dependent view first
DROP VIEW IF EXISTS public.v_payroll_batches CASCADE;

ALTER TABLE public.payroll_run_groups
  DROP COLUMN IF EXISTS consolidated_journal_entry_id;

-- Rebuild v_payroll_batches
CREATE OR REPLACE VIEW public.v_payroll_batches
WITH (security_invoker = true)
AS
SELECT
  b.id, b.organization_id, b.business_id, b.pay_schedule_id, b.country_code,
  b.name, b.batch_number, b.idempotency_key, b.run_type, b.parent_batch_id,
  b.period_start, b.period_end, b.status, b.notes, b.locked_at,
  b.approved_by, b.approved_at,
  b.posted_by, b.posted_at,
  b.paid_by, b.paid_at, b.payment_batch_id,
  b.closed_at, b.reversal_batch_id, b.readiness_snapshot_id,
  b.created_by, b.created_at, b.updated_at,
  COALESCE(agg.child_run_count, 0)              AS child_run_count,
  COALESCE(agg.headcount, 0)                    AS headcount,
  COALESCE(agg.total_gross, 0)                  AS total_gross,
  COALESCE(agg.total_net, 0)                    AS total_net,
  COALESCE(agg.total_other_deductions, 0)       AS total_other_deductions,
  COALESCE(agg.total_employer_contributions, 0) AS total_employer_contributions
FROM public.payroll_run_groups b
LEFT JOIN LATERAL (
  SELECT
    COUNT(*)                                       AS child_run_count,
    COALESCE(SUM(employee_count), 0)               AS headcount,
    COALESCE(SUM(total_gross), 0)                  AS total_gross,
    COALESCE(SUM(total_net), 0)                    AS total_net,
    COALESCE(SUM(total_other_deductions), 0)       AS total_other_deductions,
    COALESCE(SUM(total_employer_contributions), 0) AS total_employer_contributions
  FROM public.payroll_runs r
  WHERE r.group_id = b.id
    AND COALESCE(r.is_reversal, false) = false
) agg ON true;

GRANT SELECT ON public.v_payroll_batches TO authenticated;

-- ---------------------------------------------------------------------
-- D: payroll_batch_readiness_snapshots
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payroll_batch_readiness_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        uuid NOT NULL REFERENCES public.payroll_run_groups(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  business_id     uuid NOT NULL,
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  pass_count      int  NOT NULL DEFAULT 0,
  fail_count      int  NOT NULL DEFAULT 0,
  warn_count      int  NOT NULL DEFAULT 0,
  findings        jsonb NOT NULL DEFAULT '[]'::jsonb,
  override_reason text NULL,
  taken_at        timestamptz NOT NULL DEFAULT now(),
  taken_by        uuid NULL
);

GRANT SELECT, INSERT ON public.payroll_batch_readiness_snapshots TO authenticated;
GRANT ALL    ON public.payroll_batch_readiness_snapshots TO service_role;

CREATE INDEX IF NOT EXISTS idx_payroll_batch_readiness_snapshots_batch
  ON public.payroll_batch_readiness_snapshots(batch_id, taken_at DESC);

ALTER TABLE public.payroll_batch_readiness_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payroll_batch_readiness_snapshots_select ON public.payroll_batch_readiness_snapshots;
CREATE POLICY payroll_batch_readiness_snapshots_select
ON public.payroll_batch_readiness_snapshots FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_business_access uba
     WHERE uba.user_id = auth.uid()
       AND uba.business_id = payroll_batch_readiness_snapshots.business_id
  )
);

DROP POLICY IF EXISTS payroll_batch_readiness_snapshots_insert ON public.payroll_batch_readiness_snapshots;
CREATE POLICY payroll_batch_readiness_snapshots_insert
ON public.payroll_batch_readiness_snapshots FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.user_business_access uba
     WHERE uba.user_id = auth.uid()
       AND uba.business_id = payroll_batch_readiness_snapshots.business_id
  )
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payroll_run_groups_readiness_snapshot_fk') THEN
    ALTER TABLE public.payroll_run_groups
      ADD CONSTRAINT payroll_run_groups_readiness_snapshot_fk
      FOREIGN KEY (readiness_snapshot_id)
      REFERENCES public.payroll_batch_readiness_snapshots(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- D: rewrite payroll_batch_approve with readiness snapshot
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.payroll_batch_approve(uuid);
CREATE OR REPLACE FUNCTION public.payroll_batch_approve(
  p_batch_id        uuid,
  p_override_reason text DEFAULT NULL
)
RETURNS public.payroll_run_groups
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_batch   public.payroll_run_groups;
  v_unready int;
  v_snap_id uuid;
  v_pass    int := 0;
  v_fail    int := 0;
  v_warn    int := 0;
  v_details jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_batch FROM public.payroll_run_groups WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch % not found', p_batch_id USING ERRCODE='P0002'; END IF;
  IF v_batch.status <> 'review' THEN
    RAISE EXCEPTION 'batch % must be in review to approve (currently %)', p_batch_id, v_batch.status
      USING ERRCODE='22023';
  END IF;

  SELECT COUNT(*) INTO v_unready
    FROM public.payroll_runs
   WHERE group_id = p_batch_id
     AND (status IS NULL OR status IN ('draft','computing'));
  IF v_unready > 0 THEN
    RAISE EXCEPTION 'batch % has % child run(s) not yet computed', p_batch_id, v_unready
      USING ERRCODE='22023';
  END IF;

  BEGIN
    SELECT
      COALESCE(SUM(CASE WHEN status='pass'    THEN 1 ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN status='fail'    THEN 1 ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN status='warning' THEN 1 ELSE 0 END), 0),
      COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
    INTO v_pass, v_fail, v_warn, v_details
    FROM public.evaluate_payroll_readiness(
      v_batch.organization_id, v_batch.business_id, 'org',
      NULL, v_batch.period_start, v_batch.period_end
    ) r;
  EXCEPTION WHEN OTHERS THEN
    v_pass := 0; v_fail := 1; v_warn := 0;
    v_details := jsonb_build_array(jsonb_build_object(
      'status','fail','reason','readiness_eval_failed','sqlerrm',SQLERRM));
  END;

  IF v_fail > 0 AND (p_override_reason IS NULL OR length(trim(p_override_reason)) < 5) THEN
    RAISE EXCEPTION 'batch % blocked by % readiness failure(s); supply p_override_reason (>=5 chars) to override',
      p_batch_id, v_fail USING ERRCODE='22023';
  END IF;

  INSERT INTO public.payroll_batch_readiness_snapshots(
    batch_id, organization_id, business_id, period_start, period_end,
    pass_count, fail_count, warn_count, findings, override_reason, taken_by
  ) VALUES (
    v_batch.id, v_batch.organization_id, v_batch.business_id,
    v_batch.period_start, v_batch.period_end,
    v_pass, v_fail, v_warn, v_details, p_override_reason, auth.uid()
  ) RETURNING id INTO v_snap_id;

  UPDATE public.payroll_run_groups
     SET status='approved', approved_by=auth.uid(), approved_at=now(),
         readiness_snapshot_id=v_snap_id, updated_at=now()
   WHERE id=p_batch_id
   RETURNING * INTO v_batch;

  PERFORM public._payroll_batch_emit_event(v_batch, 'payroll_batch.approved',
    jsonb_build_object('pass_count',v_pass,'fail_count',v_fail,'warn_count',v_warn,'override_reason',p_override_reason));

  RETURN v_batch;
END $$;

GRANT EXECUTE ON FUNCTION public.payroll_batch_approve(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------
-- C: payroll_batch_add_run
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_batch_add_run(
  p_batch_id            uuid,
  p_pay_period_start    date,
  p_pay_period_end      date,
  p_payment_date        date DEFAULT NULL,
  p_run_type            text DEFAULT 'regular',
  p_scope_kind          public.payroll_run_scope_kind DEFAULT 'company',
  p_scope_department_id uuid DEFAULT NULL,
  p_notes               text DEFAULT NULL
)
RETURNS public.payroll_runs
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_batch public.payroll_run_groups;
  v_run   public.payroll_runs;
  v_seq   int;
  v_num   text;
BEGIN
  SELECT * INTO v_batch FROM public.payroll_run_groups WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch % not found', p_batch_id USING ERRCODE='P0002'; END IF;
  IF v_batch.status NOT IN ('draft','computing','review') THEN
    RAISE EXCEPTION 'batch % is %; runs can only be added before approval',
      p_batch_id, v_batch.status USING ERRCODE='22023';
  END IF;
  IF p_pay_period_end < p_pay_period_start THEN
    RAISE EXCEPTION 'pay_period_end must be >= pay_period_start' USING ERRCODE='22023';
  END IF;

  SELECT COALESCE(MAX(sequence_in_period),0)+1 INTO v_seq
    FROM public.payroll_runs WHERE group_id=p_batch_id;

  v_num := v_batch.batch_number || '-R' || lpad(v_seq::text,2,'0');

  INSERT INTO public.payroll_runs(
    organization_id, business_id, pay_schedule_id, group_id,
    payroll_number, pay_period_start, pay_period_end, payment_date,
    run_type, status, scope_kind, scope_department_id,
    sequence_in_period, notes, created_by
  ) VALUES (
    v_batch.organization_id, v_batch.business_id, v_batch.pay_schedule_id, v_batch.id,
    v_num, p_pay_period_start, p_pay_period_end, p_payment_date,
    p_run_type, 'draft', p_scope_kind, p_scope_department_id,
    v_seq, p_notes, auth.uid()
  ) RETURNING * INTO v_run;

  PERFORM public._payroll_batch_emit_event(v_batch,'payroll_batch.run_added',
    jsonb_build_object('run_id',v_run.id,'payroll_number',v_run.payroll_number));

  RETURN v_run;
END $$;

GRANT EXECUTE ON FUNCTION public.payroll_batch_add_run(
  uuid, date, date, date, text, public.payroll_run_scope_kind, uuid, text
) TO authenticated;

-- ---------------------------------------------------------------------
-- C: payroll_payment_batch_link
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_payment_batch_link(
  p_payment_batch_id uuid, p_batch_id uuid
)
RETURNS public.payroll_payment_batches
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_pay   public.payroll_payment_batches;
  v_batch public.payroll_run_groups;
BEGIN
  SELECT * INTO v_pay FROM public.payroll_payment_batches WHERE id=p_payment_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment batch % not found', p_payment_batch_id USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_batch FROM public.payroll_run_groups WHERE id=p_batch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'payroll batch % not found', p_batch_id USING ERRCODE='P0002'; END IF;
  IF v_pay.organization_id<>v_batch.organization_id OR v_pay.business_id<>v_batch.business_id THEN
    RAISE EXCEPTION 'payment batch and payroll batch must share org+business' USING ERRCODE='22023';
  END IF;
  IF v_pay.source_batch_id IS NOT NULL AND v_pay.source_batch_id<>p_batch_id THEN
    RAISE EXCEPTION 'payment batch % already linked to a different payroll batch', p_payment_batch_id USING ERRCODE='22023';
  END IF;
  UPDATE public.payroll_payment_batches
     SET source_batch_id=p_batch_id, updated_at=now()
   WHERE id=p_payment_batch_id
   RETURNING * INTO v_pay;
  RETURN v_pay;
END $$;

GRANT EXECUTE ON FUNCTION public.payroll_payment_batch_link(uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- B: payroll_batch_reverse
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_batch_reverse(
  p_batch_id uuid, p_reason text
)
RETURNS public.payroll_run_groups
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_batch   public.payroll_run_groups;
  v_sibling public.payroll_run_groups;
  v_idem    text;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason))<5 THEN
    RAISE EXCEPTION 'reversal reason required (>=5 chars)' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_batch FROM public.payroll_run_groups WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch % not found', p_batch_id USING ERRCODE='P0002'; END IF;
  IF v_batch.status NOT IN ('posted','paid','closed') THEN
    RAISE EXCEPTION 'batch % cannot be reversed from status %', p_batch_id, v_batch.status USING ERRCODE='22023';
  END IF;
  IF v_batch.reversal_batch_id IS NOT NULL THEN
    SELECT * INTO v_sibling FROM public.payroll_run_groups WHERE id=v_batch.reversal_batch_id;
    RETURN v_sibling;
  END IF;

  v_idem := 'reverse:' || v_batch.id::text;

  SELECT * INTO v_sibling FROM public.payroll_batch_create(
    v_batch.organization_id, v_batch.business_id, v_batch.pay_schedule_id,
    v_batch.period_start, v_batch.period_end, 'correction',
    'Reversal of ' || v_batch.batch_number, v_idem,
    'Reverses ' || v_batch.batch_number || ': ' || p_reason,
    v_batch.country_code, v_batch.id
  );

  UPDATE public.payroll_run_groups SET reversal_batch_id=v_sibling.id, updated_at=now() WHERE id=v_sibling.id;

  UPDATE public.payroll_run_groups
     SET status='reversed', reversal_batch_id=v_sibling.id,
         notes=COALESCE(notes,'') || E'\n[reversed] ' || p_reason,
         updated_at=now()
   WHERE id=v_batch.id
   RETURNING * INTO v_batch;

  PERFORM public._payroll_batch_emit_event(v_batch,'payroll_batch.reversed',
    jsonb_build_object('reason',p_reason,'sibling_batch_id',v_sibling.id));

  RETURN v_batch;
END $$;

GRANT EXECUTE ON FUNCTION public.payroll_batch_reverse(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------
-- Lifecycle trigger: allow closed → reversed
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_payroll_batch_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_allowed_run_types text[] := ARRAY['regular','13th_month','termination','bonus','off_cycle','correction','supplemental'];
  v_allowed_statuses  text[] := ARRAY['draft','computing','review','approved','posted','paid','closed','cancelled','reversed'];
  v_terminal_statuses text[] := ARRAY['cancelled','reversed'];
BEGIN
  IF NEW.run_type IS NULL OR NOT (NEW.run_type = ANY (v_allowed_run_types)) THEN
    RAISE EXCEPTION 'payroll_batch_invalid_run_type: %', NEW.run_type USING ERRCODE='check_violation';
  END IF;
  IF NEW.status IS NULL OR NOT (NEW.status = ANY (v_allowed_statuses)) THEN
    RAISE EXCEPTION 'payroll_batch_invalid_status: %', NEW.status USING ERRCODE='check_violation';
  END IF;
  IF NEW.period_end < NEW.period_start THEN
    RAISE EXCEPTION 'payroll_batch_period_inverted' USING ERRCODE='check_violation';
  END IF;
  IF NEW.parent_batch_id IS NOT NULL AND NEW.run_type NOT IN ('correction','supplemental','off_cycle') THEN
    RAISE EXCEPTION 'payroll_batch_parent_not_allowed_for_run_type: %', NEW.run_type USING ERRCODE='check_violation';
  END IF;
  IF NEW.parent_batch_id IS NOT NULL AND NEW.parent_batch_id = NEW.id THEN
    RAISE EXCEPTION 'payroll_batch_parent_self_reference' USING ERRCODE='check_violation';
  END IF;
  IF NEW.reversal_batch_id IS NOT NULL AND NEW.reversal_batch_id = NEW.id THEN
    RAISE EXCEPTION 'payroll_batch_reversal_self_reference' USING ERRCODE='check_violation';
  END IF;
  IF NEW.business_id IS NULL AND NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'payroll_batch_legacy_row_frozen_at_draft' USING ERRCODE='check_violation';
  END IF;
  IF TG_OP='UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = ANY (v_terminal_statuses) THEN
      RAISE EXCEPTION 'payroll_batch_terminal_state_immutable: % → %', OLD.status, NEW.status USING ERRCODE='check_violation';
    END IF;
    IF NOT (
         (OLD.status='draft'      AND NEW.status IN ('computing','review','cancelled'))
      OR (OLD.status='computing'  AND NEW.status IN ('review','draft','cancelled'))
      OR (OLD.status='review'     AND NEW.status IN ('approved','draft','cancelled'))
      OR (OLD.status='approved'   AND NEW.status IN ('posted','review','cancelled'))
      OR (OLD.status='posted'     AND NEW.status IN ('paid','reversed'))
      OR (OLD.status='paid'       AND NEW.status IN ('closed','reversed'))
      OR (OLD.status='closed'     AND NEW.status='reversed')
    ) THEN
      RAISE EXCEPTION 'payroll_batch_invalid_transition: % → %', OLD.status, NEW.status USING ERRCODE='check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
