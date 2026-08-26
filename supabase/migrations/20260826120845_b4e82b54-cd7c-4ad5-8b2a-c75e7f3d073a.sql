-- ============================================================
-- Wave 1: Governance owns the self-action verdict for timesheets
-- ============================================================

-- 1. Competence-only approval check (no self-approval decision here).
CREATE OR REPLACE FUNCTION public._timesheet_can_approve(_uid uuid, _employee_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_emp record;
BEGIN
  SELECT * INTO v_emp FROM public.employees WHERE id = _employee_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF public.has_role(_uid, 'admin'::public.app_role)
     OR public.has_role(_uid, 'hr_admin'::public.app_role) THEN
    RETURN true;
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.employees m WHERE m.user_id = _uid AND m.id = v_emp.manager_id);
END $$;

REVOKE ALL ON FUNCTION public._timesheet_can_approve(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._timesheet_can_approve(uuid, uuid) TO authenticated, service_role;

-- 2. Governance-owned, read-only verdict for a self-action.
--    Mirrors governance_assert_not_self's decision without mutating anything.
CREATE OR REPLACE FUNCTION public.governance_self_action_verdict(
  p_actor uuid, p_subject uuid, p_action text, p_org uuid
)
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_mode text;
  v_actor_role public.app_role;
  v_org_mode text;
BEGIN
  -- Not a self action at all.
  IF p_actor IS NULL OR p_subject IS NULL OR p_actor <> p_subject THEN RETURN 'not_self'; END IF;
  IF p_org IS NULL THEN RETURN 'block'; END IF;
  IF public._is_teardown_for_org(p_org) THEN RETURN 'allow'; END IF;

  SELECT ur.role INTO v_actor_role
    FROM public.user_roles ur
   WHERE ur.user_id = p_actor AND ur.organization_id = p_org AND ur.is_active = true
   ORDER BY CASE ur.role WHEN 'super_admin' THEN 0 WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 9 END
   LIMIT 1;

  SELECT COALESCE(governance_mode, 'standard') INTO v_org_mode
    FROM public.organizations WHERE id = p_org;
  v_org_mode := COALESCE(v_org_mode, 'standard');

  SELECT mode INTO v_mode
    FROM public.self_action_policy
   WHERE organization_id = p_org
     AND action_key = p_action
     AND (applies_to_role = v_actor_role OR applies_to_role IS NULL)
   ORDER BY (applies_to_role IS NULL) ASC
   LIMIT 1;

  IF v_mode IS NULL AND v_org_mode = 'solo'
     AND v_actor_role IN ('super_admin', 'owner', 'admin') THEN
    RETURN 'allow';
  END IF;

  IF v_mode IS NULL THEN
    IF v_org_mode = 'standard' AND v_actor_role IN ('owner', 'super_admin', 'admin') THEN
      v_mode := 'warn';
    ELSE
      v_mode := 'block';
    END IF;
  END IF;

  IF v_mode IN ('allow', 'warn') THEN RETURN v_mode; END IF;

  IF EXISTS (
    SELECT 1 FROM public.self_action_overrides o
     WHERE o.organization_id = p_org AND o.actor_user_id = p_actor
       AND o.subject_user_id = p_subject AND o.action_key = p_action
       AND o.expires_at > now() AND o.consumed_at IS NULL
  ) THEN
    RETURN 'override_available';
  END IF;

  RETURN 'block';
END $$;

REVOKE ALL ON FUNCTION public.governance_self_action_verdict(uuid, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.governance_self_action_verdict(uuid, uuid, text, uuid) TO authenticated, service_role;

-- 3. The SoD guard must pass the organisation, like every sibling guard does.
CREATE OR REPLACE FUNCTION public.guard_timesheet_self_approval()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE v_subject uuid;
BEGIN
  IF COALESCE(NEW.approved_by, '00000000-0000-0000-0000-000000000000'::uuid)
     = COALESCE(OLD.approved_by, '00000000-0000-0000-0000-000000000000'::uuid) THEN
    RETURN NEW;
  END IF;
  IF NEW.approved_by IS NULL THEN RETURN NEW; END IF;
  SELECT user_id INTO v_subject FROM public.employees WHERE id = NEW.employee_id;
  IF v_subject IS NOT NULL THEN
    PERFORM public.governance_assert_not_self(
      NEW.approved_by, v_subject, 'timesheet.approve',
      NEW.organization_id, 'timesheet_submission', NEW.id
    );
  END IF;
  RETURN NEW;
END $$;

-- 4. Approve / reject: competence + lifecycle only. Governance owns self-action.
CREATE OR REPLACE FUNCTION public.approve_timesheet_submission(_submission_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_uid uuid := auth.uid(); s record; v_billable numeric := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO s FROM public.timesheet_submissions WHERE id = _submission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF s.status <> 'submitted' THEN RAISE EXCEPTION 'Submission is not pending'; END IF;

  IF NOT public._timesheet_can_approve(v_uid, s.employee_id) THEN
    RAISE EXCEPTION 'Not allowed to approve this submission';
  END IF;

  -- Self-approval verdict is enforced by sod_timesheet_submissions_guard
  -- (Governance). Do not duplicate that decision here.
  UPDATE public.timesheet_submissions
     SET status='approved', approved_by=v_uid, approved_at=now()
   WHERE id = _submission_id;

  UPDATE public.timesheets
     SET status='approved', approved_by=v_uid, approved_at=now()
   WHERE employee_id=s.employee_id AND date BETWEEN s.period_start AND s.period_end AND status='submitted';

  SELECT COALESCE(SUM(hours),0) INTO v_billable
    FROM public.timesheets
   WHERE employee_id=s.employee_id AND date BETWEEN s.period_start AND s.period_end
     AND status='approved' AND is_billable;

  PERFORM public._timesheet_emit_event(
    s.organization_id, 'timesheet.approved', 'timesheet_submission', _submission_id,
    jsonb_build_object('business_id', s.business_id, 'employee_id', s.employee_id,
                       'period_start', s.period_start, 'period_end', s.period_end,
                       'total_hours', s.total_hours, 'billable_hours', v_billable),
    'timesheet.approved:' || _submission_id::text);

  IF v_billable > 0 THEN
    PERFORM public._timesheet_emit_event(
      s.organization_id, 'timesheet.billable_ready', 'timesheet_submission', _submission_id,
      jsonb_build_object('business_id', s.business_id, 'employee_id', s.employee_id,
                         'period_start', s.period_start, 'period_end', s.period_end,
                         'billable_hours', v_billable),
      'timesheet.billable_ready:' || _submission_id::text);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.reject_timesheet_submission(_submission_id uuid, _reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_uid uuid := auth.uid(); s record;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF _reason IS NULL OR length(trim(_reason)) = 0 THEN RAISE EXCEPTION 'Rejection reason is required'; END IF;
  SELECT * INTO s FROM public.timesheet_submissions WHERE id = _submission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF s.status <> 'submitted' THEN RAISE EXCEPTION 'Submission is not pending'; END IF;

  IF NOT public._timesheet_can_approve(v_uid, s.employee_id) THEN
    RAISE EXCEPTION 'Not allowed to reject this submission';
  END IF;

  UPDATE public.timesheet_submissions
     SET status='rejected', rejected_by=v_uid, rejected_at=now(), rejection_reason=_reason
   WHERE id=_submission_id;

  UPDATE public.timesheets
     SET status='rejected', rejected_by=v_uid, rejected_at=now(), rejection_reason=_reason
   WHERE employee_id=s.employee_id AND date BETWEEN s.period_start AND s.period_end AND status='submitted';

  PERFORM public._timesheet_emit_event(
    s.organization_id, 'timesheet.rejected', 'timesheet_submission', _submission_id,
    jsonb_build_object('business_id', s.business_id, 'employee_id', s.employee_id,
                       'period_start', s.period_start, 'period_end', s.period_end,
                       'reason', _reason),
    'timesheet.rejected:' || _submission_id::text || ':' || extract(epoch from now())::bigint::text);
END $$;

-- 5. Retire the superseded 3-argument competence check and the duplicate setting.
DROP FUNCTION IF EXISTS public._timesheet_can_approve(uuid, uuid, boolean);
ALTER TABLE public.timesheet_settings DROP COLUMN IF EXISTS allow_self_approval;

-- ============================================================
-- Wave 2: server-authoritative approval capability projection
-- ============================================================
CREATE OR REPLACE FUNCTION public.timesheet_approval_capability(_submission_id uuid)
RETURNS TABLE(can_approve boolean, requires_override boolean, reason text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  s record;
  v_subject uuid;
  v_verdict text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT false, false, 'not_authenticated'; RETURN;
  END IF;

  SELECT * INTO s FROM public.timesheet_submissions WHERE id = _submission_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, 'not_found'; RETURN;
  END IF;
  IF s.status <> 'submitted' THEN
    RETURN QUERY SELECT false, false, 'not_pending'; RETURN;
  END IF;
  IF NOT public._timesheet_can_approve(v_uid, s.employee_id) THEN
    RETURN QUERY SELECT false, false, 'not_authorized'; RETURN;
  END IF;

  SELECT user_id INTO v_subject FROM public.employees WHERE id = s.employee_id;
  v_verdict := public.governance_self_action_verdict(v_uid, v_subject, 'timesheet.approve', s.organization_id);

  IF v_verdict IN ('not_self', 'allow', 'warn') THEN
    RETURN QUERY SELECT true, false, v_verdict; RETURN;
  ELSIF v_verdict = 'override_available' THEN
    RETURN QUERY SELECT true, true, v_verdict; RETURN;
  END IF;

  RETURN QUERY SELECT false, true, 'self_action_blocked';
END $$;

REVOKE ALL ON FUNCTION public.timesheet_approval_capability(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.timesheet_approval_capability(uuid) TO authenticated, service_role;