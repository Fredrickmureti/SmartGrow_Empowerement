
-- =====================================================================
-- WAVE 2.6 — probation tracking column
-- =====================================================================
ALTER TABLE public.employee_contracts
  ADD COLUMN IF NOT EXISTS probation_end_date date;

CREATE INDEX IF NOT EXISTS idx_employee_contracts_probation_end
  ON public.employee_contracts(probation_end_date)
  WHERE probation_end_date IS NOT NULL;

-- =====================================================================
-- WAVE 2.5 — termination payout reconciliation
-- =====================================================================

-- Loose FK on consumed_run_id (best-effort, SET NULL to preserve history)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pending_termination_payouts_consumed_run_id_fkey'
  ) THEN
    ALTER TABLE public.pending_termination_payouts
      ADD CONSTRAINT pending_termination_payouts_consumed_run_id_fkey
      FOREIGN KEY (consumed_run_id)
      REFERENCES public.payroll_runs(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE OR REPLACE VIEW public.v_termination_payout_reconciliation
WITH (security_invoker = true)
AS
SELECT
  ptp.id                                                AS payout_id,
  ptp.organization_id,
  ptp.business_id,
  ptp.employee_id,
  ptp.employment_id,
  ptp.leave_type_id,
  ptp.payout_kind,
  ptp.days_paid,
  ptp.amount                                            AS payout_amount,
  ptp.status                                            AS payout_status,
  ptp.consumed_run_id,
  ptp.created_at                                        AS queued_at,
  ptp.updated_at                                        AS payout_updated_at,
  pr.status                                             AS run_status,
  pr.run_type,
  pr.is_final_settlement,
  pr.payment_date                                       AS run_payment_date,
  pr.posted_at                                          AS run_posted_at,
  ps.id                                                 AS payslip_id,
  ps.status                                             AS payslip_status,
  ps.net_pay                                            AS payslip_net_pay,
  -- Variance: payout amount vs payslip net (NULL when either side missing)
  CASE
    WHEN ptp.amount IS NULL OR ps.net_pay IS NULL THEN NULL
    ELSE ROUND(ptp.amount - ps.net_pay, 2)
  END                                                   AS amount_variance,
  -- status_match: 'ok' when payout consumed AND run posted;
  --              'orphan' when payout consumed but linked run missing or reversed;
  --              'pending_run' when payout still pending but a run already exists;
  --              'pending' when payout still pending and no run yet.
  CASE
    WHEN ptp.status = 'cancelled'                                  THEN 'cancelled'
    WHEN ptp.status = 'consumed' AND pr.id IS NULL                 THEN 'orphan'
    WHEN ptp.status = 'consumed' AND pr.status IN ('approved','posted','paid') THEN 'ok'
    WHEN ptp.status = 'consumed' AND pr.reversed_at IS NOT NULL    THEN 'reversed'
    WHEN ptp.status = 'consumed'                                   THEN 'consumed_unposted'
    WHEN ptp.status = 'pending'  AND pr.id IS NOT NULL             THEN 'pending_run_open'
    ELSE 'pending'
  END                                                   AS status_match,
  GREATEST(0, (CURRENT_DATE - ptp.created_at::date))    AS days_open
FROM public.pending_termination_payouts ptp
LEFT JOIN public.payroll_runs pr
  ON pr.id = ptp.consumed_run_id
LEFT JOIN public.payslips ps
  ON ps.payroll_run_id = pr.id
 AND ps.employee_id    = ptp.employee_id;

GRANT SELECT ON public.v_termination_payout_reconciliation TO authenticated;
GRANT SELECT ON public.v_termination_payout_reconciliation TO service_role;

-- =====================================================================
-- WAVE 3.6 — final-settlement run consumes pending termination payouts
-- =====================================================================
CREATE OR REPLACE FUNCTION public.consume_pending_termination_payouts(p_run_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run   public.payroll_runs;
  v_count integer := 0;
BEGIN
  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payroll run % not found', p_run_id USING ERRCODE = 'P0002';
  END IF;

  -- Only final-settlement runs consume queued payouts.
  IF NOT COALESCE(v_run.is_final_settlement, false)
     OR v_run.final_settlement_employee_id IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.pending_termination_payouts
     SET status          = 'consumed',
         consumed_run_id = p_run_id,
         updated_at      = now()
   WHERE employee_id      = v_run.final_settlement_employee_id
     AND organization_id  = v_run.organization_id
     AND status           = 'pending';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.consume_pending_termination_payouts(uuid) TO authenticated, service_role;

-- Extend approve_payroll_run to auto-consume on final-settlement approval.
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

  -- Wave 3.6: atomically consume pending termination payouts for final-settlement runs.
  IF COALESCE(v_run.is_final_settlement, false) THEN
    PERFORM public.consume_pending_termination_payouts(p_run_id);
  END IF;

  RETURN v_run;
END;
$function$;

-- =====================================================================
-- WAVE 2.6 — probation expiry notifier
-- =====================================================================
CREATE OR REPLACE FUNCTION public.notify_probation_expiry()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total integer := 0;
  r RECORD;
  u RECORD;
  v_days_left integer;
  v_title text;
  v_msg text;
BEGIN
  FOR r IN
    SELECT
      ec.id                AS contract_id,
      ec.organization_id,
      ec.business_id,
      ec.employee_id,
      ec.probation_end_date,
      e.first_name,
      e.last_name
    FROM public.employee_contracts ec
    JOIN public.employees e ON e.id = ec.employee_id
    WHERE ec.probation_end_date IS NOT NULL
      AND ec.probation_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '14 days'
      AND ec.status IN ('new','running')
  LOOP
    v_days_left := (r.probation_end_date - CURRENT_DATE);
    v_title := 'Probation ending in ' || v_days_left || ' day' ||
               CASE WHEN v_days_left = 1 THEN '' ELSE 's' END;
    v_msg := COALESCE(r.first_name,'') || ' ' || COALESCE(r.last_name,'') ||
             '''s probation period ends on ' ||
             to_char(r.probation_end_date,'YYYY-MM-DD') ||
             '. Confirm or extend before that date.';

    -- Notify every user holding hr.manage (or hr.approve) in this org.
    FOR u IN
      SELECT DISTINCT ur.user_id
      FROM public.user_roles ur
      WHERE ur.organization_id = r.organization_id
        AND ur.role IN ('owner','admin')
    LOOP
      -- Skip duplicates within the same day.
      IF NOT EXISTS (
        SELECT 1 FROM public.notifications n
        WHERE n.user_id = u.user_id
          AND n.entity_type = 'employee_contract'
          AND n.entity_id   = r.contract_id
          AND n.category    = 'hr'
          AND n.created_at::date = CURRENT_DATE
      ) THEN
        INSERT INTO public.notifications(
          organization_id, business_id, user_id,
          type, category, title, message, link,
          entity_type, entity_id, priority
        ) VALUES (
          r.organization_id, r.business_id, u.user_id,
          CASE WHEN v_days_left <= 3 THEN 'warning' ELSE 'info' END,
          'hr', v_title, v_msg,
          '/hr/employees/' || r.employee_id::text,
          'employee_contract', r.contract_id,
          CASE WHEN v_days_left <= 3 THEN 1 ELSE 0 END
        );
        v_total := v_total + 1;
      END IF;
    END LOOP;
  END LOOP;

  RETURN v_total;
END;
$$;

GRANT EXECUTE ON FUNCTION public.notify_probation_expiry() TO service_role;
