ALTER TABLE public.timesheets
  ADD COLUMN IF NOT EXISTS start_time time NULL,
  ADD COLUMN IF NOT EXISTS end_time time NULL,
  ADD COLUMN IF NOT EXISTS submitted_by uuid NULL,
  ADD COLUMN IF NOT EXISTS updated_by uuid NULL,
  ADD COLUMN IF NOT EXISTS payroll_period_id uuid NULL REFERENCES public.payroll_periods(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payroll_locked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS correction_of uuid NULL REFERENCES public.timesheets(id) ON DELETE SET NULL;

ALTER TABLE public.timesheet_settings
  ADD COLUMN IF NOT EXISTS allow_self_approval boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS block_on_time_off_overlap boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.timesheet_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timesheet_id uuid NOT NULL REFERENCES public.timesheets(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  business_id uuid NULL,
  action text NOT NULL,
  from_status text NULL,
  to_status text NULL,
  actor_user_id uuid NULL,
  reason text NULL,
  metadata jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_timesheet_audit_log_ts ON public.timesheet_audit_log(timesheet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_timesheet_audit_log_org ON public.timesheet_audit_log(organization_id, created_at DESC);

ALTER TABLE public.timesheet_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Audit log readable to org members" ON public.timesheet_audit_log;
CREATE POLICY "Audit log readable to org members"
ON public.timesheet_audit_log FOR SELECT
USING (public.is_org_member(auth.uid(), organization_id));

CREATE INDEX IF NOT EXISTS idx_timesheets_scope_date
  ON public.timesheets(organization_id, business_id, employee_id, date);
CREATE INDEX IF NOT EXISTS idx_timesheets_project_date
  ON public.timesheets(project_id, date) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_timesheets_status_business
  ON public.timesheets(status, business_id);
CREATE INDEX IF NOT EXISTS idx_timesheets_payroll_period
  ON public.timesheets(payroll_period_id) WHERE payroll_period_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.trg_timesheets_billing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rate numeric; v_project_billable boolean;
BEGIN
  IF NEW.is_billable THEN
    IF NEW.project_id IS NULL THEN RAISE EXCEPTION 'Billable time requires a project'; END IF;
    SELECT p.is_billable, COALESCE(NEW.billing_rate, p.hourly_rate)
      INTO v_project_billable, v_rate
      FROM public.projects p WHERE p.id = NEW.project_id;
    IF v_project_billable IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'Project is not billable'; END IF;
    IF v_rate IS NULL OR v_rate <= 0 THEN RAISE EXCEPTION 'No billing rate configured for project'; END IF;
    NEW.billing_rate := v_rate;
    NEW.billing_amount := ROUND((COALESCE(NEW.hours,0) * v_rate)::numeric, 2);
  ELSE
    NEW.billing_rate := NULL;
    NEW.billing_amount := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS timesheets_billing ON public.timesheets;
CREATE TRIGGER timesheets_billing
BEFORE INSERT OR UPDATE OF hours, is_billable, billing_rate, project_id
ON public.timesheets FOR EACH ROW EXECUTE FUNCTION public.trg_timesheets_billing();

CREATE OR REPLACE FUNCTION public.trg_timesheets_lock_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_is_admin boolean := false;
BEGIN
  SELECT public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'hr_admin') INTO v_is_admin;
  IF (TG_OP = 'UPDATE') THEN
    IF (OLD.is_invoiced OR OLD.payroll_locked) AND NOT v_is_admin THEN
      RAISE EXCEPTION 'Timesheet is locked (invoiced or payroll-closed) and cannot be edited';
    END IF;
  ELSIF (TG_OP = 'DELETE') THEN
    IF (OLD.is_invoiced OR OLD.payroll_locked) AND NOT v_is_admin THEN
      RAISE EXCEPTION 'Timesheet is locked (invoiced or payroll-closed) and cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS timesheets_lock_guard ON public.timesheets;
CREATE TRIGGER timesheets_lock_guard
BEFORE UPDATE OR DELETE ON public.timesheets
FOR EACH ROW EXECUTE FUNCTION public.trg_timesheets_lock_guard();

CREATE OR REPLACE FUNCTION public.trg_timesheets_employee_active()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  SELECT is_active, hire_date, termination_date INTO r FROM public.employees WHERE id = NEW.employee_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found'; END IF;
  IF r.is_active IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'Employee is inactive'; END IF;
  IF r.hire_date IS NOT NULL AND NEW.date < r.hire_date THEN RAISE EXCEPTION 'Date is before employee hire date'; END IF;
  IF r.termination_date IS NOT NULL AND NEW.date > r.termination_date THEN RAISE EXCEPTION 'Date is after employee termination date'; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS timesheets_employee_active ON public.timesheets;
CREATE TRIGGER timesheets_employee_active
BEFORE INSERT OR UPDATE OF employee_id, date ON public.timesheets
FOR EACH ROW EXECUTE FUNCTION public.trg_timesheets_employee_active();

CREATE OR REPLACE FUNCTION public.trg_timesheets_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.payroll_locked IS DISTINCT FROM OLD.payroll_locked
       OR NEW.is_invoiced IS DISTINCT FROM OLD.is_invoiced THEN
      INSERT INTO public.timesheet_audit_log
        (timesheet_id, organization_id, business_id, action, from_status, to_status, actor_user_id, metadata)
      VALUES (
        NEW.id, NEW.organization_id, NEW.business_id,
        CASE
          WHEN NEW.payroll_locked IS DISTINCT FROM OLD.payroll_locked
            THEN CASE WHEN NEW.payroll_locked THEN 'payroll_locked' ELSE 'payroll_unlocked' END
          WHEN NEW.is_invoiced IS DISTINCT FROM OLD.is_invoiced
            THEN CASE WHEN NEW.is_invoiced THEN 'invoiced' ELSE 'invoice_reverted' END
          ELSE 'status_change'
        END,
        OLD.status, NEW.status, auth.uid(),
        jsonb_build_object('rejection_reason', NEW.rejection_reason)
      );
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO public.timesheet_audit_log
      (timesheet_id, organization_id, business_id, action, to_status, actor_user_id)
    VALUES (NEW.id, NEW.organization_id, NEW.business_id, 'created', NEW.status, auth.uid());
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS timesheets_audit ON public.timesheets;
CREATE TRIGGER timesheets_audit
AFTER INSERT OR UPDATE ON public.timesheets
FOR EACH ROW EXECUTE FUNCTION public.trg_timesheets_audit();

CREATE OR REPLACE FUNCTION public.trg_timesheets_set_updated_by()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  NEW.updated_by := auth.uid();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS timesheets_set_updated_by ON public.timesheets;
CREATE TRIGGER timesheets_set_updated_by
BEFORE UPDATE ON public.timesheets
FOR EACH ROW EXECUTE FUNCTION public.trg_timesheets_set_updated_by();

CREATE OR REPLACE FUNCTION public.submit_timesheet_period(
  _employee_id uuid, _period_start date, _period_end date, _notes text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_emp record; v_uid uuid := auth.uid(); v_is_self boolean;
  v_total numeric := 0; v_billable numeric := 0; v_submission_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO v_emp FROM public.employees WHERE id = _employee_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found'; END IF;
  v_is_self := v_emp.user_id = v_uid;
  IF NOT v_is_self
     AND NOT public.has_role(v_uid, 'admin')
     AND NOT public.has_role(v_uid, 'hr_admin')
     AND NOT EXISTS (SELECT 1 FROM public.employees m WHERE m.user_id = v_uid AND m.id = v_emp.manager_id)
  THEN RAISE EXCEPTION 'Not allowed to submit for this employee'; END IF;

  SELECT COALESCE(SUM(hours),0), COALESCE(SUM(CASE WHEN is_billable THEN hours ELSE 0 END),0)
    INTO v_total, v_billable
  FROM public.timesheets
  WHERE employee_id = _employee_id AND date BETWEEN _period_start AND _period_end AND status = 'draft';

  IF v_total = 0 THEN RAISE EXCEPTION 'No draft entries to submit'; END IF;

  INSERT INTO public.timesheet_submissions
    (organization_id, business_id, employee_id, period_start, period_end,
     total_hours, billable_hours, status, submitted_at, notes)
  VALUES
    (v_emp.organization_id, v_emp.business_id, _employee_id, _period_start, _period_end,
     v_total, v_billable, 'submitted', now(), _notes)
  RETURNING id INTO v_submission_id;

  UPDATE public.timesheets
     SET status='submitted', submitted_at=now(), submitted_by=v_uid
   WHERE employee_id=_employee_id AND date BETWEEN _period_start AND _period_end AND status='draft';

  RETURN v_submission_id;
END $$;

CREATE OR REPLACE FUNCTION public._timesheet_can_approve(_uid uuid, _employee_id uuid, _allow_self boolean)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_emp record;
BEGIN
  SELECT * INTO v_emp FROM public.employees WHERE id = _employee_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_emp.user_id = _uid AND NOT _allow_self THEN RETURN false; END IF;
  IF public.has_role(_uid, 'admin') OR public.has_role(_uid, 'hr_admin') THEN RETURN true; END IF;
  RETURN EXISTS (SELECT 1 FROM public.employees m WHERE m.user_id = _uid AND m.id = v_emp.manager_id);
END $$;

CREATE OR REPLACE FUNCTION public.approve_timesheet_submission(_submission_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); s record; allow_self boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO s FROM public.timesheet_submissions WHERE id = _submission_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF s.status <> 'submitted' THEN RAISE EXCEPTION 'Submission is not pending'; END IF;

  SELECT COALESCE(allow_self_approval,false) INTO allow_self
    FROM public.timesheet_settings WHERE organization_id = s.organization_id LIMIT 1;
  IF NOT public._timesheet_can_approve(v_uid, s.employee_id, COALESCE(allow_self,false)) THEN
    RAISE EXCEPTION 'Not allowed to approve this submission';
  END IF;

  UPDATE public.timesheet_submissions
     SET status='approved', approved_by=v_uid, approved_at=now()
   WHERE id = _submission_id;

  UPDATE public.timesheets
     SET status='approved', approved_by=v_uid, approved_at=now()
   WHERE employee_id=s.employee_id AND date BETWEEN s.period_start AND s.period_end AND status='submitted';
END $$;

CREATE OR REPLACE FUNCTION public.reject_timesheet_submission(_submission_id uuid, _reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); s record; allow_self boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF _reason IS NULL OR length(trim(_reason)) = 0 THEN RAISE EXCEPTION 'Rejection reason is required'; END IF;
  SELECT * INTO s FROM public.timesheet_submissions WHERE id = _submission_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF s.status <> 'submitted' THEN RAISE EXCEPTION 'Submission is not pending'; END IF;

  SELECT COALESCE(allow_self_approval,false) INTO allow_self
    FROM public.timesheet_settings WHERE organization_id = s.organization_id LIMIT 1;
  IF NOT public._timesheet_can_approve(v_uid, s.employee_id, COALESCE(allow_self,false)) THEN
    RAISE EXCEPTION 'Not allowed to reject this submission';
  END IF;

  UPDATE public.timesheet_submissions
     SET status='rejected', rejected_by=v_uid, rejected_at=now(), rejection_reason=_reason
   WHERE id=_submission_id;

  UPDATE public.timesheets
     SET status='rejected', rejected_by=v_uid, rejected_at=now(), rejection_reason=_reason
   WHERE employee_id=s.employee_id AND date BETWEEN s.period_start AND s.period_end AND status='submitted';
END $$;

CREATE OR REPLACE FUNCTION public.lock_timesheets_for_payroll(_payroll_period_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); p record; v_count integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (public.has_role(v_uid,'admin') OR public.has_role(v_uid,'hr_admin') OR public.has_role(v_uid,'payroll_admin')) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;
  SELECT * INTO p FROM public.payroll_periods WHERE id = _payroll_period_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll period not found'; END IF;
  WITH upd AS (
    UPDATE public.timesheets
       SET payroll_period_id=_payroll_period_id, payroll_locked=true
     WHERE organization_id=p.organization_id
       AND (p.business_id IS NULL OR business_id=p.business_id)
       AND date BETWEEN p.start_date AND p.end_date
       AND status='approved' AND payroll_locked=false
    RETURNING 1
  ) SELECT count(*) INTO v_count FROM upd;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION public.unlock_timesheets_for_payroll(_payroll_period_id uuid, _reason text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_count integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_role(v_uid,'admin') THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF _reason IS NULL OR length(trim(_reason))=0 THEN RAISE EXCEPTION 'Reason required'; END IF;
  WITH upd AS (
    UPDATE public.timesheets SET payroll_locked=false, payroll_period_id=NULL
     WHERE payroll_period_id=_payroll_period_id RETURNING 1
  ) SELECT count(*) INTO v_count FROM upd;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION public.mark_timesheets_invoiced(_invoice_id uuid, _timesheet_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_count integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  WITH upd AS (
    UPDATE public.timesheets SET is_invoiced=true, invoice_id=_invoice_id
     WHERE id = ANY(_timesheet_ids) AND status='approved' AND is_billable=true AND is_invoiced=false
    RETURNING 1
  ) SELECT count(*) INTO v_count FROM upd;
  RETURN v_count;
END $$;

CREATE OR REPLACE VIEW public.v_timesheet_payroll_ready AS
SELECT t.organization_id, t.business_id, t.employee_id,
       date_trunc('month', t.date)::date AS period_month,
       SUM(t.hours) AS total_hours,
       SUM(CASE WHEN t.is_billable THEN t.hours ELSE 0 END) AS billable_hours,
       SUM(CASE WHEN t.payroll_locked THEN t.hours ELSE 0 END) AS locked_hours
FROM public.timesheets t
WHERE t.status='approved'
GROUP BY 1,2,3,4;