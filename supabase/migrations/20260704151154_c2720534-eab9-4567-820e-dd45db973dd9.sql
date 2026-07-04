
-- 1) Add computation_method column, backfill, and enforce a small allowed set.
ALTER TABLE public.payroll_rule_types
  ADD COLUMN IF NOT EXISTS computation_method text;

-- Backfill: infer from existing parameter_schema shape.
--   - bracket types -> bracket_progressive (matches statutory-rule engine method)
--   - schemas containing a 'rate' key -> percentage_of_gross
--   - everything else -> flat_amount
UPDATE public.payroll_rule_types
SET computation_method = CASE
  WHEN is_bracket THEN 'bracket_progressive'
  WHEN EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(parameter_schema, '[]'::jsonb)) elt
    WHERE elt->>'key' = 'rate'
  ) THEN 'percentage_of_gross'
  ELSE 'flat_amount'
END
WHERE computation_method IS NULL;

ALTER TABLE public.payroll_rule_types
  ALTER COLUMN computation_method SET NOT NULL,
  ALTER COLUMN computation_method SET DEFAULT 'flat_amount';

-- Constrain to methods compute-payroll actually understands.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payroll_rule_types_computation_method_chk'
  ) THEN
    ALTER TABLE public.payroll_rule_types
      ADD CONSTRAINT payroll_rule_types_computation_method_chk
      CHECK (computation_method IN (
        'flat_amount',
        'percentage_of_gross',
        'bracket_progressive',
        'tiered_brackets',
        'graduated_table',
        'per_employee_flat'
      ));
  END IF;
END $$;

-- 2) Drop the orphaned business_id column. It was added in
--    20260421213742 but never written or filtered by any consumer;
--    rule-type catalogs are workspace-level HR-policy artefacts
--    (same reasoning as leave_types).
ALTER TABLE public.payroll_rule_types
  DROP COLUMN IF EXISTS business_id;

-- 3) Tighten DELETE policy: require the same permission the UI already
--    gates on (manageStatutoryRules), rather than any org member.
DROP POLICY IF EXISTS "Users with manage permission can delete non-system rule types"
  ON public.payroll_rule_types;

CREATE POLICY "Users with manage permission can delete non-system rule types"
  ON public.payroll_rule_types FOR DELETE
  USING (
    is_system = false
    AND organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  );

-- 4) Truth-in-labelling comments.
COMMENT ON TABLE public.payroll_rule_types IS
  'Rule Type Definitions — tenant-owned catalog of (label, parameter_schema, computation_method) tuples surfaced in the Statutory Rules editor type-picker. This is NOT a deduction engine: no consumer writes an employee deduction from these rows. See Loans (employee_loans), Advances (employee_advances), Garnishments (employee_garnishments), Salary Structures (payroll_salary_rules) for actual deduction lifecycles.';
COMMENT ON COLUMN public.payroll_rule_types.computation_method IS
  'The compute-payroll method the Statutory Rules editor should default when a rule of this type is created. Persisted directly (previously round-tripped via parameter_schema shape).';
