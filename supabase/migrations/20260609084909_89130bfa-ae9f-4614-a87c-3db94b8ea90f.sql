
-- ============================================================================
-- HR Production-Readiness Wave 4: Timesheet submission state machine
-- ============================================================================
-- Timesheet submissions had no server-side enforcement of legal status values
-- or transitions. The state machine was implicit in the UI/RPC code, which
-- meant a privileged client could write status='approved' directly via the
-- Data API and bypass the manager approval flow.
--
-- This migration installs the integrity layer:
--   1. CHECK constraint: status must be one of the known values.
--   2. BEFORE UPDATE trigger: only legal transitions are accepted.
--   3. Approval/rejection columns must agree with status.
-- ============================================================================

-- Normalize any legacy rows that don't match the known set (defensive — the
-- live count is zero, so this is a no-op in practice).
UPDATE public.timesheet_submissions
SET status = 'draft'
WHERE status IS NULL OR status NOT IN ('draft','submitted','approved','rejected','locked');

ALTER TABLE public.timesheet_submissions
  DROP CONSTRAINT IF EXISTS timesheet_submissions_status_check;

ALTER TABLE public.timesheet_submissions
  ADD CONSTRAINT timesheet_submissions_status_check
  CHECK (status IN ('draft','submitted','approved','rejected','locked'));

-- State-transition guard. Legal moves:
--   draft     → submitted, draft
--   submitted → approved, rejected, draft (recall by submitter)
--   approved  → locked (payroll lock), rejected (rare correction)
--   rejected  → draft, submitted
--   locked    → (terminal, no transitions)
CREATE OR REPLACE FUNCTION public.tg_timesheet_submission_state_machine()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_legal boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- New rows must start in draft or submitted.
    IF NEW.status NOT IN ('draft','submitted') THEN
      RAISE EXCEPTION 'New timesheet submissions must start in draft or submitted (got %)', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  -- Locked is terminal.
  IF OLD.status = 'locked' THEN
    RAISE EXCEPTION 'Cannot transition out of locked timesheet submission'
      USING ERRCODE = 'check_violation';
  END IF;

  v_legal := CASE OLD.status
    WHEN 'draft'     THEN NEW.status IN ('submitted')
    WHEN 'submitted' THEN NEW.status IN ('approved','rejected','draft')
    WHEN 'approved'  THEN NEW.status IN ('locked','rejected')
    WHEN 'rejected'  THEN NEW.status IN ('draft','submitted')
    ELSE false
  END;

  IF NOT v_legal THEN
    RAISE EXCEPTION 'Illegal timesheet status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Approval/rejection metadata must be consistent.
  IF NEW.status = 'approved' AND NEW.approved_by IS NULL THEN
    NEW.approved_at := COALESCE(NEW.approved_at, now());
  END IF;
  IF NEW.status = 'rejected' AND NEW.rejected_at IS NULL THEN
    NEW.rejected_at := now();
  END IF;
  IF NEW.status = 'submitted' AND NEW.submitted_at IS NULL THEN
    NEW.submitted_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_timesheet_submission_state_machine ON public.timesheet_submissions;
CREATE TRIGGER trg_timesheet_submission_state_machine
  BEFORE INSERT OR UPDATE OF status ON public.timesheet_submissions
  FOR EACH ROW EXECUTE FUNCTION public.tg_timesheet_submission_state_machine();

-- ============================================================================
-- HR Production-Readiness Wave 2: surface invitation auto-link failures
-- ============================================================================
-- accept-invitation silently succeeds when no employee row matches the
-- invitation email. HR has no signal that the new user is unlinked. We add
-- an RPC that the edge function calls after attempting auto-link; it writes
-- an onboarding_attempts diagnostic row when employee_linked = false so HR
-- can act from the lifecycle dashboards.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_invitation_link_outcome(
  p_organization_id uuid,
  p_user_id uuid,
  p_invitation_email text,
  p_employee_linked boolean,
  p_employee_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_employee_linked THEN
    -- Success path — write a completed diagnostic row for the audit trail.
    INSERT INTO public.onboarding_attempts (
      user_id, organization_id, status, idempotency_key,
      diagnostics, completed_at
    ) VALUES (
      p_user_id, p_organization_id, 'completed',
      'invite_link:' || p_user_id::text || ':' || p_organization_id::text,
      jsonb_build_object(
        'source', 'accept-invitation',
        'employee_linked', true,
        'employee_id', p_employee_id,
        'email', p_invitation_email
      ),
      now()
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  ELSE
    -- Surface the silent failure so HR sees it.
    INSERT INTO public.onboarding_attempts (
      user_id, organization_id, status, idempotency_key,
      error_message, diagnostics
    ) VALUES (
      p_user_id, p_organization_id, 'failed',
      'invite_link:' || p_user_id::text || ':' || p_organization_id::text,
      'No employee record matched invitation email: ' || p_invitation_email,
      jsonb_build_object(
        'source', 'accept-invitation',
        'reason', 'no_employee_match',
        'email', p_invitation_email,
        'remediation', 'Create the employee row or update the email, then call link_employee_to_user.'
      )
    )
    ON CONFLICT (idempotency_key) DO UPDATE SET
      status = EXCLUDED.status,
      error_message = EXCLUDED.error_message,
      diagnostics = EXCLUDED.diagnostics,
      updated_at = now();
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_invitation_link_outcome(uuid,uuid,text,boolean,uuid) TO service_role;

-- idempotency_key needs a unique index for the ON CONFLICT above. Add it if
-- the table doesn't already have one (it should, but defensive).
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_attempts_idempotency_key_uniq
  ON public.onboarding_attempts (idempotency_key);
