
-- =====================================================================
-- payslip self-link for retro deltas
-- =====================================================================
ALTER TABLE public.payslips
  ADD COLUMN IF NOT EXISTS retro_of_payslip_id uuid
    REFERENCES public.payslips(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS retro_effective_from date;

CREATE INDEX IF NOT EXISTS idx_payslips_retro_of
  ON public.payslips(retro_of_payslip_id)
  WHERE retro_of_payslip_id IS NOT NULL;

-- =====================================================================
-- retro adjustment queue
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.retro_pay_adjustments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL,
  business_id              uuid,
  employee_id              uuid NOT NULL,
  source_payslip_id        uuid NOT NULL REFERENCES public.payslips(id) ON DELETE CASCADE,
  effective_from           date NOT NULL,
  period_start             date NOT NULL,
  period_end               date NOT NULL,
  reason                   text,
  status                   text NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','applied','cancelled')),
  applied_run_id           uuid REFERENCES public.payroll_runs(id) ON DELETE SET NULL,
  applied_payslip_id       uuid REFERENCES public.payslips(id) ON DELETE SET NULL,
  applied_at               timestamptz,
  created_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_payslip_id, status)
    DEFERRABLE INITIALLY DEFERRED
);

GRANT SELECT, INSERT, UPDATE ON public.retro_pay_adjustments TO authenticated;
GRANT ALL ON public.retro_pay_adjustments TO service_role;

ALTER TABLE public.retro_pay_adjustments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "retro_adj_view" ON public.retro_pay_adjustments
  FOR SELECT TO authenticated
  USING (public.user_has_module_permission(
    auth.uid(), organization_id, 'payroll', 'view'));

CREATE POLICY "retro_adj_write" ON public.retro_pay_adjustments
  FOR ALL TO authenticated
  USING (public.user_has_module_permission(
    auth.uid(), organization_id, 'payroll', 'approve'))
  WITH CHECK (public.user_has_module_permission(
    auth.uid(), organization_id, 'payroll', 'approve'));

CREATE INDEX IF NOT EXISTS idx_retro_adj_employee_status
  ON public.retro_pay_adjustments(employee_id, status);
CREATE INDEX IF NOT EXISTS idx_retro_adj_org_status
  ON public.retro_pay_adjustments(organization_id, status);

CREATE TRIGGER trg_retro_pay_adjustments_updated_at
  BEFORE UPDATE ON public.retro_pay_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =====================================================================
-- RPC: queue retro adjustments for an employee's posted payslips
-- =====================================================================
CREATE OR REPLACE FUNCTION public.payroll_compute_retro_for_employee(
  p_employee_id    uuid,
  p_effective_from date,
  p_reason         text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_emp      record;
  v_queued   int  := 0;
  v_existing int  := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_effective_from IS NULL OR p_effective_from > CURRENT_DATE THEN
    RAISE EXCEPTION 'effective_from must be a past or today date'
      USING ERRCODE = '22023';
  END IF;

  SELECT id, organization_id, business_id INTO v_emp
    FROM public.employees WHERE id = p_employee_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.user_has_module_permission(
      v_uid, v_emp.organization_id, 'payroll', 'approve') THEN
    RAISE EXCEPTION 'You do not have permission to queue retro payroll adjustments.'
      USING ERRCODE = '42501';
  END IF;

  -- Queue one adjustment per posted/approved payslip whose period
  -- overlaps the effective date. Skip ones already queued.
  WITH affected AS (
    SELECT ps.id, pr.pay_period_start, pr.pay_period_end
      FROM public.payslips ps
      JOIN public.payroll_runs pr ON pr.id = ps.payroll_run_id
     WHERE ps.employee_id = p_employee_id
       AND ps.retro_of_payslip_id IS NULL                -- never queue a delta of a delta
       AND COALESCE(pr.status,'') IN ('approved','posted','paid')
       AND pr.pay_period_end >= p_effective_from
  ),
  inserted AS (
    INSERT INTO public.retro_pay_adjustments (
      organization_id, business_id, employee_id,
      source_payslip_id, effective_from,
      period_start, period_end, reason, created_by
    )
    SELECT
      v_emp.organization_id, v_emp.business_id, p_employee_id,
      a.id, p_effective_from,
      a.pay_period_start, a.pay_period_end, p_reason, v_uid
    FROM affected a
    WHERE NOT EXISTS (
      SELECT 1 FROM public.retro_pay_adjustments rpa
       WHERE rpa.source_payslip_id = a.id
         AND rpa.status = 'pending'
    )
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_queued FROM inserted;

  SELECT COUNT(*) INTO v_existing
    FROM public.retro_pay_adjustments rpa
    JOIN public.payslips ps ON ps.id = rpa.source_payslip_id
    JOIN public.payroll_runs pr ON pr.id = ps.payroll_run_id
   WHERE rpa.employee_id = p_employee_id
     AND rpa.status      = 'pending'
     AND pr.pay_period_end >= p_effective_from;

  RETURN jsonb_build_object(
    'ok',              true,
    'queued',          v_queued,
    'pending_total',   v_existing,
    'effective_from',  p_effective_from
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_compute_retro_for_employee(uuid, date, text)
  TO authenticated, service_role;
