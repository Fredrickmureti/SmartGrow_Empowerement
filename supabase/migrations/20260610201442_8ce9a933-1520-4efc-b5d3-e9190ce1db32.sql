
-- =====================================================================
-- Wave G1 — Retrofit payroll immutability guards with the canonical
-- governance teardown bypass (ADR 0019).
--
-- Each guard short-circuits when public._is_teardown_for_org(org) is
-- true (set txn-local by reset_organization_data /
-- platform_delete_organization). Business-time semantics are unchanged.
-- =====================================================================

-- ---------- 1. payslips_immutability_guard ---------------------------
CREATE OR REPLACE FUNCTION public.payslips_immutability_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_stack        text;
  v_run_status   text;
  v_run_id       uuid;
  v_batch_bypass boolean;
  v_org          uuid;
BEGIN
  -- Governance plane: privileged teardown deletes frozen rows.
  v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  IF v_org IS NOT NULL AND public._is_teardown_for_org(v_org) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  -- Reversal / reclassification RPCs are the only writers allowed to
  -- mutate a frozen payslip's financial state.
  GET DIAGNOSTICS v_stack = PG_CONTEXT;
  IF v_stack ~* 'payroll_reverse_run_atomic|payroll_reclassify_run' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_run_id := COALESCE(OLD.payroll_run_id, NEW.payroll_run_id);
  SELECT status INTO v_run_status FROM public.payroll_runs WHERE id = v_run_id;

  IF v_run_status IS NULL OR v_run_status NOT IN ('posted','paid','reversed') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Payslip on a % payroll run cannot be deleted. Use the reversal flow.', v_run_status
      USING ERRCODE = '42501', HINT = 'payslip_immutable';
  END IF;

  v_batch_bypass := COALESCE(current_setting('app.payroll_payment_via_batch', true),'') = 'on';

  IF v_batch_bypass THEN
    IF NEW.basic_salary          IS DISTINCT FROM OLD.basic_salary
    OR NEW.gross_pay             IS DISTINCT FROM OLD.gross_pay
    OR NEW.net_pay               IS DISTINCT FROM OLD.net_pay
    OR NEW.taxable_income        IS DISTINCT FROM OLD.taxable_income
    OR NEW.total_deductions      IS DISTINCT FROM OLD.total_deductions
    OR NEW.other_earnings        IS DISTINCT FROM OLD.other_earnings
    OR NEW.other_deductions      IS DISTINCT FROM OLD.other_deductions
    OR NEW.deductions_detail     IS DISTINCT FROM OLD.deductions_detail
    OR NEW.contributions_detail  IS DISTINCT FROM OLD.contributions_detail
    OR NEW.unpaid_leave_days     IS DISTINCT FROM OLD.unpaid_leave_days
    OR NEW.leave_deduction       IS DISTINCT FROM OLD.leave_deduction
    OR NEW.employee_id           IS DISTINCT FROM OLD.employee_id
    OR NEW.payroll_run_id        IS DISTINCT FROM OLD.payroll_run_id
    OR NEW.organization_id       IS DISTINCT FROM OLD.organization_id
    OR NEW.business_id           IS DISTINCT FROM OLD.business_id
    OR NEW.branch_id             IS DISTINCT FROM OLD.branch_id
    OR NEW.payslip_number        IS DISTINCT FROM OLD.payslip_number
    OR NEW.rule_set_id           IS DISTINCT FROM OLD.rule_set_id
    OR NEW.rule_set_version      IS DISTINCT FROM OLD.rule_set_version
    OR NEW.rule_set_hash         IS DISTINCT FROM OLD.rule_set_hash
    THEN
      RAISE EXCEPTION
        'Payslip on a % payroll run cannot be edited via the payment-batch path. Only payment-confirmation columns (status, paid_at, payment_reference) may change.', v_run_status
        USING ERRCODE = '42501', HINT = 'payslip_immutable';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Payslip on a % payroll run is immutable. Use a reversal/correction run instead.', v_run_status
    USING ERRCODE = '42501', HINT = 'payslip_immutable';
END;
$function$;

-- ---------- 2. payslip_lines_immutability_guard ----------------------
CREATE OR REPLACE FUNCTION public.payslip_lines_immutability_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_stack      text;
  v_run_status text;
  v_payslip    uuid := COALESCE(OLD.payslip_id, NEW.payslip_id);
  v_org        uuid;
BEGIN
  -- Governance plane: privileged teardown deletes frozen rows.
  v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  IF v_org IS NOT NULL AND public._is_teardown_for_org(v_org) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  GET DIAGNOSTICS v_stack = PG_CONTEXT;
  IF v_stack ~* 'payroll_reverse_run_atomic|payroll_reclassify_run' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT r.status INTO v_run_status
  FROM public.payslips p
  JOIN public.payroll_runs r ON r.id = p.payroll_run_id
  WHERE p.id = v_payslip;

  IF v_run_status IS NULL OR v_run_status NOT IN ('posted','paid','reversed') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION
    'Payslip line on a % payroll run is immutable. Use a reversal/correction run instead.', v_run_status
    USING ERRCODE = '42501', HINT = 'payslip_line_immutable';
END;
$function$;

-- ---------- 3. payroll_runs_immutability_guard -----------------------
CREATE OR REPLACE FUNCTION public.payroll_runs_immutability_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_stack text;
  v_org   uuid;
BEGIN
  -- Governance plane: privileged teardown deletes frozen rows.
  v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  IF v_org IS NOT NULL AND public._is_teardown_for_org(v_org) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF COALESCE(OLD.status,'') NOT IN ('posted','paid','reversed') THEN
    RETURN NEW;
  END IF;

  GET DIAGNOSTICS v_stack = PG_CONTEXT;
  IF v_stack ~* 'payroll_reverse_run_atomic|payroll_reclassify_run' THEN
    RETURN NEW;
  END IF;

  IF NEW.total_gross                  IS DISTINCT FROM OLD.total_gross
  OR NEW.total_other_deductions       IS DISTINCT FROM OLD.total_other_deductions
  OR NEW.total_employer_contributions IS DISTINCT FROM OLD.total_employer_contributions
  OR NEW.total_net                    IS DISTINCT FROM OLD.total_net
  OR NEW.employee_count               IS DISTINCT FROM OLD.employee_count
  OR NEW.pay_period_start             IS DISTINCT FROM OLD.pay_period_start
  OR NEW.pay_period_end               IS DISTINCT FROM OLD.pay_period_end
  OR NEW.run_type                     IS DISTINCT FROM OLD.run_type
  OR NEW.organization_id              IS DISTINCT FROM OLD.organization_id
  OR NEW.business_id                  IS DISTINCT FROM OLD.business_id
  THEN
    RAISE EXCEPTION
      'Payroll run % is % and its financial fields are immutable. Use a reversal or correction run instead.',
      OLD.payroll_number, OLD.status
      USING ERRCODE = '42501', HINT = 'payroll_run_immutable';
  END IF;

  RETURN NEW;
END;
$function$;

-- ---------- 4. payroll_runs_paid_path_guard --------------------------
CREATE OR REPLACE FUNCTION public.payroll_runs_paid_path_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid;
BEGIN
  -- Governance plane: privileged teardown is allowed.
  v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  IF v_org IS NOT NULL AND public._is_teardown_for_org(v_org) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP = 'UPDATE'
     AND COALESCE(OLD.status,'') = 'reversed'
     AND COALESCE(NEW.status,'') <> 'reversed' THEN
    RAISE EXCEPTION 'Cannot move a reversed payroll run back to %', NEW.status
      USING ERRCODE = '42501', HINT = 'payroll_reversed_terminal';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.status = 'paid' THEN
    IF COALESCE(NEW.is_reversal, false) = true THEN
      RETURN NEW;
    END IF;
    IF auth.role() = 'service_role'
       OR COALESCE(current_setting('app.payroll_payment_via_batch', true), '') = 'on' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'Payroll runs can only be marked paid via the payment-batch posting path (post-payroll-payment-gl) or via an atomic reversal.'
      USING ERRCODE = '42501', HINT = 'payroll_paid_bypass_blocked';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status = 'paid' AND COALESCE(OLD.status,'') <> 'paid' THEN
    IF auth.role() = 'service_role'
       OR COALESCE(current_setting('app.payroll_payment_via_batch', true), '') = 'on' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'Payroll runs can only be marked paid via the payment-batch posting path (post-payroll-payment-gl). Direct status updates are forbidden.'
      USING ERRCODE = '42501', HINT = 'payroll_paid_bypass_blocked';
  END IF;

  RETURN NEW;
END;
$function$;

-- ---------- 5. payslips_paid_path_guard ------------------------------
CREATE OR REPLACE FUNCTION public.payslips_paid_path_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid;
BEGIN
  -- Governance plane: privileged teardown is allowed.
  v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  IF v_org IS NOT NULL AND public._is_teardown_for_org(v_org) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF NEW.status = 'paid' AND COALESCE(OLD.status,'') <> 'paid' THEN
    IF auth.role() = 'service_role'
       OR COALESCE(current_setting('app.payroll_payment_via_batch', true), '') = 'on' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'Payslips can only be marked paid via the payment-batch posting path (post-payroll-payment-gl). Direct status updates are forbidden.'
      USING ERRCODE = '42501', HINT = 'payroll_paid_bypass_blocked';
  END IF;
  RETURN NEW;
END;
$function$;

-- ---------- 6. payroll_remittances_read_only_guard -------------------
-- This guard is the most dangerous one: it unconditionally raises on
-- every UPDATE/DELETE, which is what blocks reset_module__payroll's
-- DELETE FROM payroll_remittances. Add the canonical bypass.
CREATE OR REPLACE FUNCTION public.payroll_remittances_read_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid;
BEGIN
  -- Governance plane: privileged teardown deletes frozen rows.
  v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  IF v_org IS NOT NULL AND public._is_teardown_for_org(v_org) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  RAISE EXCEPTION 'read_only_mirror: payroll_remittances is frozen; use payroll_liabilities + post-remittance-payment edge function. Reads continue via v_payroll_remittances_compat.'
    USING ERRCODE = 'P0001';
END;
$function$;
