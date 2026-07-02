-- Phase 5 — Payroll lifecycle integrity
-- 1. Approval gate: block approve if run-specific GL mappings are missing
-- 2. Paid-path guard: forbid direct UPDATE to status='paid' unless trusted GUC is set

CREATE OR REPLACE FUNCTION public.approve_payroll_run(p_run_id uuid)
 RETURNS payroll_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_run public.payroll_runs;
  v_allowed boolean;
  v_validation jsonb;
  v_missing text[];
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

  -- Phase 5 gate: every required GL mapping for THIS run must be configured before approval.
  -- This prevents the "approve now, fail at post" surprise that previously hit Fredrick's run.
  v_validation := public.validate_payroll_run_mappings(p_run_id);
  IF NOT COALESCE((v_validation->>'ok')::boolean, false) THEN
    v_missing := COALESCE(
      ARRAY(SELECT jsonb_array_elements_text(v_validation->'missing_keys')),
      ARRAY[]::text[]
    );
    RAISE EXCEPTION
      'Cannot approve: % GL account mapping(s) missing for this run — %. Configure them in Payroll → Configuration → GL Account Mapping.',
      cardinality(v_missing),
      array_to_string(v_missing, ', ')
      USING ERRCODE = 'P0001',
            HINT    = 'payroll_missing_mappings';
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
$function$;

-- Paid-path guard: only the trusted payment-batch posting path may flip rows to 'paid'.
-- Trusted callers set: SET LOCAL app.payroll_payment_via_batch = 'on';
CREATE OR REPLACE FUNCTION public.payroll_runs_paid_path_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'paid' AND COALESCE(OLD.status,'') <> 'paid' THEN
    IF COALESCE(current_setting('app.payroll_payment_via_batch', true), '') <> 'on' THEN
      RAISE EXCEPTION
        'Payroll runs can only be marked paid via the payment-batch posting path (post-payroll-payment-gl). Direct status updates are forbidden.'
        USING ERRCODE = '42501', HINT = 'payroll_paid_bypass_blocked';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_runs_paid_path_guard ON public.payroll_runs;
CREATE TRIGGER trg_payroll_runs_paid_path_guard
BEFORE UPDATE OF status ON public.payroll_runs
FOR EACH ROW
EXECUTE FUNCTION public.payroll_runs_paid_path_guard();

CREATE OR REPLACE FUNCTION public.payslips_paid_path_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'paid' AND COALESCE(OLD.status,'') <> 'paid' THEN
    IF COALESCE(current_setting('app.payroll_payment_via_batch', true), '') <> 'on' THEN
      RAISE EXCEPTION
        'Payslips can only be marked paid via the payment-batch posting path (post-payroll-payment-gl). Direct status updates are forbidden.'
        USING ERRCODE = '42501', HINT = 'payroll_paid_bypass_blocked';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payslips_paid_path_guard ON public.payslips;
CREATE TRIGGER trg_payslips_paid_path_guard
BEFORE UPDATE OF status ON public.payslips
FOR EACH ROW
EXECUTE FUNCTION public.payslips_paid_path_guard();