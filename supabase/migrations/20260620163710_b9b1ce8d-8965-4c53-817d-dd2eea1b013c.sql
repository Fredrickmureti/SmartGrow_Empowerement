-- =====================================================================
-- Payroll & Localization Hardening + Kenya Pack 2026 Refresh
-- Phase 3 (architectural remediation) + Phase 4 (KE pack refresh)
-- =====================================================================

-- P0: Open-payroll-period guard for pack version bumps.
CREATE OR REPLACE FUNCTION public._guard_pack_version_change_no_open_runs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_open_count int;
BEGIN
  IF NEW.pack_version IS NOT DISTINCT FROM OLD.pack_version THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_open_count
  FROM public.payroll_runs
  WHERE business_id = NEW.business_id
    AND status IN ('draft', 'pending', 'processing', 'pending_approval');

  IF v_open_count > 0 THEN
    RAISE EXCEPTION
      'Cannot change localization pack version while % payroll run(s) are open for this business. Close, post, or cancel open runs before applying a pack upgrade.',
      v_open_count
      USING ERRCODE = 'check_violation',
            HINT    = 'Open runs hold a snapshot of the active rule set; mutating it mid-run would corrupt computations.';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public._guard_pack_version_change_no_open_runs() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_guard_pack_version_change ON public.installed_localization_packs;
CREATE TRIGGER trg_guard_pack_version_change
  BEFORE UPDATE OF pack_version ON public.installed_localization_packs
  FOR EACH ROW
  EXECUTE FUNCTION public._guard_pack_version_change_no_open_runs();


-- ---------------------------------------------------------------------
-- Phase 4: Kenya pack 2026 refresh (in-place; publish pipeline snapshots it)
-- ---------------------------------------------------------------------

-- 4.1 PAYE: TLAA 2024 above-the-line deductions, caps, reliefs metadata.
UPDATE public.localization_pack_payroll_templates
SET parameters = parameters
  || jsonb_build_object(
       'pre_tax_deductions', jsonb_build_array('nssf','shif','housing_levy','pension_contribution','mortgage_interest','post_retirement_medical'),
       'caps', jsonb_build_object(
         'pension_contribution_monthly',     30000,
         'mortgage_interest_monthly',        30000,
         'post_retirement_medical_monthly',  15000,
         'non_cash_benefit_monthly',          5000,
         'employer_meals_monthly',            5000
       ),
       'reliefs', jsonb_build_object(
         'personal_relief_monthly',        2400,
         'insurance_relief_rate',            15,
         'insurance_relief_cap_monthly',   5000
       ),
       'effective_from',                '2024-12-27',
       'legal_basis',                   'Income Tax Act Cap 470 as amended by Tax Laws (Amendment) Act 2024 and Finance Act 2025',
       'employer_must_apply_reliefs',   true,
       'notes',                         'PAYE bands per Finance Act 2023 (unchanged). TLAA 2024 reclassified SHIF, AHL employee portion, mortgage interest, pension, and post-retirement medical from reliefs to above-the-line deductions. Finance Act 2025 obliges the employer to proactively apply all reliefs at source.'
     )
WHERE pack_id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid
  AND parameters->>'code' = 'paye';

-- 4.2 NSSF Year 4 (effective Feb 2026)
UPDATE public.localization_pack_payroll_templates
SET parameters = (parameters - 'old_rates')
  || jsonb_build_object(
       'tiers', jsonb_build_array(
         jsonb_build_object('name','Tier I',  'lower_earnings_limit',    0, 'upper_earnings_limit',   9000, 'employee_rate', 6, 'employer_rate', 6),
         jsonb_build_object('name','Tier II', 'lower_earnings_limit', 9000, 'upper_earnings_limit', 108000, 'employee_rate', 6, 'employer_rate', 6)
       ),
       'effective_from',           '2026-02-01',
       'max_employee_monthly',     6480,
       'max_employer_monthly',     6480,
       'paye_deductible',          true,
       'remittance_due_day',       9,
       'legal_basis',              'NSSF Act No. 45 of 2013, Year 4 schedule',
       'notes',                    'Year 4 of the 2013 Act phased rollout (Feb 2026 - Jan 2027). Earnings above UEL KES 108,000 are not pensionable. Employers may contract out Tier II to an approved scheme passing the Reference Scheme Test.'
     )
WHERE pack_id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid
  AND parameters->>'code' = 'nssf';

-- 4.3 SHIF
UPDATE public.localization_pack_payroll_templates
SET parameters = parameters
  || jsonb_build_object(
       'rate',               2.75,
       'employer_rate',         0,
       'employee_only',      true,
       'minimum_monthly',      300,
       'paye_deductible',    true,
       'effective_from',     '2024-10-01',
       'remittance_due_day',    9,
       'legal_basis',        'Social Health Insurance Act No. 16 of 2023; SHI (General) Regulations 2024',
       'notes',              'Replaced NHIF effective 1 Oct 2024. No upper ceiling. Minimum KES 300/month for informal/self-employed. Confirmed in force by High Court ruling 23 Jun 2025.'
     )
WHERE pack_id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid
  AND parameters->>'code' = 'shif';

-- 4.4 Affordable Housing Levy
UPDATE public.localization_pack_payroll_templates
SET parameters = parameters
  || jsonb_build_object(
       'employee_rate',                 1.5,
       'employer_rate',                 1.5,
       'paye_deductible',              true,
       'effective_from',         '2024-03-19',
       'remittance_due_day',              9,
       'remittance_due_basis',  'working_days',
       'legal_basis',           'Affordable Housing Act No. 2 of 2024',
       'notes',                 'Both portions on gross monthly salary; collected by KRA via P10 Sheet M. Employee portion was reclassified to an above-the-line PAYE deduction by TLAA 2024 (27 Dec 2024).'
     )
WHERE pack_id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid
  AND parameters->>'code' = 'housing_levy';

-- 4.5 NITA
UPDATE public.localization_pack_payroll_templates
SET parameters = parameters
  || jsonb_build_object(
       'amount_per_employee',  50,
       'employer_only',      true,
       'effective_from', '2011-01-01',
       'legal_basis',    'Industrial Training (Amendment) Act 2011',
       'notes',          'Flat employer levy. Remitted monthly to NITA.'
     )
WHERE pack_id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid
  AND parameters->>'code' = 'nita';

-- 4.6 Bump pack metadata; publish via normal pipeline (no SQL bypass).
UPDATE public.localization_packs
SET version    = '2026.1.0',
    updated_at = now()
WHERE id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid;
