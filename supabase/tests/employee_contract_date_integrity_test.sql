-- employee_contract_date_integrity_test.sql
-- Pins the new invariants installed by validate_employee_contract_dates +
-- validate_employee_dates_vs_contracts triggers.
BEGIN;
  DO $$
  DECLARE
    v_org uuid; v_biz uuid; v_emp uuid;
    v_caught boolean;
  BEGIN
    SELECT organization_id, id INTO v_org, v_biz FROM public.businesses LIMIT 1;
    IF v_biz IS NULL THEN
      RAISE NOTICE 'no business; skipping date integrity test';
      RETURN;
    END IF;

    -- Seed a throwaway employee hired today
    INSERT INTO public.employees (
      organization_id, business_id, employee_number,
      first_name, last_name, hire_date, employment_type, is_active,
      basic_salary, housing_allowance, transport_allowance, other_allowances
    ) VALUES (
      v_org, v_biz, 'TEST-DATEINT-' || substr(gen_random_uuid()::text,1,8),
      'Date', 'Integrity', CURRENT_DATE, 'full_time', true,
      0, 0, 0, '{}'::jsonb
    ) RETURNING id INTO v_emp;

    -- (1) contract start before hire_date must fail
    v_caught := false;
    BEGIN
      INSERT INTO public.employee_contracts (
        organization_id, business_id, employee_id, contract_reference, name,
        start_date, end_date, status, wage, housing_allowance, transport_allowance,
        other_allowances, working_schedule
      ) VALUES (
        v_org, v_biz, v_emp, 'TEST-C1-' || substr(gen_random_uuid()::text,1,8), 'Bad early',
        CURRENT_DATE - INTERVAL '30 days', NULL, 'new', 1000, 0, 0, '{}'::jsonb, 'full_time'
      );
    EXCEPTION WHEN sqlstate 'P0001' THEN v_caught := true;
    END;
    IF NOT v_caught THEN RAISE EXCEPTION 'expected rejection: contract start before hire_date'; END IF;

    -- (2) end < start must fail
    v_caught := false;
    BEGIN
      INSERT INTO public.employee_contracts (
        organization_id, business_id, employee_id, contract_reference, name,
        start_date, end_date, status, wage, housing_allowance, transport_allowance,
        other_allowances, working_schedule
      ) VALUES (
        v_org, v_biz, v_emp, 'TEST-C2-' || substr(gen_random_uuid()::text,1,8), 'Bad order',
        CURRENT_DATE + 10, CURRENT_DATE + 1, 'new', 1000, 0, 0, '{}'::jsonb, 'full_time'
      );
    EXCEPTION WHEN sqlstate 'P0001' THEN v_caught := true;
    END;
    IF NOT v_caught THEN RAISE EXCEPTION 'expected rejection: end before start'; END IF;

    -- (3) overlap rejection
    INSERT INTO public.employee_contracts (
      organization_id, business_id, employee_id, contract_reference, name,
      start_date, end_date, status, wage, housing_allowance, transport_allowance,
      other_allowances, working_schedule
    ) VALUES (
      v_org, v_biz, v_emp, 'TEST-C3A-' || substr(gen_random_uuid()::text,1,8), 'Base',
      CURRENT_DATE, CURRENT_DATE + 60, 'new', 1000, 0, 0, '{}'::jsonb, 'full_time'
    );
    v_caught := false;
    BEGIN
      INSERT INTO public.employee_contracts (
        organization_id, business_id, employee_id, contract_reference, name,
        start_date, end_date, status, wage, housing_allowance, transport_allowance,
        other_allowances, working_schedule
      ) VALUES (
        v_org, v_biz, v_emp, 'TEST-C3B-' || substr(gen_random_uuid()::text,1,8), 'Overlap',
        CURRENT_DATE + 30, CURRENT_DATE + 90, 'new', 1000, 0, 0, '{}'::jsonb, 'full_time'
      );
    EXCEPTION WHEN sqlstate 'P0001' THEN v_caught := true;
    END;
    IF NOT v_caught THEN RAISE EXCEPTION 'expected rejection: overlapping new contract'; END IF;

    -- (4) moving hire_date past existing contract must fail
    v_caught := false;
    BEGIN
      UPDATE public.employees
         SET hire_date = CURRENT_DATE + 5
       WHERE id = v_emp;
    EXCEPTION WHEN sqlstate 'P0001' THEN v_caught := true;
    END;
    IF NOT v_caught THEN RAISE EXCEPTION 'expected rejection: hire_date moved past contract start'; END IF;
  END $$;
ROLLBACK;
