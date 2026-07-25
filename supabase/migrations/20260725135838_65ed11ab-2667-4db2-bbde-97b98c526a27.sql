DROP TRIGGER IF EXISTS trg_a_loan_types_normalize_skip_policy ON public.loan_types;
DROP FUNCTION IF EXISTS public.tg_loan_types_normalize_skip_policy();

CREATE OR REPLACE FUNCTION public.loan_types_validate_policy_bounds()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.min_installments IS NOT NULL AND NEW.min_installments < 1 THEN
    RAISE EXCEPTION 'min_installments must be >= 1 (got %)', NEW.min_installments
      USING ERRCODE = 'check_violation', HINT = 'LOAN_POLICY_MIN_INSTALLMENTS';
  END IF;
  IF NEW.max_installments IS NOT NULL AND NEW.max_installments < 1 THEN
    RAISE EXCEPTION 'max_installments must be >= 1 (got %)', NEW.max_installments
      USING ERRCODE = 'check_violation', HINT = 'LOAN_POLICY_MAX_INSTALLMENTS';
  END IF;
  IF NEW.min_installments IS NOT NULL AND NEW.max_installments IS NOT NULL
     AND NEW.min_installments > NEW.max_installments THEN
    RAISE EXCEPTION 'min_installments (%) must be <= max_installments (%)',
      NEW.min_installments, NEW.max_installments
      USING ERRCODE = 'check_violation', HINT = 'LOAN_POLICY_INSTALLMENT_RANGE';
  END IF;

  IF NEW.min_principal IS NOT NULL AND NEW.min_principal < 0 THEN
    RAISE EXCEPTION 'min_principal must be >= 0 (got %)', NEW.min_principal
      USING ERRCODE = 'check_violation', HINT = 'LOAN_POLICY_MIN_PRINCIPAL';
  END IF;
  IF NEW.max_principal IS NOT NULL AND NEW.max_principal < 0 THEN
    RAISE EXCEPTION 'max_principal must be >= 0 (got %)', NEW.max_principal
      USING ERRCODE = 'check_violation', HINT = 'LOAN_POLICY_MAX_PRINCIPAL';
  END IF;
  IF NEW.min_principal IS NOT NULL AND NEW.max_principal IS NOT NULL
     AND NEW.min_principal > NEW.max_principal THEN
    RAISE EXCEPTION 'min_principal (%) must be <= max_principal (%)',
      NEW.min_principal, NEW.max_principal
      USING ERRCODE = 'check_violation', HINT = 'LOAN_POLICY_PRINCIPAL_RANGE';
  END IF;

  IF NEW.min_tenure_months IS NOT NULL AND NEW.min_tenure_months < 1 THEN
    RAISE EXCEPTION 'min_tenure_months must be >= 1 (got %)', NEW.min_tenure_months
      USING ERRCODE = 'check_violation', HINT = 'LOAN_POLICY_MIN_TENURE';
  END IF;
  IF NEW.max_tenure_months IS NOT NULL AND NEW.max_tenure_months < 1 THEN
    RAISE EXCEPTION 'max_tenure_months must be >= 1 (got %)', NEW.max_tenure_months
      USING ERRCODE = 'check_violation', HINT = 'LOAN_POLICY_MAX_TENURE';
  END IF;
  IF NEW.min_tenure_months IS NOT NULL AND NEW.max_tenure_months IS NOT NULL
     AND NEW.min_tenure_months > NEW.max_tenure_months THEN
    RAISE EXCEPTION 'min_tenure_months (%) must be <= max_tenure_months (%)',
      NEW.min_tenure_months, NEW.max_tenure_months
      USING ERRCODE = 'check_violation', HINT = 'LOAN_POLICY_TENURE_RANGE';
  END IF;

  IF NEW.default_max_pct_of_net IS NOT NULL
     AND (NEW.default_max_pct_of_net < 0 OR NEW.default_max_pct_of_net > 100) THEN
    RAISE EXCEPTION 'default_max_pct_of_net must be between 0 and 100 (got %)',
      NEW.default_max_pct_of_net
      USING ERRCODE = 'check_violation', HINT = 'LOAN_POLICY_MAX_PCT_OF_NET';
  END IF;
  IF NEW.default_min_net_pay_floor IS NOT NULL AND NEW.default_min_net_pay_floor < 0 THEN
    RAISE EXCEPTION 'default_min_net_pay_floor must be >= 0 (got %)',
      NEW.default_min_net_pay_floor
      USING ERRCODE = 'check_violation', HINT = 'LOAN_POLICY_NET_PAY_FLOOR';
  END IF;

  IF NEW.deduction_priority IS NOT NULL
     AND (NEW.deduction_priority < 1 OR NEW.deduction_priority > 10000) THEN
    RAISE EXCEPTION 'deduction_priority must be between 1 and 10000 (got %)',
      NEW.deduction_priority
      USING ERRCODE = 'check_violation', HINT = 'LOAN_POLICY_DEDUCTION_PRIORITY';
  END IF;

  IF NEW.salary_rule_code IS NOT NULL
     AND NEW.salary_rule_code !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION
      'salary_rule_code must be snake_case ([a-z][a-z0-9_]{0,63}); got %',
      NEW.salary_rule_code
      USING ERRCODE = 'check_violation', HINT = 'LOAN_POLICY_SALARY_RULE_CODE';
  END IF;

  -- Skip policy: caps are meaningless when skipping is disabled. Normalise
  -- rather than raise, so unrelated edits never fail on hidden fields.
  IF NOT COALESCE(NEW.allow_skip, false) THEN
    NEW.max_skips_per_loan := NULL;
    NEW.max_skips_per_calendar_year := NULL;
    NEW.min_gap_between_skips_days := 0;
  END IF;
  IF NEW.max_skips_per_loan IS NOT NULL AND NEW.max_skips_per_loan < 0 THEN
    RAISE EXCEPTION 'max_skips_per_loan must be >= 0'
      USING ERRCODE = 'check_violation', HINT = 'LOAN_POLICY_MAX_SKIPS_PER_LOAN';
  END IF;
  IF NEW.max_skips_per_calendar_year IS NOT NULL AND NEW.max_skips_per_calendar_year < 0 THEN
    RAISE EXCEPTION 'max_skips_per_calendar_year must be >= 0'
      USING ERRCODE = 'check_violation', HINT = 'LOAN_POLICY_MAX_SKIPS_PER_YEAR';
  END IF;
  IF NEW.min_gap_between_skips_days IS NOT NULL AND NEW.min_gap_between_skips_days < 0 THEN
    RAISE EXCEPTION 'min_gap_between_skips_days must be >= 0'
      USING ERRCODE = 'check_violation', HINT = 'LOAN_POLICY_SKIP_GAP';
  END IF;

  IF NEW.default_repayment_method NOT IN
     ('fixed_installment','fixed_amount','percent_of_net','one_off_next_payroll') THEN
    RAISE EXCEPTION 'invalid default_repayment_method: %', NEW.default_repayment_method
      USING ERRCODE = 'check_violation', HINT = 'LOAN_POLICY_REPAYMENT_METHOD';
  END IF;
  IF NEW.interest_method NOT IN ('flat','reducing_balance','none') THEN
    RAISE EXCEPTION 'invalid interest_method: %', NEW.interest_method
      USING ERRCODE = 'check_violation', HINT = 'LOAN_POLICY_INTEREST_METHOD';
  END IF;
  IF NEW.interest_treatment_on_skip NOT IN ('accrue','waive','capitalise') THEN
    RAISE EXCEPTION 'invalid interest_treatment_on_skip: %', NEW.interest_treatment_on_skip
      USING ERRCODE = 'check_violation', HINT = 'LOAN_POLICY_SKIP_INTEREST';
  END IF;
  IF NEW.schedule_adjustment_on_skip NOT IN ('push_end','rebalance','shorten') THEN
    RAISE EXCEPTION 'invalid schedule_adjustment_on_skip: %', NEW.schedule_adjustment_on_skip
      USING ERRCODE = 'check_violation', HINT = 'LOAN_POLICY_SKIP_SCHEDULE';
  END IF;

  RETURN NEW;
END $$;

DROP FUNCTION IF EXISTS public._loan_ensure_account(uuid, uuid, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.ensure_loan_gl_accounts(_org uuid, _biz uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_recv uuid; v_clear uuid; v_int uuid; v_wo uuid;
BEGIN
  IF _org IS NULL OR _biz IS NULL THEN RETURN '{}'::jsonb; END IF;

  v_recv := public.upsert_system_account(
    _org, _biz, 'loan_receivable', 'asset', 'employee_advances', '1360',
    'Employee Loans Receivable',
    'Outstanding principal owed by employees on staff loans and advances.', NULL, false);
  v_clear := public.upsert_system_account(
    _org, _biz, 'loan_disbursement_clearing', 'asset', 'other_current_asset', '1365',
    'Loan Disbursement Clearing',
    'Clearing account credited when a loan is granted and cleared when the funds leave the bank.', NULL, false);
  v_int := public.upsert_system_account(
    _org, _biz, 'loan_interest_income', 'income', 'interest_income', '4310',
    'Loan Interest Income',
    'Interest accrued on interest-bearing employee loans.', NULL, false);
  v_wo := public.upsert_system_account(
    _org, _biz, 'loan_writeoff_expense', 'expense', 'bad_debt_expense', '6420',
    'Loan Write-off Expense',
    'Irrecoverable employee loan balances written off.', NULL, false);

  INSERT INTO public.default_account_settings
    (organization_id, business_id, setting_key, account_id, source)
  VALUES
    (_org,_biz,'loan_receivable',v_recv,'system_seed'),
    (_org,_biz,'loan_disbursement_clearing',v_clear,'system_seed'),
    (_org,_biz,'loan_interest_income',v_int,'system_seed'),
    (_org,_biz,'loan_writeoff_expense',v_wo,'system_seed')
  ON CONFLICT (organization_id, business_id, branch_id, setting_key) DO NOTHING;

  UPDATE public.loan_types lt
     SET gl_receivable_account_id            = COALESCE(lt.gl_receivable_account_id, v_recv),
         gl_disbursement_clearing_account_id = COALESCE(lt.gl_disbursement_clearing_account_id, v_clear),
         interest_income_account_id          = COALESCE(lt.interest_income_account_id, v_int),
         writeoff_account_id                 = COALESCE(lt.writeoff_account_id, v_wo)
   WHERE lt.organization_id = _org
     AND (lt.business_id = _biz OR lt.business_id IS NULL)
     AND (lt.gl_receivable_account_id IS NULL
       OR lt.gl_disbursement_clearing_account_id IS NULL
       OR lt.interest_income_account_id IS NULL
       OR lt.writeoff_account_id IS NULL);

  RETURN jsonb_build_object(
    'loan_receivable', v_recv,
    'loan_disbursement_clearing', v_clear,
    'loan_interest_income', v_int,
    'loan_writeoff_expense', v_wo
  );
END $$;

GRANT EXECUTE ON FUNCTION public.ensure_loan_gl_accounts(uuid, uuid) TO authenticated, service_role;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT organization_id, id FROM public.businesses LOOP
    PERFORM public.ensure_loan_gl_accounts(r.organization_id, r.id);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.tg_business_ensure_loan_accounts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM public.ensure_loan_gl_accounts(NEW.organization_id, NEW.id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_business_ensure_loan_accounts ON public.businesses;
CREATE TRIGGER trg_business_ensure_loan_accounts
AFTER INSERT ON public.businesses
FOR EACH ROW EXECUTE FUNCTION public.tg_business_ensure_loan_accounts();

CREATE OR REPLACE FUNCTION public.seed_default_loan_types(_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE b record;
BEGIN
  INSERT INTO public.loan_types
    (organization_id, code, name, kind, description, requires_interest, requires_schedule, requires_approval,
     default_repayment_method, default_installments, default_max_pct_of_net)
  VALUES
    (_org_id,'LOAN','Employee Loan','loan','Standard repayable loan with installment schedule.',true,true,true,'fixed_installment',12,33),
    (_org_id,'SAL_ADV','Salary Advance','salary_advance','Short-term advance recovered from the next payroll.',false,false,true,'one_off_next_payroll',1,50),
    (_org_id,'EMERGENCY','Emergency Loan','emergency','Fast-track loan for emergencies, optional interest.',false,true,true,'fixed_installment',6,25),
    (_org_id,'ASSET','Asset Loan','asset','Loan for company-purchased assets.',true,true,true,'fixed_installment',24,25)
  ON CONFLICT DO NOTHING;

  FOR b IN SELECT id FROM public.businesses WHERE organization_id = _org_id LOOP
    PERFORM public.ensure_loan_gl_accounts(_org_id, b.id);
  END LOOP;
END $$;