-- migrate_components_to_rules_test.sql
--
-- Guards for the Phase 3 backfill RPC public.migrate_components_to_rules.
--
-- Contract asserted:
--   1. Given a structure with N active salary_components and NO existing
--      payroll_salary_rules, calling the RPC creates exactly N rules and
--      flips salary_structures.use_structure_engine to true.
--   2. A second call is a no-op: rules_created = 0, already_migrated = true,
--      flag_flipped = false, and the row count in payroll_salary_rules is
--      unchanged.
--   3. Fixed / percentage / formula computation_types map to the expected
--      amount_select values on payroll_salary_rules (fixed | percentage |
--      expression), and percentage_of survives into amount_base.
--
-- We stub public.user_has_module_permission for the duration of the
-- transaction so the RPC's authorization branch passes without needing
-- a real auth.uid() session. The stub is dropped by ROLLBACK.
BEGIN;
  -- Stub authorization: RPC uses SECURITY DEFINER and calls
  -- user_has_module_permission(auth.uid(), org, 'payroll', 'write').
  -- Replace with a permissive stub for this transaction only.
  CREATE OR REPLACE FUNCTION public.user_has_module_permission(
    _user_id uuid, _org uuid, _module text, _permission text
  ) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;

  DO $$
  DECLARE
    v_org uuid;
    v_biz uuid;
    v_structure uuid := gen_random_uuid();
    r_first RECORD;
    r_second RECORD;
    v_rule_count int;
    v_flag boolean;
    v_amount_select_fixed text;
    v_amount_select_pct text;
    v_amount_select_expr text;
    v_amount_base_pct text;
  BEGIN
    SELECT organization_id, id INTO v_org, v_biz FROM public.businesses LIMIT 1;
    IF v_biz IS NULL THEN
      RAISE NOTICE 'no business to test against; skipping';
      RETURN;
    END IF;

    -- Seed a fresh salary structure + three components (one per type).
    INSERT INTO public.salary_structures (id, organization_id, business_id, name, code, is_active)
    VALUES (v_structure, v_org, v_biz, 'PGTAP MIGRATE TEST', 'PGTAP-MIG', true);

    INSERT INTO public.salary_components
      (organization_id, business_id, structure_id, name, code, component_type,
       computation_type, computation_value, percentage_of, is_active, sort_order)
    VALUES
      (v_org, v_biz, v_structure, 'Basic Salary', 'BASIC', 'earning',
       'fixed', 50000, NULL, true, 1),
      (v_org, v_biz, v_structure, 'House Allowance', 'HRA', 'earning',
       'percentage', 15, 'BASIC', true, 2),
      (v_org, v_biz, v_structure, 'Custom Bonus', 'BONUS', 'earning',
       'formula', 0, 'BASIC * 0.05', true, 3);

    -- (1) First call: 3 rules created, flag flipped, not already_migrated.
    SELECT * INTO r_first FROM public.migrate_components_to_rules(v_structure);
    IF r_first.rules_created <> 3 THEN
      RAISE EXCEPTION 'expected 3 rules created, got %', r_first.rules_created;
    END IF;
    IF r_first.already_migrated THEN
      RAISE EXCEPTION 'first call incorrectly reported already_migrated=true';
    END IF;
    IF NOT r_first.flag_flipped THEN
      RAISE EXCEPTION 'first call did not flip use_structure_engine';
    END IF;

    SELECT use_structure_engine INTO v_flag
      FROM public.salary_structures WHERE id = v_structure;
    IF v_flag IS NOT TRUE THEN
      RAISE EXCEPTION 'use_structure_engine was not set true (got %)', v_flag;
    END IF;

    -- (3) Field-mapping assertions on the produced rules.
    SELECT amount_select INTO v_amount_select_fixed
      FROM public.payroll_salary_rules
      WHERE structure_id = v_structure AND code = 'BASIC';
    IF v_amount_select_fixed <> 'fixed' THEN
      RAISE EXCEPTION 'BASIC: expected amount_select=fixed, got %', v_amount_select_fixed;
    END IF;

    SELECT amount_select, amount_base INTO v_amount_select_pct, v_amount_base_pct
      FROM public.payroll_salary_rules
      WHERE structure_id = v_structure AND code = 'HRA';
    IF v_amount_select_pct <> 'percentage' THEN
      RAISE EXCEPTION 'HRA: expected amount_select=percentage, got %', v_amount_select_pct;
    END IF;
    IF v_amount_base_pct <> 'BASIC' THEN
      RAISE EXCEPTION 'HRA: expected amount_base=BASIC, got %', v_amount_base_pct;
    END IF;

    SELECT amount_select INTO v_amount_select_expr
      FROM public.payroll_salary_rules
      WHERE structure_id = v_structure AND code = 'BONUS';
    IF v_amount_select_expr <> 'expression' THEN
      RAISE EXCEPTION 'BONUS: expected amount_select=expression, got %', v_amount_select_expr;
    END IF;

    -- (2) Second call: idempotent.
    SELECT count(*) INTO v_rule_count
      FROM public.payroll_salary_rules WHERE structure_id = v_structure;

    SELECT * INTO r_second FROM public.migrate_components_to_rules(v_structure);
    IF r_second.rules_created <> 0 THEN
      RAISE EXCEPTION 'second call created % rules (expected 0)', r_second.rules_created;
    END IF;
    IF NOT r_second.already_migrated THEN
      RAISE EXCEPTION 'second call did not report already_migrated=true';
    END IF;
    IF r_second.flag_flipped THEN
      RAISE EXCEPTION 'second call incorrectly flipped use_structure_engine again';
    END IF;

    IF (SELECT count(*) FROM public.payroll_salary_rules WHERE structure_id = v_structure) <> v_rule_count THEN
      RAISE EXCEPTION 'second call mutated payroll_salary_rules row count';
    END IF;

    RAISE NOTICE 'migrate_components_to_rules pgTAP test OK';
  END $$;
ROLLBACK;
