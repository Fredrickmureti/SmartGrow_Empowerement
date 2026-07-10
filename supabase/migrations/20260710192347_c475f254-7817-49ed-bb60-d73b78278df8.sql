
-- Payroll Report Definitions registry
CREATE TABLE IF NOT EXISTS public.payroll_report_definitions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  report_key TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL CHECK (category IN ('operational','cost','management','compliance','audit')),
  scope TEXT NOT NULL DEFAULT 'organization' CHECK (scope IN ('organization','business','branch','employee')),
  country_code TEXT,
  localization_pack_id UUID REFERENCES public.localization_packs(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  feature_flag TEXT,
  spec JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payroll_report_definitions_key_country_unique
    UNIQUE (report_key, country_code)
);

CREATE INDEX IF NOT EXISTS idx_prd_category_active
  ON public.payroll_report_definitions(category, is_active);
CREATE INDEX IF NOT EXISTS idx_prd_country
  ON public.payroll_report_definitions(country_code)
  WHERE country_code IS NOT NULL;

GRANT SELECT ON public.payroll_report_definitions TO authenticated;
GRANT ALL ON public.payroll_report_definitions TO service_role;

ALTER TABLE public.payroll_report_definitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view active report definitions"
  ON public.payroll_report_definitions
  FOR SELECT
  TO authenticated
  USING (is_active = true);

CREATE POLICY "Org admins manage report definitions"
  ON public.payroll_report_definitions
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER trg_prd_updated_at
  BEFORE UPDATE ON public.payroll_report_definitions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed built-in reports (idempotent via ON CONFLICT)
INSERT INTO public.payroll_report_definitions
  (report_key, label, description, category, scope, sort_order)
VALUES
  ('payroll_register',        'Payroll Register',        'Line-by-line payslip breakdown for a period.', 'operational', 'organization', 10),
  ('payroll_summary',         'Payroll Summary',         'Totals per payroll run (gross, deductions, net).', 'operational', 'organization', 20),
  ('employee_earnings',       'Employee Earnings',       'Per-employee earnings across the window.', 'operational', 'employee', 30),
  ('branch_payroll_cost',     'Branch Payroll Cost',     'Payroll cost aggregated by branch.', 'cost', 'branch', 40),
  ('department_payroll_cost', 'Department Payroll Cost', 'Payroll cost aggregated by department.', 'cost', 'organization', 50),
  ('payroll_overtime',        'Overtime',                'Overtime pay and hours per employee.', 'management', 'employee', 60),
  ('payroll_variance',        'Payroll Variance',        'Period-over-period movement in gross, deductions, and net.', 'management', 'organization', 70),
  ('employer_contributions',  'Employer Contributions',  'Employer-side statutory contributions.', 'compliance', 'organization', 80),
  ('statutory_liabilities',   'Statutory Liabilities',   'Statutory liabilities owed and their remittance status.', 'compliance', 'organization', 90)
ON CONFLICT (report_key, country_code) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      category = EXCLUDED.category,
      scope = EXCLUDED.scope,
      sort_order = EXCLUDED.sort_order,
      updated_at = now();
