-- Guard for the Rule Type Definitions (`payroll_rule_types`) invariants
-- locked in by Slice 1 of the Custom Deduction Types audit.
--
-- Business invariants:
--   1. `computation_method` exists, is NOT NULL, and is constrained to
--      the set of methods `compute-payroll` can actually dispatch.
--   2. The orphaned `business_id` column is gone (rule-type catalogs are
--      workspace-level, matching `leave_types`).
--   3. No foreign key targets `payroll_rule_types` — its `code` is a
--      soft label copied into `payroll_statutory_rules.rule_type`, not a
--      hard reference. If this ever changes we want to know about it in
--      a review (fix Slice 1's Slice 2 sketch first).
--   4. RLS is enabled and there is exactly one DELETE policy — the
--      system-row protection guard.

BEGIN;

-- 1) computation_method column shape
DO $$
DECLARE v_notnull boolean; v_default text;
BEGIN
  SELECT attnotnull, pg_get_expr(adbin, adrelid)
    INTO v_notnull, v_default
  FROM pg_attribute a
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = 'public.payroll_rule_types'::regclass
    AND a.attname = 'computation_method';

  IF v_notnull IS NULL THEN
    RAISE EXCEPTION 'payroll_rule_types.computation_method is missing';
  END IF;
  IF NOT v_notnull THEN
    RAISE EXCEPTION 'payroll_rule_types.computation_method must be NOT NULL';
  END IF;
END $$;

DO $$
DECLARE
  v_check text;
  v_method text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_check
  FROM pg_constraint c
  WHERE c.conrelid = 'public.payroll_rule_types'::regclass
    AND c.conname  = 'payroll_rule_types_computation_method_chk';

  IF v_check IS NULL THEN
    RAISE EXCEPTION 'payroll_rule_types_computation_method_chk is missing';
  END IF;
  FOREACH v_method IN ARRAY ARRAY[
    'flat_amount','percentage_of_gross','bracket_progressive',
    'tiered_brackets','graduated_table','per_employee_flat'
  ] LOOP
    IF position(quote_literal(v_method) IN v_check) = 0 THEN
      RAISE EXCEPTION 'CHECK % missing allowed method %', v_check, v_method;
    END IF;
  END LOOP;
END $$;

-- 2) business_id column must be gone
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.payroll_rule_types'::regclass
      AND attname  = 'business_id'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'payroll_rule_types.business_id column resurrected — this is a workspace-level catalog';
  END IF;
END $$;

-- 3) No inbound foreign keys
DO $$
DECLARE v_count int; v_names text;
BEGIN
  SELECT count(*), string_agg(conrelid::regclass::text || '.' || conname, ', ')
    INTO v_count, v_names
  FROM pg_constraint
  WHERE contype = 'f'
    AND confrelid = 'public.payroll_rule_types'::regclass;

  IF v_count > 0 THEN
    RAISE EXCEPTION 'unexpected FK(s) targeting payroll_rule_types: %', v_names;
  END IF;
END $$;

-- 4) RLS enabled + system-row DELETE guard present
DO $$
DECLARE v_rls boolean; v_delete_policy_count int;
BEGIN
  SELECT relrowsecurity INTO v_rls
  FROM pg_class WHERE oid = 'public.payroll_rule_types'::regclass;
  IF NOT v_rls THEN
    RAISE EXCEPTION 'RLS must be enabled on payroll_rule_types';
  END IF;

  SELECT count(*) INTO v_delete_policy_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename  = 'payroll_rule_types'
    AND cmd        = 'DELETE';

  IF v_delete_policy_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one DELETE policy on payroll_rule_types, found %', v_delete_policy_count;
  END IF;
END $$;

ROLLBACK;
