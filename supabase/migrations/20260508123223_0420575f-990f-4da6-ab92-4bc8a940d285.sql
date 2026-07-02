-- Payroll approval policy + policy-aware maker-checker enforcement.
-- Replaces the blunt creator≠approver rule with a policy that:
--   * always allows owner/admin/super_admin to self-approve (default)
--   * supports a strict mode that forbids self-approval for everyone
--   * supports a permissive mode for small workspaces with one payroll approver
--   * always requires the approver to actually have payroll.approve permission

-- 1) Per-business approval policy column
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS payroll_self_approval_policy text
    NOT NULL DEFAULT 'admin_only'
    CHECK (payroll_self_approval_policy IN ('admin_only','disabled','permitted_users'));

COMMENT ON COLUMN public.businesses.payroll_self_approval_policy IS
  'admin_only (default): owner/admin/super_admin may self-approve payroll runs. '
  'disabled: strict maker-checker for everyone. '
  'permitted_users: any user with payroll.approve permission may self-approve.';

-- 2) Replace the trigger function with policy-aware logic
CREATE OR REPLACE FUNCTION public.enforce_payroll_maker_checker()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role public.app_role;
  v_policy text;
  v_has_approve boolean := false;
BEGIN
  IF TG_OP <> 'UPDATE'
     OR NEW.status NOT IN ('approved','posted','finalized')
     OR COALESCE(OLD.status,'') IN ('approved','posted','finalized') THEN
    RETURN NEW;
  END IF;

  IF NEW.approved_by IS NULL THEN
    RAISE EXCEPTION 'Payroll approval requires an approver (approved_by must be set).';
  END IF;

  -- Verify approver has payroll.approve authority (admin/owner short-circuit inside helper).
  v_has_approve := public.user_has_module_permission(
    NEW.approved_by, NEW.organization_id, 'payroll', 'approve'
  );
  IF NOT v_has_approve THEN
    RAISE EXCEPTION 'Approver lacks payroll.approve permission. Grant it via Access Groups or assign an admin/owner.';
  END IF;

  -- Self-approval handling
  IF NEW.created_by IS NOT NULL AND NEW.approved_by = NEW.created_by THEN
    SELECT ur.role INTO v_role
    FROM public.user_roles ur
    WHERE ur.user_id = NEW.approved_by
      AND ur.organization_id = NEW.organization_id
      AND ur.is_active = true
    LIMIT 1;

    SELECT b.payroll_self_approval_policy INTO v_policy
    FROM public.businesses b WHERE b.id = NEW.business_id;
    v_policy := COALESCE(v_policy, 'admin_only');

    IF v_policy = 'disabled' THEN
      RAISE EXCEPTION 'Payroll self-approval is disabled for this workspace. A different authorized user must approve.';
    ELSIF v_policy = 'admin_only' THEN
      IF v_role NOT IN ('super_admin','owner','admin') THEN
        RAISE EXCEPTION 'Only owner/admin may self-approve payroll under the current policy. Ask another approver, or change the Payroll Self-Approval Policy in business settings.';
      END IF;
    END IF;
    -- permitted_users: allowed because v_has_approve already true
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger already exists from prior migration; replace bind to the new function body (no-op if same name).
DROP TRIGGER IF EXISTS trg_enforce_payroll_maker_checker ON public.payroll_runs;
CREATE TRIGGER trg_enforce_payroll_maker_checker
  BEFORE UPDATE ON public.payroll_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_payroll_maker_checker();

-- 3) Canonical approval RPC — one place where payroll runs become approved.
CREATE OR REPLACE FUNCTION public.approve_payroll_run(p_run_id uuid)
RETURNS public.payroll_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_run public.payroll_runs;
  v_allowed boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payroll run not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_run.status NOT IN ('draft','processed') THEN
    RAISE EXCEPTION 'Payroll run is in status % and cannot be approved.', v_run.status;
  END IF;

  v_allowed := public.user_has_module_permission(
    v_uid, v_run.organization_id, 'payroll', 'approve'
  );
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'You do not have permission to approve payroll. Ask an admin to grant your Access Group the Payroll Approve permission.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.payroll_runs
     SET status = 'approved',
         approved_by = v_uid,
         approved_at = now(),
         updated_at = now()
   WHERE id = p_run_id
   RETURNING * INTO v_run;

  RETURN v_run;
END;
$$;

GRANT EXECUTE ON FUNCTION public.approve_payroll_run(uuid) TO authenticated;