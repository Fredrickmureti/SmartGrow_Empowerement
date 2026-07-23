
-- Fix garnishment policy pct storage form (fraction, not percent)
-- and lock it with CHECK constraints so seed drift can't reintroduce
-- the percent-form bug that silently zeroed every legal-order deduction.

-- 1. Repair pack rows (66.6667 → 0.6667, 33.3333 → 0.3333, etc.)
UPDATE public.localization_pack_garnishment_policies
   SET aggregate_cap_pct = aggregate_cap_pct / 100
 WHERE aggregate_cap_pct IS NOT NULL AND aggregate_cap_pct > 1;

UPDATE public.localization_pack_garnishment_policies
   SET min_take_home_pct = min_take_home_pct / 100
 WHERE min_take_home_pct IS NOT NULL AND min_take_home_pct > 1;

-- 2. Repair any tenant override rows in the same drifted form
UPDATE public.payroll_settings
   SET garnishment_aggregate_cap_pct = garnishment_aggregate_cap_pct / 100
 WHERE garnishment_aggregate_cap_pct IS NOT NULL AND garnishment_aggregate_cap_pct > 1;

UPDATE public.payroll_settings
   SET garnishment_minimum_take_home_pct = garnishment_minimum_take_home_pct / 100
 WHERE garnishment_minimum_take_home_pct IS NOT NULL AND garnishment_minimum_take_home_pct > 1;

-- 3. Guardrail: fraction form is the canonical contract; the engine
--    multiplies these values directly. Anything outside [0,1] is a bug.
ALTER TABLE public.localization_pack_garnishment_policies
  DROP CONSTRAINT IF EXISTS chk_pack_garn_policy_aggregate_cap_pct_fraction,
  ADD  CONSTRAINT chk_pack_garn_policy_aggregate_cap_pct_fraction
       CHECK (aggregate_cap_pct IS NULL OR (aggregate_cap_pct >= 0 AND aggregate_cap_pct <= 1));

ALTER TABLE public.localization_pack_garnishment_policies
  DROP CONSTRAINT IF EXISTS chk_pack_garn_policy_min_take_home_pct_fraction,
  ADD  CONSTRAINT chk_pack_garn_policy_min_take_home_pct_fraction
       CHECK (min_take_home_pct IS NULL OR (min_take_home_pct >= 0 AND min_take_home_pct <= 1));

ALTER TABLE public.payroll_settings
  DROP CONSTRAINT IF EXISTS chk_payroll_settings_garn_aggregate_cap_pct_fraction,
  ADD  CONSTRAINT chk_payroll_settings_garn_aggregate_cap_pct_fraction
       CHECK (garnishment_aggregate_cap_pct IS NULL OR (garnishment_aggregate_cap_pct >= 0 AND garnishment_aggregate_cap_pct <= 1));

ALTER TABLE public.payroll_settings
  DROP CONSTRAINT IF EXISTS chk_payroll_settings_garn_min_take_home_pct_fraction,
  ADD  CONSTRAINT chk_payroll_settings_garn_min_take_home_pct_fraction
       CHECK (garnishment_minimum_take_home_pct IS NULL OR (garnishment_minimum_take_home_pct >= 0 AND garnishment_minimum_take_home_pct <= 1));

COMMENT ON COLUMN public.localization_pack_garnishment_policies.aggregate_cap_pct IS
  'Fraction in [0,1] (e.g. 0.6667 for two-thirds). The payroll engine multiplies this directly against disposable income.';
COMMENT ON COLUMN public.localization_pack_garnishment_policies.min_take_home_pct IS
  'Fraction in [0,1] (e.g. 0.3333 for one-third). The payroll engine multiplies this directly against gross pay to compute the protected-earnings floor.';
COMMENT ON COLUMN public.payroll_settings.garnishment_aggregate_cap_pct IS
  'Tenant override for the aggregate cap. Fraction in [0,1].';
COMMENT ON COLUMN public.payroll_settings.garnishment_minimum_take_home_pct IS
  'Tenant override for the protected-earnings floor. Fraction in [0,1].';
