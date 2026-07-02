-- A1: Re-add taxable_income (generic, NOT country-specific)
ALTER TABLE public.payslips
  ADD COLUMN IF NOT EXISTS taxable_income numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.payslips.taxable_income IS
  'Generic income-tax base (gross pay minus statutory exemptions). Country-neutral; localization packs decide which exemptions apply.';

-- A2: Safe backfill — only rows still at the default
UPDATE public.payslips
   SET taxable_income = gross_pay
 WHERE taxable_income = 0 AND gross_pay IS NOT NULL;

-- B5: Repair rules with computation_method = 'unknown' when parameters carry a hint
UPDATE public.payroll_statutory_rules
   SET computation_method = COALESCE(NULLIF(parameters->>'computation_method',''), 'flat_amount')
 WHERE computation_method = 'unknown'
   AND COALESCE(NULLIF(parameters->>'computation_method',''), 'flat_amount') <> 'unknown';

-- B6: Block future 'unknown' values via a trigger (CHECK constraints can't reference enums cleanly here,
-- and a trigger gives a clearer error message for accountants).
CREATE OR REPLACE FUNCTION public.payroll_statutory_rules_block_unknown()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.computation_method IS NULL OR NEW.computation_method = 'unknown' THEN
    RAISE EXCEPTION
      'payroll_statutory_rules.computation_method must be set (got %). Use one of flat_amount, percentage, tiered_brackets, or formula.',
      COALESCE(NEW.computation_method, 'NULL')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_statutory_rules_block_unknown ON public.payroll_statutory_rules;
CREATE TRIGGER trg_payroll_statutory_rules_block_unknown
BEFORE INSERT OR UPDATE OF computation_method ON public.payroll_statutory_rules
FOR EACH ROW EXECUTE FUNCTION public.payroll_statutory_rules_block_unknown();