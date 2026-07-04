-- Phase A — Loan Types policy engine: schema hygiene
-- Non-destructive: adds server-side validation + audit; marks duplicate/orphan
-- columns as deprecated (drops deferred to a later migration once code migrates).

-- ─────────────────────────────────────────────────────────────
-- 1. Validation trigger: policy bounds must be internally consistent.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.loan_types_validate_policy_bounds()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- installments: min ≤ max, both positive
  IF NEW.min_installments IS NOT NULL AND NEW.min_installments < 1 THEN
    RAISE EXCEPTION 'min_installments must be >= 1 (got %)', NEW.min_installments
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.max_installments IS NOT NULL AND NEW.max_installments < 1 THEN
    RAISE EXCEPTION 'max_installments must be >= 1 (got %)', NEW.max_installments
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.min_installments IS NOT NULL AND NEW.max_installments IS NOT NULL
     AND NEW.min_installments > NEW.max_installments THEN
    RAISE EXCEPTION 'min_installments (%) must be <= max_installments (%)',
      NEW.min_installments, NEW.max_installments
      USING ERRCODE = 'check_violation';
  END IF;

  -- principal: min ≤ max, non-negative
  IF NEW.min_principal IS NOT NULL AND NEW.min_principal < 0 THEN
    RAISE EXCEPTION 'min_principal must be >= 0 (got %)', NEW.min_principal
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.max_principal IS NOT NULL AND NEW.max_principal < 0 THEN
    RAISE EXCEPTION 'max_principal must be >= 0 (got %)', NEW.max_principal
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.min_principal IS NOT NULL AND NEW.max_principal IS NOT NULL
     AND NEW.min_principal > NEW.max_principal THEN
    RAISE EXCEPTION 'min_principal (%) must be <= max_principal (%)',
      NEW.min_principal, NEW.max_principal
      USING ERRCODE = 'check_violation';
  END IF;

  -- tenure: min ≤ max, positive
  IF NEW.min_tenure_months IS NOT NULL AND NEW.min_tenure_months < 1 THEN
    RAISE EXCEPTION 'min_tenure_months must be >= 1 (got %)', NEW.min_tenure_months
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.max_tenure_months IS NOT NULL AND NEW.max_tenure_months < 1 THEN
    RAISE EXCEPTION 'max_tenure_months must be >= 1 (got %)', NEW.max_tenure_months
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.min_tenure_months IS NOT NULL AND NEW.max_tenure_months IS NOT NULL
     AND NEW.min_tenure_months > NEW.max_tenure_months THEN
    RAISE EXCEPTION 'min_tenure_months (%) must be <= max_tenure_months (%)',
      NEW.min_tenure_months, NEW.max_tenure_months
      USING ERRCODE = 'check_violation';
  END IF;

  -- net-pay cap and floor
  IF NEW.default_max_pct_of_net IS NOT NULL
     AND (NEW.default_max_pct_of_net < 0 OR NEW.default_max_pct_of_net > 100) THEN
    RAISE EXCEPTION 'default_max_pct_of_net must be between 0 and 100 (got %)',
      NEW.default_max_pct_of_net
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.default_min_net_pay_floor IS NOT NULL AND NEW.default_min_net_pay_floor < 0 THEN
    RAISE EXCEPTION 'default_min_net_pay_floor must be >= 0 (got %)',
      NEW.default_min_net_pay_floor
      USING ERRCODE = 'check_violation';
  END IF;

  -- deduction priority sane range (1..10000)
  IF NEW.deduction_priority IS NOT NULL
     AND (NEW.deduction_priority < 1 OR NEW.deduction_priority > 10000) THEN
    RAISE EXCEPTION 'deduction_priority must be between 1 and 10000 (got %)',
      NEW.deduction_priority
      USING ERRCODE = 'check_violation';
  END IF;

  -- salary_rule_code: snake_case identifier, ≤ 64 chars
  IF NEW.salary_rule_code IS NOT NULL
     AND NEW.salary_rule_code !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION
      'salary_rule_code must be snake_case ([a-z][a-z0-9_]{0,63}); got %',
      NEW.salary_rule_code
      USING ERRCODE = 'check_violation';
  END IF;

  -- skip policy: caps require allow_skip
  IF (NEW.max_skips_per_loan IS NOT NULL
        OR NEW.max_skips_per_calendar_year IS NOT NULL
        OR COALESCE(NEW.min_gap_between_skips_days, 0) > 0)
     AND NOT NEW.allow_skip THEN
    RAISE EXCEPTION 'skip caps configured but allow_skip is false'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.max_skips_per_loan IS NOT NULL AND NEW.max_skips_per_loan < 0 THEN
    RAISE EXCEPTION 'max_skips_per_loan must be >= 0'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.max_skips_per_calendar_year IS NOT NULL AND NEW.max_skips_per_calendar_year < 0 THEN
    RAISE EXCEPTION 'max_skips_per_calendar_year must be >= 0'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Enum guards (defence-in-depth alongside app-side types)
  IF NEW.default_repayment_method NOT IN
     ('fixed_installment','fixed_amount','percent_of_net','one_off_next_payroll') THEN
    RAISE EXCEPTION 'invalid default_repayment_method: %', NEW.default_repayment_method
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.interest_method NOT IN ('flat','reducing_balance','none') THEN
    RAISE EXCEPTION 'invalid interest_method: %', NEW.interest_method
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.interest_treatment_on_skip NOT IN ('accrue','waive','capitalise') THEN
    RAISE EXCEPTION 'invalid interest_treatment_on_skip: %', NEW.interest_treatment_on_skip
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.schedule_adjustment_on_skip NOT IN ('push_end','rebalance','shorten') THEN
    RAISE EXCEPTION 'invalid schedule_adjustment_on_skip: %', NEW.schedule_adjustment_on_skip
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS loan_types_validate_policy_bounds ON public.loan_types;
CREATE TRIGGER loan_types_validate_policy_bounds
BEFORE INSERT OR UPDATE ON public.loan_types
FOR EACH ROW EXECUTE FUNCTION public.loan_types_validate_policy_bounds();

-- ─────────────────────────────────────────────────────────────
-- 2. Audit trigger: every policy change lands in commercial_audit_logs.
--    Uses a defensive path so it does not fail if the target table
--    is not present in a stripped-down environment.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.loan_types_audit_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_action text := lower(TG_OP);
  v_entity_id uuid := COALESCE(NEW.id, OLD.id);
  v_org uuid := COALESCE(NEW.organization_id, OLD.organization_id);
  v_biz uuid := COALESCE(NEW.business_id, OLD.business_id);
  v_before jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  v_after  jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
BEGIN
  BEGIN
    INSERT INTO public.commercial_audit_logs
      (organization_id, business_id, actor_user_id, entity_type, entity_id,
       action, before_data, after_data)
    VALUES
      (v_org, v_biz, v_actor, 'loan_type', v_entity_id,
       v_action, v_before, v_after);
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    -- audit table not present / different shape: skip silently so policy
    -- edits are never blocked by an audit-infrastructure gap.
    NULL;
  END;
  RETURN COALESCE(NEW, OLD);
END
$$;

DROP TRIGGER IF EXISTS loan_types_audit_change ON public.loan_types;
CREATE TRIGGER loan_types_audit_change
AFTER INSERT OR UPDATE OR DELETE ON public.loan_types
FOR EACH ROW EXECUTE FUNCTION public.loan_types_audit_change();

-- ─────────────────────────────────────────────────────────────
-- 3. Column deprecation markers (drops deferred until UI + engines
--    migrate off in later phases).
-- ─────────────────────────────────────────────────────────────
COMMENT ON COLUMN public.loan_types.clearing_account_id IS
  'DEPRECATED — duplicate of gl_disbursement_clearing_account_id; not read by any engine. Will be dropped after Phase D.';
COMMENT ON COLUMN public.loan_types.max_exposure_pct_of_net IS
  'DEPRECATED — duplicate of default_max_pct_of_net; not read by any engine. Will be dropped after Phase F.';

COMMENT ON COLUMN public.loan_types.requires_approval IS
  'Enforced by request_employee_loan RPC (Phase B): opens approval_requests when true.';
COMMENT ON COLUMN public.loan_types.requires_dual_approval IS
  'Enforced by request_employee_loan RPC (Phase B): adds a second approval step when true.';
COMMENT ON COLUMN public.loan_types.deduction_priority IS
  'Consumed by compute-payroll (Phase C) to order loan deductions after statutory items.';
COMMENT ON COLUMN public.loan_types.default_min_net_pay_floor IS
  'Hard clamp applied in compute-payroll (Phase C); short-recovers to next period.';
COMMENT ON COLUMN public.loan_types.writeoff_account_id IS
  'Consumed by post-loan-settlement (Phase D) with fallback to default_account_settings.';
COMMENT ON COLUMN public.loan_types.interest_income_account_id IS
  'Consumed by post-loan-interest-accrual (Phase D) when requires_interest is true.';
COMMENT ON COLUMN public.loan_types.dual_control_writeoff IS
  'Enforced by post-loan-settlement (Phase D): refuses write-off without a second approver.';
COMMENT ON COLUMN public.loan_types.allow_skip IS
  'Enforced by enforce_loan_skip_policy RPC (Phase E); caps checked server-side.';
