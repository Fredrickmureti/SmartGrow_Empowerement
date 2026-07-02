
-- P1.2 — Deprecate Kenya-typed columns on public.payslips (non-breaking step 1)
--
-- This migration does NOT drop or rename any column. It marks the legacy
-- country-specific columns as deprecated via COMMENT ON COLUMN and adds a
-- forward-compatible view (`payslips_with_aggregates`) that derives the
-- same totals from `payslip_lines` (the country-agnostic source of truth).
-- Consumers will be migrated to the view in a follow-on slice; once they
-- are all moved, the engine writes can be turned off behind a feature
-- flag, and the columns themselves can be renamed `_legacy_*` and finally
-- dropped.

DO $$
DECLARE
  c text;
  legacy_cols text[] := ARRAY[
    'paye','nhif','nssf_employee','nssf_employer','housing_levy',
    'basic_salary','housing_allowance','transport_allowance',
    'overtime_pay','bonus','personal_relief','insurance_relief',
    'other_earnings','other_deductions'
  ];
BEGIN
  FOREACH c IN ARRAY legacy_cols LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='payslips' AND column_name=c
    ) THEN
      EXECUTE format(
        $f$COMMENT ON COLUMN public.payslips.%I IS
          'DEPRECATED (Phase 4 P1.2): country-specific shadow of payslip_lines. '
          'Read from public.payslips_with_aggregates or aggregate payslip_lines by '
          'rule_code / category instead. The engine still writes this column today '
          'but writes will be turned off behind PAYSLIP_TYPED_COLS_OFF in a later '
          'slice and the column will then be renamed _legacy_%s before being dropped.'$f$,
        c, c
      );
    END IF;
  END LOOP;
END$$;

-- Forward-compatible aggregate view.
--
-- Exposes every header column on payslips plus computed totals derived live
-- from payslip_lines, grouped by category. Country-agnostic; works for any
-- localization pack because the keys are categories + rule_codes, not
-- hard-coded statutory names.
CREATE OR REPLACE VIEW public.payslips_with_aggregates AS
SELECT
  p.*,
  COALESCE(agg.basic_total, 0)                AS lines_basic_total,
  COALESCE(agg.allowances_total, 0)           AS lines_allowances_total,
  COALESCE(agg.overtime_total, 0)             AS lines_overtime_total,
  COALESCE(agg.bonus_total, 0)                AS lines_bonus_total,
  COALESCE(agg.earnings_total, 0)             AS lines_earnings_total,
  COALESCE(agg.statutory_employee_total, 0)   AS lines_statutory_employee_total,
  COALESCE(agg.statutory_employer_total, 0)   AS lines_statutory_employer_total,
  COALESCE(agg.deductions_total, 0)           AS lines_deductions_total,
  COALESCE(agg.employer_contrib_total, 0)     AS lines_employer_contrib_total,
  COALESCE(agg.info_total, 0)                 AS lines_info_total
FROM public.payslips p
LEFT JOIN LATERAL (
  SELECT
    SUM(CASE WHEN l.category::text = 'basic'                 THEN l.employee_amount ELSE 0 END) AS basic_total,
    SUM(CASE WHEN l.category::text = 'allowance'             THEN l.employee_amount ELSE 0 END) AS allowances_total,
    SUM(CASE WHEN l.category::text = 'overtime'              THEN l.employee_amount ELSE 0 END) AS overtime_total,
    SUM(CASE WHEN l.category::text = 'bonus'                 THEN l.employee_amount ELSE 0 END) AS bonus_total,
    SUM(CASE WHEN l.category::text IN ('basic','allowance','overtime','bonus','earning')
                                                              THEN l.employee_amount ELSE 0 END) AS earnings_total,
    SUM(CASE WHEN l.category::text = 'statutory_employee'    THEN l.employee_amount ELSE 0 END) AS statutory_employee_total,
    SUM(CASE WHEN l.category::text = 'statutory_employer'    THEN l.employer_amount ELSE 0 END) AS statutory_employer_total,
    SUM(CASE WHEN l.category::text IN ('deduction','statutory_employee','tax','income_tax',
                                       'loan_repayment','benefit_recovery','voluntary_deduction','garnishment')
                                                              THEN l.employee_amount ELSE 0 END) AS deductions_total,
    SUM(CASE WHEN l.category::text IN ('employer_contribution','statutory_employer','training_levy','pension_employer')
                                                              THEN l.employer_amount ELSE 0 END) AS employer_contrib_total,
    SUM(CASE WHEN l.category::text NOT IN ('basic','allowance','overtime','bonus','earning',
                                           'deduction','statutory_employee','tax','income_tax',
                                           'loan_repayment','benefit_recovery','voluntary_deduction','garnishment',
                                           'employer_contribution','statutory_employer','training_levy','pension_employer')
                                                              THEN l.employee_amount ELSE 0 END) AS info_total
  FROM public.payslip_lines l
  WHERE l.payslip_id = p.id
) agg ON TRUE;

COMMENT ON VIEW public.payslips_with_aggregates IS
  'Phase 4 P1.2 — country-agnostic replacement for the deprecated typed '
  'columns on public.payslips. Derives per-category totals live from '
  'payslip_lines so new consumers do not have to depend on legacy column '
  'names (paye, nhif, basic_salary, etc.) that only apply to Kenya. RLS '
  'is inherited from the underlying payslips table.';

GRANT SELECT ON public.payslips_with_aggregates TO authenticated;
GRANT SELECT ON public.payslips_with_aggregates TO service_role;
