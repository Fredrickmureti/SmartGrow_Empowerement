-- Wave 2.4 + 2.4-bis: Loan & salary-advance deduction integrity at payroll approval
-- =========================================================================
-- Asserts that every active loan_repayment_schedule row falling within a
-- payroll run's pay period has either been collected (payslip_id stamped)
-- OR has an explicit admin override row. Distinguishes salary-advance loans
-- (loan_types.kind = 'salary_advance') from regular loans by HINT code so
-- the UI can surface the correct copy.

-- ---------- 1. Override table (audited admin escape hatch) ---------------
CREATE TABLE IF NOT EXISTS public.payroll_run_loan_skip_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
  payroll_run_id UUID NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  loan_id UUID NOT NULL REFERENCES public.employee_loans(id) ON DELETE CASCADE,
  schedule_id UUID NOT NULL REFERENCES public.loan_repayment_schedule(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) >= 5),
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payroll_run_id, schedule_id)
);

CREATE INDEX IF NOT EXISTS idx_prlso_run ON public.payroll_run_loan_skip_overrides(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_prlso_org ON public.payroll_run_loan_skip_overrides(organization_id);

GRANT SELECT, INSERT, DELETE ON public.payroll_run_loan_skip_overrides TO authenticated;
GRANT ALL ON public.payroll_run_loan_skip_overrides TO service_role;

ALTER TABLE public.payroll_run_loan_skip_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "loan_skip_overrides_select"
  ON public.payroll_run_loan_skip_overrides FOR SELECT
  TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'view'));

CREATE POLICY "loan_skip_overrides_insert"
  ON public.payroll_run_loan_skip_overrides FOR INSERT
  TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'approve')
  );

CREATE POLICY "loan_skip_overrides_delete"
  ON public.payroll_run_loan_skip_overrides FOR DELETE
  TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'approve'));

-- ---------- 2. Integrity validator ---------------------------------------
CREATE OR REPLACE FUNCTION public.validate_payroll_run_loan_integrity(p_run_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.payroll_runs;
  v_loan_missing JSONB;
  v_advance_missing JSONB;
BEGIN
  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'run_not_found');
  END IF;

  -- Build a CTE of installments that SHOULD have been collected in this run.
  -- Conditions:
  --   * schedule due window overlaps the run's pay period
  --   * schedule still pending or partial (paid/skipped/cancelled excluded)
  --   * parent loan is active and not paused past period end
  --   * employee has a payslip on THIS run (otherwise they are simply not
  --     in scope — that is a separate completeness check, not a loan check)
  --   * schedule.payslip_id is NULL (not yet collected on any payslip)
  --     OR schedule.payslip_id points to a payslip NOT on this run
  --   * no admin override exists for (run, schedule)
  WITH expected AS (
    SELECT
      lrs.id                AS schedule_id,
      lrs.loan_id,
      lrs.sequence,
      lrs.scheduled_amount,
      lrs.due_period_start,
      lrs.due_period_end,
      el.employee_id,
      el.loan_number,
      lt.kind               AS loan_kind,
      lt.code               AS loan_type_code,
      p.id                  AS payslip_id
    FROM public.loan_repayment_schedule lrs
    JOIN public.employee_loans el ON el.id = lrs.loan_id
    LEFT JOIN public.loan_types lt ON lt.id = el.loan_type_id
    JOIN public.payslips p
      ON p.payroll_run_id = p_run_id
     AND p.employee_id    = el.employee_id
    WHERE lrs.status IN ('pending','partial')
      AND el.status = 'active'
      AND COALESCE(el.paused_until, '0001-01-01'::date) < v_run.pay_period_end
      AND COALESCE(lrs.due_period_start, v_run.pay_period_start) <= v_run.pay_period_end
      AND COALESCE(lrs.due_period_end,   v_run.pay_period_end)   >= v_run.pay_period_start
      AND (lrs.payslip_id IS NULL OR lrs.payslip_id <> p.id)
      AND NOT EXISTS (
        SELECT 1 FROM public.payroll_run_loan_skip_overrides ov
        WHERE ov.payroll_run_id = p_run_id AND ov.schedule_id = lrs.id
      )
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'schedule_id', schedule_id, 'loan_id', loan_id, 'loan_number', loan_number,
      'employee_id', employee_id, 'sequence', sequence,
      'scheduled_amount', scheduled_amount, 'loan_type_code', loan_type_code
    )) FILTER (WHERE loan_kind IS DISTINCT FROM 'salary_advance'), '[]'::jsonb),
    COALESCE(jsonb_agg(jsonb_build_object(
      'schedule_id', schedule_id, 'loan_id', loan_id, 'loan_number', loan_number,
      'employee_id', employee_id, 'sequence', sequence,
      'scheduled_amount', scheduled_amount, 'loan_type_code', loan_type_code
    )) FILTER (WHERE loan_kind = 'salary_advance'), '[]'::jsonb)
  INTO v_loan_missing, v_advance_missing
  FROM expected;

  RETURN jsonb_build_object(
    'ok', (jsonb_array_length(v_loan_missing) = 0
       AND jsonb_array_length(v_advance_missing) = 0),
    'missing_loans',    v_loan_missing,
    'missing_advances', v_advance_missing
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.validate_payroll_run_loan_integrity(UUID) TO authenticated, service_role;

-- ---------- 3. Extend approve_payroll_run ---------------------------------
CREATE OR REPLACE FUNCTION public.approve_payroll_run(p_run_id uuid)
 RETURNS payroll_runs
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_run public.payroll_runs;
  v_allowed boolean;
  v_validation jsonb;
  v_missing text[];
  v_loan_check jsonb;
  v_loan_count int;
  v_adv_count int;
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
    RAISE EXCEPTION 'You do not have permission to approve payroll for this organization.'
      USING ERRCODE = '42501';
  END IF;

  -- Phase 5 gate: required GL mappings
  v_validation := public.validate_payroll_run_mappings(p_run_id);
  IF NOT COALESCE((v_validation->>'ok')::boolean, false) THEN
    v_missing := COALESCE(
      ARRAY(SELECT jsonb_array_elements_text(v_validation->'missing_keys')),
      ARRAY[]::text[]
    );
    RAISE EXCEPTION
      'Cannot approve: % GL account mapping(s) missing — %. Configure them in Payroll → Configuration → GL Account Mapping.',
      cardinality(v_missing), array_to_string(v_missing, ', ')
      USING ERRCODE = 'P0001', HINT = 'payroll_missing_mappings';
  END IF;

  -- Wave 2.4 / 2.4-bis: loan & salary-advance deduction integrity
  v_loan_check := public.validate_payroll_run_loan_integrity(p_run_id);
  IF NOT COALESCE((v_loan_check->>'ok')::boolean, false) THEN
    v_loan_count := jsonb_array_length(v_loan_check->'missing_loans');
    v_adv_count  := jsonb_array_length(v_loan_check->'missing_advances');

    IF v_adv_count > 0 AND v_loan_count = 0 THEN
      RAISE EXCEPTION
        'Cannot approve: % salary-advance installment(s) due in this period are not deducted on any payslip. Either re-run payroll to collect them or record an explicit skip override.',
        v_adv_count
        USING ERRCODE = 'P0001', HINT = 'payroll_advance_installment_missing';
    ELSIF v_loan_count > 0 AND v_adv_count = 0 THEN
      RAISE EXCEPTION
        'Cannot approve: % loan installment(s) due in this period are not deducted on any payslip. Either re-run payroll to collect them or record an explicit skip override.',
        v_loan_count
        USING ERRCODE = 'P0001', HINT = 'payroll_loan_installment_missing';
    ELSE
      RAISE EXCEPTION
        'Cannot approve: % loan installment(s) and % salary-advance installment(s) due in this period are not deducted on any payslip.',
        v_loan_count, v_adv_count
        USING ERRCODE = 'P0001', HINT = 'payroll_loan_installment_missing';
    END IF;
  END IF;

  UPDATE public.payroll_runs
     SET status = 'approved', approved_by = v_uid, approved_at = now(), updated_at = now()
   WHERE id = p_run_id
   RETURNING * INTO v_run;

  RETURN v_run;
END;
$function$;

-- ---------- 4. Audit trigger for the override table ----------------------
CREATE OR REPLACE FUNCTION public.tg_audit_loan_skip_override()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Defensive: write to audit_logs if present, otherwise no-op.
  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    INSERT INTO public.audit_logs (
      organization_id, business_id, user_id, action, entity_type, entity_id, metadata
    ) VALUES (
      COALESCE(NEW.organization_id, OLD.organization_id),
      COALESCE(NEW.business_id, OLD.business_id),
      auth.uid(),
      CASE TG_OP WHEN 'INSERT' THEN 'loan_skip_override_created'
                 WHEN 'DELETE' THEN 'loan_skip_override_removed' END,
      'payroll_run_loan_skip_overrides',
      COALESCE(NEW.id, OLD.id),
      jsonb_build_object(
        'payroll_run_id', COALESCE(NEW.payroll_run_id, OLD.payroll_run_id),
        'loan_id',        COALESCE(NEW.loan_id, OLD.loan_id),
        'schedule_id',    COALESCE(NEW.schedule_id, OLD.schedule_id),
        'reason',         COALESCE(NEW.reason, OLD.reason)
      )
    );
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_loan_skip_override ON public.payroll_run_loan_skip_overrides;
CREATE TRIGGER trg_audit_loan_skip_override
  AFTER INSERT OR DELETE ON public.payroll_run_loan_skip_overrides
  FOR EACH ROW EXECUTE FUNCTION public.tg_audit_loan_skip_override();

COMMENT ON TABLE  public.payroll_run_loan_skip_overrides IS
  'Wave 2.4: explicit, audited admin override allowing approval of a payroll run even when a loan/advance installment scheduled in the pay period was not deducted on a payslip.';
COMMENT ON FUNCTION public.validate_payroll_run_loan_integrity(UUID) IS
  'Wave 2.4: returns {ok, missing_loans[], missing_advances[]} listing schedule rows that should have been collected on this run but were not, and have no admin override.';