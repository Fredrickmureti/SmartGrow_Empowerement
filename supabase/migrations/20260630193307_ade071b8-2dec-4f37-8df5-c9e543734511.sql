
-- ============================================================
-- P1. Lifecycle columns on payroll_run_loan_skip_overrides
-- ============================================================
ALTER TABLE public.payroll_run_loan_skip_overrides
  ADD COLUMN IF NOT EXISTS employee_id uuid REFERENCES public.employees(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS reason_category text,
  ADD COLUMN IF NOT EXISTS evidence_url text,
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by uuid,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz,
  ADD COLUMN IF NOT EXISTS consumed_payslip_id uuid REFERENCES public.payslips(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS source_event_id uuid,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.payroll_run_loan_skip_overrides ALTER COLUMN created_by DROP NOT NULL;

UPDATE public.payroll_run_loan_skip_overrides ov
SET employee_id = el.employee_id
FROM public.employee_loans el
WHERE ov.loan_id = el.id AND ov.employee_id IS NULL;

UPDATE public.payroll_run_loan_skip_overrides
SET status='approved', approved_at=created_at, approved_by=created_by
WHERE status='pending' AND created_by IS NOT NULL;

ALTER TABLE public.payroll_run_loan_skip_overrides ALTER COLUMN employee_id SET NOT NULL;

ALTER TABLE public.payroll_run_loan_skip_overrides DROP CONSTRAINT IF EXISTS prlso_status_check;
ALTER TABLE public.payroll_run_loan_skip_overrides
  ADD CONSTRAINT prlso_status_check CHECK (status IN ('pending','approved','rejected','cancelled','expired','consumed'));

ALTER TABLE public.payroll_run_loan_skip_overrides DROP CONSTRAINT IF EXISTS prlso_source_check;
ALTER TABLE public.payroll_run_loan_skip_overrides
  ADD CONSTRAINT prlso_source_check CHECK (source IN ('user','hr_event','system'));

ALTER TABLE public.payroll_run_loan_skip_overrides DROP CONSTRAINT IF EXISTS prlso_reason_category_check;
ALTER TABLE public.payroll_run_loan_skip_overrides
  ADD CONSTRAINT prlso_reason_category_check
    CHECK (reason_category IS NULL OR reason_category IN
      ('unpaid_leave','leave_of_absence','suspension','hardship','dispute','payroll_error','employer_directive','other'));

CREATE INDEX IF NOT EXISTS idx_prlso_status ON public.payroll_run_loan_skip_overrides(status);
CREATE INDEX IF NOT EXISTS idx_prlso_employee ON public.payroll_run_loan_skip_overrides(employee_id);
CREATE INDEX IF NOT EXISTS idx_prlso_loan ON public.payroll_run_loan_skip_overrides(loan_id);

CREATE OR REPLACE FUNCTION public.tg_touch_prlso_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS trg_touch_prlso_updated_at ON public.payroll_run_loan_skip_overrides;
CREATE TRIGGER trg_touch_prlso_updated_at BEFORE UPDATE ON public.payroll_run_loan_skip_overrides
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_prlso_updated_at();

CREATE OR REPLACE FUNCTION public.tg_prlso_protect_terminal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'consumed' THEN
    RAISE EXCEPTION 'override % is consumed and cannot be modified', OLD.id;
  END IF;
  IF OLD.status IN ('rejected','cancelled','expired') AND TG_OP = 'UPDATE' THEN
    IF NEW.payroll_run_id IS DISTINCT FROM OLD.payroll_run_id
       OR NEW.loan_id IS DISTINCT FROM OLD.loan_id
       OR NEW.schedule_id IS DISTINCT FROM OLD.schedule_id
       OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
       OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.reason_category IS DISTINCT FROM OLD.reason_category THEN
      RAISE EXCEPTION 'override % is terminal (%); core fields are immutable', OLD.id, OLD.status;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_prlso_protect_terminal ON public.payroll_run_loan_skip_overrides;
CREATE TRIGGER trg_prlso_protect_terminal BEFORE UPDATE ON public.payroll_run_loan_skip_overrides
  FOR EACH ROW EXECUTE FUNCTION public.tg_prlso_protect_terminal();

CREATE OR REPLACE FUNCTION public.tg_prlso_no_destructive_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'override % is %; cancel via RPC instead of deleting', OLD.id, OLD.status;
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS trg_prlso_no_destructive_delete ON public.payroll_run_loan_skip_overrides;
CREATE TRIGGER trg_prlso_no_destructive_delete BEFORE DELETE ON public.payroll_run_loan_skip_overrides
  FOR EACH ROW EXECUTE FUNCTION public.tg_prlso_no_destructive_delete();

CREATE OR REPLACE FUNCTION public.tg_prlso_validate_run_status()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM public.payroll_runs WHERE id = NEW.payroll_run_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'payroll run not found'; END IF;
  IF v_status NOT IN ('draft','computing','computed','processing') THEN
    RAISE EXCEPTION 'cannot record skip override on run in status %', v_status;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_prlso_validate_run_status ON public.payroll_run_loan_skip_overrides;
CREATE TRIGGER trg_prlso_validate_run_status BEFORE INSERT ON public.payroll_run_loan_skip_overrides
  FOR EACH ROW EXECUTE FUNCTION public.tg_prlso_validate_run_status();

-- ============================================================
-- P6. Audit log
-- ============================================================
CREATE TABLE IF NOT EXISTS public.loan_skip_override_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  override_id uuid NOT NULL REFERENCES public.payroll_run_loan_skip_overrides(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('submitted','approved','rejected','cancelled','expired','consumed','system_proposed')),
  prior_status text,
  new_status text,
  actor_user_id uuid,
  reason text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.loan_skip_override_events TO authenticated;
GRANT ALL ON public.loan_skip_override_events TO service_role;
ALTER TABLE public.loan_skip_override_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "loan_skip_override_events_select" ON public.loan_skip_override_events;
CREATE POLICY "loan_skip_override_events_select" ON public.loan_skip_override_events FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'view'));

CREATE OR REPLACE FUNCTION public.tg_loan_skip_override_events_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'loan_skip_override_events is append-only'; END $$;
DROP TRIGGER IF EXISTS trg_loan_skip_override_events_immutable ON public.loan_skip_override_events;
CREATE TRIGGER trg_loan_skip_override_events_immutable BEFORE UPDATE OR DELETE ON public.loan_skip_override_events
  FOR EACH ROW EXECUTE FUNCTION public.tg_loan_skip_override_events_immutable();

CREATE INDEX IF NOT EXISTS idx_lsoe_override ON public.loan_skip_override_events(override_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lsoe_org ON public.loan_skip_override_events(organization_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.tg_audit_loan_skip_override()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.loan_skip_override_events(organization_id, override_id, event_type, prior_status, new_status, actor_user_id, reason, payload)
    VALUES (NEW.organization_id, NEW.id,
      CASE WHEN NEW.source = 'hr_event' THEN 'system_proposed' ELSE 'submitted' END,
      NULL, NEW.status, NEW.created_by, NEW.reason,
      jsonb_build_object('source', NEW.source, 'reason_category', NEW.reason_category, 'source_event_id', NEW.source_event_id));
    RETURN NEW;
  END IF;
  RETURN NULL;
END $$;

-- ============================================================
-- P1. Maker-checker RPCs
-- ============================================================
CREATE OR REPLACE FUNCTION public.loan_skip_override_approve(_override_id uuid)
RETURNS public.payroll_run_loan_skip_overrides
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r public.payroll_run_loan_skip_overrides; v_uid uuid := auth.uid(); v_lt record;
BEGIN
  SELECT * INTO r FROM public.payroll_run_loan_skip_overrides WHERE id=_override_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'override not found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'override is %, cannot approve', r.status; END IF;
  IF NOT public.user_has_module_permission(v_uid, r.organization_id, 'payroll', 'approve') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF r.created_by IS NOT NULL AND r.created_by = v_uid THEN
    RAISE EXCEPTION 'maker-checker: a different approver is required';
  END IF;
  SELECT lt.allow_skip, lt.max_skips_per_loan
    INTO v_lt
  FROM public.employee_loans el JOIN public.loan_types lt ON lt.id = el.loan_type_id
  WHERE el.id = r.loan_id;
  IF v_lt.allow_skip IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'loan_type forbids skips';
  END IF;
  IF v_lt.max_skips_per_loan IS NOT NULL THEN
    IF (SELECT count(*) FROM public.payroll_run_loan_skip_overrides
         WHERE loan_id = r.loan_id AND status IN ('approved','consumed')) >= v_lt.max_skips_per_loan THEN
      RAISE EXCEPTION 'loan has reached max_skips_per_loan (%)', v_lt.max_skips_per_loan;
    END IF;
  END IF;
  UPDATE public.payroll_run_loan_skip_overrides
    SET status='approved', approved_by=v_uid, approved_at=now()
    WHERE id=_override_id RETURNING * INTO r;
  INSERT INTO public.loan_skip_override_events(organization_id, override_id, event_type, prior_status, new_status, actor_user_id)
    VALUES (r.organization_id, r.id, 'approved', 'pending', 'approved', v_uid);
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.loan_skip_override_reject(_override_id uuid, _reason text)
RETURNS public.payroll_run_loan_skip_overrides
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r public.payroll_run_loan_skip_overrides; v_uid uuid := auth.uid();
BEGIN
  SELECT * INTO r FROM public.payroll_run_loan_skip_overrides WHERE id=_override_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'override not found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'override is %, cannot reject', r.status; END IF;
  IF NOT public.user_has_module_permission(v_uid, r.organization_id, 'payroll', 'approve') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  UPDATE public.payroll_run_loan_skip_overrides
    SET status='rejected', rejected_by=v_uid, rejected_at=now(), rejection_reason=_reason
    WHERE id=_override_id RETURNING * INTO r;
  INSERT INTO public.loan_skip_override_events(organization_id, override_id, event_type, prior_status, new_status, actor_user_id, reason)
    VALUES (r.organization_id, r.id, 'rejected', 'pending', 'rejected', v_uid, _reason);
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.loan_skip_override_cancel(_override_id uuid, _reason text)
RETURNS public.payroll_run_loan_skip_overrides
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r public.payroll_run_loan_skip_overrides; v_uid uuid := auth.uid();
BEGIN
  SELECT * INTO r FROM public.payroll_run_loan_skip_overrides WHERE id=_override_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'override not found'; END IF;
  IF r.status NOT IN ('pending','approved') THEN RAISE EXCEPTION 'override is %, cannot cancel', r.status; END IF;
  IF NOT public.user_has_module_permission(v_uid, r.organization_id, 'payroll', 'approve') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  UPDATE public.payroll_run_loan_skip_overrides
    SET status='cancelled', cancelled_by=v_uid, cancelled_at=now()
    WHERE id=_override_id RETURNING * INTO r;
  INSERT INTO public.loan_skip_override_events(organization_id, override_id, event_type, prior_status, new_status, actor_user_id, reason)
    VALUES (r.organization_id, r.id, 'cancelled', NULL, 'cancelled', v_uid, _reason);
  RETURN r;
END $$;

GRANT EXECUTE ON FUNCTION public.loan_skip_override_approve(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.loan_skip_override_reject(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.loan_skip_override_cancel(uuid, text) TO authenticated;

-- ============================================================
-- P2. Loan-type skip governance
-- ============================================================
ALTER TABLE public.loan_types
  ADD COLUMN IF NOT EXISTS allow_skip boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_skips_per_loan integer,
  ADD COLUMN IF NOT EXISTS max_skips_per_calendar_year integer,
  ADD COLUMN IF NOT EXISTS requires_dual_approval boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS interest_treatment_on_skip text NOT NULL DEFAULT 'accrue',
  ADD COLUMN IF NOT EXISTS schedule_adjustment_on_skip text NOT NULL DEFAULT 'push_end',
  ADD COLUMN IF NOT EXISTS min_gap_between_skips_days integer NOT NULL DEFAULT 30;

ALTER TABLE public.loan_types DROP CONSTRAINT IF EXISTS loan_types_interest_treatment_chk;
ALTER TABLE public.loan_types
  ADD CONSTRAINT loan_types_interest_treatment_chk
    CHECK (interest_treatment_on_skip IN ('none','accrue','capitalize'));

ALTER TABLE public.loan_types DROP CONSTRAINT IF EXISTS loan_types_schedule_adj_chk;
ALTER TABLE public.loan_types
  ADD CONSTRAINT loan_types_schedule_adj_chk
    CHECK (schedule_adjustment_on_skip IN ('push_end','extend_tenure','balloon','absorb_into_next'));

-- ============================================================
-- P2. Schedule adjustment engine
-- ============================================================
CREATE OR REPLACE FUNCTION public.apply_loan_skip_schedule_adjustment(
  _loan_id uuid, _schedule_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_adj text; v_sched record; v_last_seq int; v_next_id uuid; v_amount numeric; v_period_end date; v_remaining int; v_per numeric;
BEGIN
  SELECT lt.schedule_adjustment_on_skip INTO v_adj
  FROM public.employee_loans el JOIN public.loan_types lt ON lt.id = el.loan_type_id
  WHERE el.id = _loan_id;
  IF v_adj IS NULL THEN v_adj := 'push_end'; END IF;

  SELECT * INTO v_sched FROM public.loan_repayment_schedule WHERE id=_schedule_id FOR UPDATE;
  IF v_sched.id IS NULL THEN RAISE EXCEPTION 'schedule not found'; END IF;
  IF v_sched.status = 'skipped' THEN
    RETURN jsonb_build_object('ok', true, 'noop', true);
  END IF;
  v_amount := v_sched.scheduled_amount;

  UPDATE public.loan_repayment_schedule
    SET status='skipped', notes = COALESCE(notes,'')||' [skipped by override]', updated_at=now()
    WHERE id=_schedule_id;

  IF v_adj = 'push_end' THEN
    SELECT max(sequence), max(due_period_end) INTO v_last_seq, v_period_end
      FROM public.loan_repayment_schedule WHERE loan_id=_loan_id;
    INSERT INTO public.loan_repayment_schedule(loan_id, sequence, due_period_start, due_period_end, scheduled_amount, status, notes)
    VALUES (_loan_id, v_last_seq+1, v_period_end + 1, v_period_end + 30, v_amount, 'pending',
            '[appended from skip of seq '||v_sched.sequence||']');
  ELSIF v_adj = 'absorb_into_next' THEN
    SELECT id INTO v_next_id FROM public.loan_repayment_schedule
      WHERE loan_id=_loan_id AND status IN ('pending','partial') AND sequence > v_sched.sequence
      ORDER BY sequence LIMIT 1;
    IF v_next_id IS NOT NULL THEN
      UPDATE public.loan_repayment_schedule
        SET scheduled_amount = scheduled_amount + v_amount,
            notes = COALESCE(notes,'')||' [+'||v_amount||' absorbed from skipped seq '||v_sched.sequence||']',
            updated_at=now()
        WHERE id=v_next_id;
    ELSE
      SELECT max(sequence), max(due_period_end) INTO v_last_seq, v_period_end FROM public.loan_repayment_schedule WHERE loan_id=_loan_id;
      INSERT INTO public.loan_repayment_schedule(loan_id, sequence, due_period_start, due_period_end, scheduled_amount, status, notes)
      VALUES (_loan_id, v_last_seq+1, v_period_end + 1, v_period_end + 30, v_amount, 'pending', '[appended fallback]');
    END IF;
  ELSIF v_adj = 'balloon' THEN
    SELECT id INTO v_next_id FROM public.loan_repayment_schedule
      WHERE loan_id=_loan_id AND status IN ('pending','partial')
      ORDER BY sequence DESC LIMIT 1;
    IF v_next_id IS NOT NULL THEN
      UPDATE public.loan_repayment_schedule
        SET scheduled_amount = scheduled_amount + v_amount,
            notes = COALESCE(notes,'')||' [balloon +'||v_amount||' from skipped seq '||v_sched.sequence||']',
            updated_at=now()
        WHERE id=v_next_id;
    END IF;
  ELSIF v_adj = 'extend_tenure' THEN
    SELECT count(*) INTO v_remaining FROM public.loan_repayment_schedule
      WHERE loan_id=_loan_id AND status IN ('pending','partial');
    IF v_remaining = 0 THEN
      SELECT max(sequence), max(due_period_end) INTO v_last_seq, v_period_end FROM public.loan_repayment_schedule WHERE loan_id=_loan_id;
      INSERT INTO public.loan_repayment_schedule(loan_id, sequence, due_period_start, due_period_end, scheduled_amount, status, notes)
      VALUES (_loan_id, v_last_seq+1, v_period_end+1, v_period_end+30, v_amount, 'pending', '[extend_tenure new period]');
    ELSE
      v_per := round((v_amount / (v_remaining + 1))::numeric, 2);
      UPDATE public.loan_repayment_schedule
        SET scheduled_amount = scheduled_amount + v_per,
            notes = COALESCE(notes,'')||' [+'||v_per||' from extend_tenure of seq '||v_sched.sequence||']',
            updated_at=now()
        WHERE loan_id=_loan_id AND status IN ('pending','partial');
      SELECT max(sequence), max(due_period_end) INTO v_last_seq, v_period_end FROM public.loan_repayment_schedule WHERE loan_id=_loan_id;
      INSERT INTO public.loan_repayment_schedule(loan_id, sequence, due_period_start, due_period_end, scheduled_amount, status, notes)
      VALUES (_loan_id, v_last_seq+1, v_period_end+1, v_period_end+30, v_per, 'pending', '[extend_tenure new period]');
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'adjustment', v_adj, 'amount', v_amount);
END $$;
GRANT EXECUTE ON FUNCTION public.apply_loan_skip_schedule_adjustment(uuid, uuid) TO authenticated, service_role;

-- ============================================================
-- P3. Readiness rules
-- ============================================================
INSERT INTO public.payroll_readiness_rules
  (organization_id, code, name, description, scope, severity, source, reason_code, check_kind, remediation_label, predicate_sql, sort_order)
VALUES
  (NULL, 'run.loan_skip_override_pending_approval',
   'Loan skip overrides awaiting approval',
   'Block posting when any loan skip override on this run is still pending second-eye approval.',
   'run','block','core','RUN_LOAN_SKIP_OVERRIDE_PENDING','sql','Open approval queue',
   'SELECT EXISTS (SELECT 1 FROM payroll_run_loan_skip_overrides WHERE payroll_run_id = $4 AND status = ''pending'')',
   240),
  (NULL, 'run.loan_skip_override_invalid_target',
   'Loan skip override targets an invalid installment',
   'Block posting when an approved override points to an installment that is no longer pending or whose loan is no longer active.',
   'run','block','core','RUN_LOAN_SKIP_OVERRIDE_INVALID','sql','Review overrides',
   'SELECT EXISTS (SELECT 1 FROM payroll_run_loan_skip_overrides o JOIN loan_repayment_schedule s ON s.id = o.schedule_id JOIN employee_loans el ON el.id = o.loan_id WHERE o.payroll_run_id = $4 AND o.status = ''approved'' AND (s.status NOT IN (''pending'',''partial'') OR el.status <> ''active''))',
   241),
  (NULL, 'run.loan_skip_override_policy_breach',
   'Loan skip override breaches loan-type policy',
   'Block posting when an approved override violates the loan type''s skip policy.',
   'run','block','core','RUN_LOAN_SKIP_OVERRIDE_POLICY','sql','Open loan type settings',
   'SELECT EXISTS (SELECT 1 FROM payroll_run_loan_skip_overrides o JOIN employee_loans el ON el.id = o.loan_id JOIN loan_types lt ON lt.id = el.loan_type_id WHERE o.payroll_run_id = $4 AND o.status = ''approved'' AND (lt.allow_skip = false OR (lt.max_skips_per_loan IS NOT NULL AND (SELECT count(*) FROM payroll_run_loan_skip_overrides x WHERE x.loan_id = o.loan_id AND x.status IN (''approved'',''consumed'')) > lt.max_skips_per_loan)))',
   242),
  (NULL, 'run.loan_skip_override_employee_not_in_run',
   'Loan skip override references an employee not in this run',
   'Warn when an override is approved for an employee who has no payslip in this run.',
   'run','warn','core','RUN_LOAN_SKIP_OVERRIDE_NO_PAYSLIP','sql','Review overrides',
   'SELECT EXISTS (SELECT 1 FROM payroll_run_loan_skip_overrides o WHERE o.payroll_run_id = $4 AND o.status = ''approved'' AND NOT EXISTS (SELECT 1 FROM payslips p WHERE p.payroll_run_id = o.payroll_run_id AND p.employee_id = o.employee_id))',
   243)
ON CONFLICT DO NOTHING;

-- ============================================================
-- P4. HR auto-proposal trigger
-- ============================================================
CREATE OR REPLACE FUNCTION public.tg_hr_event_propose_loan_skip()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_auto boolean; v_run record; v_loan record; v_sched record; v_category text;
BEGIN
  IF NEW.event_type IN ('reinstated','leave_of_absence_ended','returned_from_leave') THEN
    UPDATE public.payroll_run_loan_skip_overrides ov
      SET status='cancelled', cancelled_at=now(), updated_at=now()
      WHERE employee_id = NEW.employee_id AND status = 'pending' AND source = 'hr_event';
    RETURN NEW;
  END IF;

  IF NEW.event_type NOT IN ('leave_of_absence_started','suspended','unpaid_leave_started') THEN
    RETURN NEW;
  END IF;

  v_category := CASE NEW.event_type
    WHEN 'leave_of_absence_started' THEN 'leave_of_absence'
    WHEN 'suspended' THEN 'suspension'
    ELSE 'unpaid_leave' END;

  SELECT unpaid_leave_auto_pause INTO v_auto FROM public.payroll_loan_recovery_policy
    WHERE organization_id = NEW.organization_id ORDER BY business_id NULLS LAST LIMIT 1;
  IF v_auto IS DISTINCT FROM TRUE THEN RETURN NEW; END IF;

  FOR v_run IN
    SELECT id, pay_period_start, pay_period_end FROM public.payroll_runs
    WHERE organization_id = NEW.organization_id AND status IN ('draft','computed','computing')
  LOOP
    FOR v_loan IN
      SELECT id FROM public.employee_loans
      WHERE employee_id = NEW.employee_id AND status = 'active'
    LOOP
      FOR v_sched IN
        SELECT id FROM public.loan_repayment_schedule
        WHERE loan_id = v_loan.id AND status IN ('pending','partial')
          AND due_period_end BETWEEN v_run.pay_period_start AND v_run.pay_period_end
      LOOP
        INSERT INTO public.payroll_run_loan_skip_overrides
          (organization_id, payroll_run_id, loan_id, schedule_id, employee_id, reason, reason_category, source, source_event_id, status, created_by)
        VALUES
          (NEW.organization_id, v_run.id, v_loan.id, v_sched.id, NEW.employee_id,
           'Auto-proposed: '||NEW.event_type, v_category, 'hr_event', NEW.id, 'pending', NULL)
        ON CONFLICT (payroll_run_id, schedule_id) DO NOTHING;
      END LOOP;
    END LOOP;
  END LOOP;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_hr_event_propose_loan_skip ON public.employee_lifecycle_events;
CREATE TRIGGER trg_hr_event_propose_loan_skip AFTER INSERT ON public.employee_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION public.tg_hr_event_propose_loan_skip();

-- ============================================================
-- P8. Route the legacy RPC through the override pipeline
-- ============================================================
CREATE OR REPLACE FUNCTION public.employee_loan_skip_installment(_loan_id uuid, _schedule_id uuid, _reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_loan record; v_run_id uuid; v_id uuid;
BEGIN
  SELECT employee_id, organization_id INTO v_loan FROM public.employee_loans WHERE id=_loan_id;
  IF v_loan.organization_id IS NULL THEN RAISE EXCEPTION 'loan not found'; END IF;
  SELECT id INTO v_run_id FROM public.payroll_runs
    WHERE organization_id = v_loan.organization_id AND status IN ('draft','computed','computing')
    ORDER BY pay_period_end DESC LIMIT 1;
  IF v_run_id IS NULL THEN RAISE EXCEPTION 'no open payroll run to attach skip override'; END IF;
  INSERT INTO public.payroll_run_loan_skip_overrides
    (organization_id, payroll_run_id, loan_id, schedule_id, employee_id, reason, reason_category, source, status, created_by)
  VALUES
    (v_loan.organization_id, v_run_id, _loan_id, _schedule_id, v_loan.employee_id, _reason, 'other', 'system', 'pending', auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
