-- 1. Add columns to payroll_settings
ALTER TABLE public.payroll_settings
  ADD COLUMN IF NOT EXISTS standard_working_days numeric(5,2),
  ADD COLUMN IF NOT EXISTS standard_hours_per_day numeric(5,2),
  ADD COLUMN IF NOT EXISTS overtime_multiplier numeric(5,2);

-- 2. Backfill from any business in the same org
UPDATE public.payroll_settings ps
   SET standard_working_days  = COALESCE(ps.standard_working_days, b.payroll_standard_working_days),
       standard_hours_per_day = COALESCE(ps.standard_hours_per_day, b.payroll_standard_hours_per_day),
       overtime_multiplier    = COALESCE(ps.overtime_multiplier, b.payroll_overtime_multiplier)
  FROM (
    SELECT DISTINCT ON (organization_id) organization_id,
           payroll_standard_working_days, payroll_standard_hours_per_day, payroll_overtime_multiplier
      FROM public.businesses
     ORDER BY organization_id, created_at NULLS LAST
  ) b
 WHERE b.organization_id = ps.organization_id;

-- 3. Effective view: one row per business
CREATE OR REPLACE VIEW public.v_payroll_settings_effective AS
SELECT
  b.id            AS business_id,
  b.organization_id,
  COALESCE(ps.standard_working_days,  b.payroll_standard_working_days,  22)::numeric AS standard_working_days,
  COALESCE(ps.standard_hours_per_day, b.payroll_standard_hours_per_day, 8)::numeric  AS standard_hours_per_day,
  COALESCE(ps.overtime_multiplier,    b.payroll_overtime_multiplier,    1.5)::numeric AS overtime_multiplier,
  b.country
FROM public.businesses b
LEFT JOIN public.payroll_settings ps ON ps.organization_id = b.organization_id;

GRANT SELECT ON public.v_payroll_settings_effective TO authenticated, service_role;

-- 4. Deprecation comments (columns retained for back-compat)
COMMENT ON COLUMN public.businesses.payroll_standard_working_days  IS 'DEPRECATED — read public.v_payroll_settings_effective. Source of truth is payroll_settings.';
COMMENT ON COLUMN public.businesses.payroll_standard_hours_per_day IS 'DEPRECATED — read public.v_payroll_settings_effective. Source of truth is payroll_settings.';
COMMENT ON COLUMN public.businesses.payroll_overtime_multiplier    IS 'DEPRECATED — read public.v_payroll_settings_effective. Source of truth is payroll_settings.';

-- 5. Legacy-table deprecation comments
COMMENT ON TABLE public.payroll_remittances IS 'DEPRECATED — superseded by payroll_liabilities + payroll_remittance_payments. Do not write from new code.';
COMMENT ON TABLE public.employments         IS 'DEPRECATED — superseded by employee_contracts. Do not write from new code.';