
-- ─── Attendance approval gate ─────────────────────────────────────────────
ALTER TABLE public.attendance_settings
  ADD COLUMN IF NOT EXISTS require_approval_for_payroll boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.attendance_settings.require_approval_for_payroll IS
  'When true, compute-payroll only counts attendance rows where approved_by IS NOT NULL.';

-- ─── Termination payouts staging table ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pending_termination_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  employment_id uuid NOT NULL,
  leave_type_id uuid,
  payout_kind text NOT NULL CHECK (payout_kind IN ('leave_encashment','severance','notice','other')),
  days_paid numeric(10,2),
  amount numeric(14,2),
  notes text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','consumed','cancelled')),
  consumed_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pending_termination_payouts TO authenticated;
GRANT ALL ON public.pending_termination_payouts TO service_role;
ALTER TABLE public.pending_termination_payouts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ptp_read" ON public.pending_termination_payouts;
CREATE POLICY "ptp_read" ON public.pending_termination_payouts FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), business_id, 'hr', 'read'));
DROP POLICY IF EXISTS "ptp_write" ON public.pending_termination_payouts;
CREATE POLICY "ptp_write" ON public.pending_termination_payouts FOR ALL TO authenticated
  USING (public.user_has_module_permission(auth.uid(), business_id, 'hr', 'write'))
  WITH CHECK (public.user_has_module_permission(auth.uid(), business_id, 'hr', 'write'));

CREATE INDEX IF NOT EXISTS idx_ptp_employee_status ON public.pending_termination_payouts(employee_id, status);
CREATE INDEX IF NOT EXISTS idx_ptp_org_status ON public.pending_termination_payouts(organization_id, status);

DROP TRIGGER IF EXISTS trg_ptp_updated_at ON public.pending_termination_payouts;
CREATE TRIGGER trg_ptp_updated_at BEFORE UPDATE ON public.pending_termination_payouts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─── Queue encashment on termination ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.queue_termination_payouts()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_balance numeric;
  v_days numeric;
  lt RECORD;
BEGIN
  -- Only fire on the active→terminated transition.
  IF NEW.status <> 'terminated' OR COALESCE(OLD.status,'active') = 'terminated' THEN
    RETURN NEW;
  END IF;

  FOR lt IN
    SELECT id, encashment_max_days
    FROM public.leave_types
    WHERE organization_id = NEW.organization_id
      AND COALESCE(is_active, true)
      AND encashment_max_days IS DISTINCT FROM 0   -- 0 = disabled
  LOOP
    -- Resolve current leave balance (best-effort; the actual leave-balance
    -- function may not exist in every project — wrap in EXCEPTION to stay
    -- forward-compatible).
    BEGIN
      EXECUTE format(
        'SELECT COALESCE(SUM(balance_days),0) FROM public.leave_balances WHERE employee_id = $1 AND leave_type_id = $2'
      ) INTO v_balance USING NEW.employee_id, lt.id;
    EXCEPTION WHEN undefined_table OR undefined_column THEN
      v_balance := 0;
    END;

    IF v_balance IS NULL OR v_balance <= 0 THEN
      CONTINUE;
    END IF;

    v_days := v_balance;
    IF lt.encashment_max_days IS NOT NULL THEN
      v_days := LEAST(v_days, lt.encashment_max_days);
    END IF;

    IF v_days > 0 THEN
      INSERT INTO public.pending_termination_payouts(
        organization_id, business_id, employee_id, employment_id,
        leave_type_id, payout_kind, days_paid, notes
      ) VALUES (
        NEW.organization_id, NEW.business_id, NEW.employee_id, NEW.id,
        lt.id, 'leave_encashment', v_days,
        'Auto-queued on termination (' || COALESCE(NEW.termination_type,'other') || ')'
      );
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_queue_termination_payouts ON public.employments;
CREATE TRIGGER trg_queue_termination_payouts
  AFTER UPDATE ON public.employments
  FOR EACH ROW EXECUTE FUNCTION public.queue_termination_payouts();

COMMENT ON FUNCTION public.queue_termination_payouts() IS
  'On employments.status active→terminated, queues a leave_encashment row per leave_type with a non-zero encashment_max_days and a positive balance. Daily-rate × days_paid is computed by compute-payroll at run time.';
