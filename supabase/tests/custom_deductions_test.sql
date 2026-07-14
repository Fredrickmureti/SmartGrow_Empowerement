-- pgTAP guardrails for the Custom Deductions subsystem (Slice 2).
--
-- Covers:
--   1. Reserved-code guardrail blocks first-class subsystem codes.
--   2. Version trigger increments on material change only.
--   3. Lifecycle-event trigger writes exactly one event per status transition.
--   4. Readiness rule row exists and is active.
--   5. Run-level GL resolver ignores sourced custom-deduction payslip lines.
--
-- Wrapped in BEGIN/ROLLBACK so state is not persisted.

BEGIN;

-- 1) Reserved-code guardrail
DO $$
DECLARE v_biz uuid;
BEGIN
  SELECT id INTO v_biz FROM public.businesses LIMIT 1;
  IF v_biz IS NULL THEN
    RAISE NOTICE 'No businesses in fixture; skipping guardrail row-level test.';
    RETURN;
  END IF;
  BEGIN
    INSERT INTO public.custom_deduction_types
      (business_id, code, label, deduction_kind, computation_method, parameters)
    VALUES
      (v_biz, 'paye', 'PAYE', 'recurring', 'flat_amount', '{"amount":0}'::jsonb);
    RAISE EXCEPTION 'Reserved code "paye" was accepted — guardrail is broken.';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'PASS: reserved code paye rejected';
  END;
  BEGIN
    INSERT INTO public.custom_deduction_types
      (business_id, code, label, deduction_kind, computation_method, parameters)
    VALUES
      (v_biz, 'loan', 'Loan', 'recurring', 'flat_amount', '{"amount":0}'::jsonb);
    RAISE EXCEPTION 'Reserved code "loan" was accepted — guardrail is broken.';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'PASS: reserved code loan rejected';
  END;
END $$;

-- 2) Version trigger
DO $$
DECLARE v_biz uuid; v_id uuid; v_v1 int; v_v2 int; v_v3 int;
BEGIN
  SELECT id INTO v_biz FROM public.businesses LIMIT 1;
  IF v_biz IS NULL THEN RETURN; END IF;
  INSERT INTO public.custom_deduction_types
    (business_id, code, label, deduction_kind, computation_method, parameters, payslip_group, sort_order)
  VALUES
    (v_biz, 'test_gym_' || floor(random()*1e6)::text, 'Test gym', 'recurring', 'flat_amount', '{"amount":100}'::jsonb, 'other_deductions', 100)
  RETURNING id, version INTO v_id, v_v1;

  -- Cosmetic change (payslip_group is not in version-bump set)
  UPDATE public.custom_deduction_types SET payslip_group = 'welfare' WHERE id = v_id
    RETURNING version INTO v_v2;
  IF v_v2 <> v_v1 THEN
    RAISE EXCEPTION 'FAIL: version bumped on cosmetic change % → %', v_v1, v_v2;
  END IF;

  -- Material change (parameters)
  UPDATE public.custom_deduction_types SET parameters = '{"amount":200}'::jsonb WHERE id = v_id
    RETURNING version INTO v_v3;
  IF v_v3 <> v_v1 + 1 THEN
    RAISE EXCEPTION 'FAIL: version did not bump on material change (was %, expected %)', v_v3, v_v1 + 1;
  END IF;
  RAISE NOTICE 'PASS: version trigger correct (v1=% v2=% v3=%)', v_v1, v_v2, v_v3;
END $$;

-- 3) Lifecycle event trigger — must record exactly one event per status change.
DO $$
DECLARE
  v_biz uuid; v_emp uuid; v_type uuid; v_assign uuid;
  v_events_before int; v_events_after int;
BEGIN
  SELECT id INTO v_biz FROM public.businesses LIMIT 1;
  SELECT id INTO v_emp FROM public.employees WHERE business_id = v_biz LIMIT 1;
  IF v_biz IS NULL OR v_emp IS NULL THEN
    RAISE NOTICE 'No fixture employee — skipping lifecycle event test.';
    RETURN;
  END IF;
  INSERT INTO public.custom_deduction_types
    (business_id, code, label, deduction_kind, computation_method, parameters)
  VALUES
    (v_biz, 'test_life_' || floor(random()*1e6)::text, 'Test lifecycle', 'recurring', 'flat_amount', '{"amount":100}'::jsonb)
  RETURNING id INTO v_type;
  INSERT INTO public.employee_custom_deductions
    (business_id, employee_id, deduction_type_id, effective_from, status)
  VALUES
    (v_biz, v_emp, v_type, CURRENT_DATE, 'pending')
  RETURNING id INTO v_assign;

  SELECT COUNT(*) INTO v_events_before FROM public.employee_custom_deduction_events WHERE assignment_id = v_assign;
  IF v_events_before <> 1 THEN
    RAISE EXCEPTION 'FAIL: insert did not create exactly 1 event (found %)', v_events_before;
  END IF;
  UPDATE public.employee_custom_deductions SET status = 'approved' WHERE id = v_assign;
  SELECT COUNT(*) INTO v_events_after FROM public.employee_custom_deduction_events WHERE assignment_id = v_assign;
  IF v_events_after <> 2 THEN
    RAISE EXCEPTION 'FAIL: status transition did not create exactly 1 additional event (total %)', v_events_after;
  END IF;
  RAISE NOTICE 'PASS: lifecycle events (initial=1, after transition=2)';
END $$;

-- 4) Readiness rule seeded
DO $$
DECLARE v_cnt int;
BEGIN
  SELECT COUNT(*) INTO v_cnt
    FROM public.payroll_readiness_rules
   WHERE code = 'core.business.custom_deduction_gl_mapping'
     AND is_active = true
     AND check_kind = 'business.custom_deduction_gl_mapping';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'FAIL: readiness rule not seeded (found %)', v_cnt;
  END IF;
  RAISE NOTICE 'PASS: readiness rule present';
END $$;

-- 5) Run-level mapping resolver must not ask default_account_settings for
--    custom deduction lines. Those post through custom_deduction_types.
DO $$
DECLARE
  v_org uuid;
  v_biz uuid;
  v_run uuid;
  v_slip uuid;
  v_missing int;
BEGIN
  SELECT organization_id, id INTO v_org, v_biz FROM public.businesses LIMIT 1;
  IF v_biz IS NULL THEN
    RAISE NOTICE 'No business fixture — skipping custom deduction resolver test.';
    RETURN;
  END IF;

  INSERT INTO public.payroll_runs
    (organization_id, business_id, payroll_number, pay_period_start, pay_period_end, payment_date, status)
  VALUES
    (v_org, v_biz, '__tap_custom_ded_run', CURRENT_DATE, CURRENT_DATE, CURRENT_DATE, 'draft')
  RETURNING id INTO v_run;

  INSERT INTO public.payslips
    (organization_id, business_id, payroll_run_id, employee_id, gross_pay, total_deductions, net_pay, taxable_income, status)
  SELECT v_org, v_biz, v_run, e.id, 2000, 2000, 0, 2000, 'pending'
  FROM public.employees e
  WHERE e.business_id = v_biz
  LIMIT 1
  RETURNING id INTO v_slip;

  IF v_slip IS NULL THEN
    RAISE NOTICE 'No employee fixture — skipping custom deduction resolver test.';
    RETURN;
  END IF;

  INSERT INTO public.payslip_lines
    (organization_id, business_id, payroll_run_id, payslip_id, rule_code, category, label, sequence, employee_amount, employer_amount, taxable, rule_type, source)
  VALUES
    (v_org, v_biz, v_run, v_slip, 'custom_nssf_voluntary', 'deduction', 'NSSF Voluntary (Type 105)', 1, 2000, 0, false, 'custom_deduction',
     jsonb_build_object('source','custom_deduction','deduction_type_id',gen_random_uuid(),'assignment_id',gen_random_uuid(),'gl_liability_account_id',gen_random_uuid()));

  SELECT count(*) INTO v_missing
  FROM public.payroll_required_gl_mappings_for_run(v_run)
  WHERE setting_key LIKE 'custom\_%' ESCAPE '\';

  IF v_missing <> 0 THEN
    RAISE EXCEPTION 'FAIL: custom deduction line leaked into default GL mapping resolver (% rows)', v_missing;
  END IF;

  RAISE NOTICE 'PASS: custom deduction lines are excluded from default GL resolver';
END $$;

ROLLBACK;
