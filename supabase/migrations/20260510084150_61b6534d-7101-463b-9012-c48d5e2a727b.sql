
-- R7: Pack-driven statutory returns

CREATE TABLE IF NOT EXISTS public.localization_pack_return_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id uuid REFERENCES public.localization_packs(id) ON DELETE CASCADE,
  code text NOT NULL,
  display_name text NOT NULL,
  description text,
  authority_name text,
  period text NOT NULL DEFAULT 'monthly' CHECK (period IN ('monthly','quarterly','annual')),
  output text NOT NULL DEFAULT 'csv' CHECK (output IN ('csv','pdf','both')),
  body jsonb NOT NULL DEFAULT '{}'::jsonb,
  due_day integer,
  due_month_offset integer,
  sort_order integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS return_tpl_pack_code_uniq
  ON public.localization_pack_return_templates (COALESCE(pack_id, '00000000-0000-0000-0000-000000000000'::uuid), code);

ALTER TABLE public.localization_pack_return_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "return_tpl_read_all_authenticated"
ON public.localization_pack_return_templates
FOR SELECT TO authenticated USING (true);

CREATE POLICY "return_tpl_service_role_all"
ON public.localization_pack_return_templates
FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER return_tpl_updated_at
BEFORE UPDATE ON public.localization_pack_return_templates
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- KE P10 PAYE monthly seed
INSERT INTO public.localization_pack_return_templates
  (pack_id, code, display_name, description, authority_name, period, output, body, due_month_offset, due_day, sort_order)
SELECT lp.id, 'P10_PAYE', 'P10 Monthly PAYE Return',
       'KRA P10 — Monthly Pay-As-You-Earn return aggregated from validated payslips.',
       'Kenya Revenue Authority',
       'monthly', 'both',
       jsonb_build_object(
         'filters', jsonb_build_object(
           'rule_codes', jsonb_build_array('paye'),
           'payslip_status', jsonb_build_array('validated','paid')
         ),
         'group_by', jsonb_build_array('employee_id'),
         'columns', jsonb_build_array(
           jsonb_build_object('key','employee_pin','source','employee.tax_pin','label','PIN of Employee'),
           jsonb_build_object('key','employee_name','source','employee.full_name','label','Name of Employee'),
           jsonb_build_object('key','national_id','source','employee.national_id','label','National ID'),
           jsonb_build_object('key','gross_pay','source','sum_taxable_amount','label','Gross Pay'),
           jsonb_build_object('key','paye','source','sum_employee_amount','label','PAYE Tax (Kshs)')
         ),
         'totals', jsonb_build_array('gross_pay','paye'),
         'reconciliation', jsonb_build_object(
           'rule_code','paye',
           'against','payroll_liabilities.original_amount'
         )
       ),
       1, 9, 1
FROM public.localization_packs lp
WHERE lp.country_code='KE'
  AND NOT EXISTS (
    SELECT 1 FROM public.localization_pack_return_templates t
    WHERE t.pack_id = lp.id AND t.code = 'P10_PAYE'
  );


CREATE TABLE IF NOT EXISTS public.payroll_return_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  template_code text NOT NULL,
  template_pack_id uuid REFERENCES public.localization_packs(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  csv_path text,
  pdf_path text,
  serial_number text NOT NULL,
  status text NOT NULL DEFAULT 'generated' CHECK (status IN ('draft','generated','filed','superseded')),
  superseded_by uuid REFERENCES public.payroll_return_runs(id) ON DELETE SET NULL,
  generated_by uuid,
  generated_at timestamptz NOT NULL DEFAULT now(),
  filed_at timestamptz,
  filed_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payroll_return_runs_active_uniq
  ON public.payroll_return_runs (organization_id, business_id, template_code, period_start, period_end)
  WHERE status IN ('generated','filed');

CREATE INDEX IF NOT EXISTS payroll_return_runs_lookup
  ON public.payroll_return_runs (organization_id, business_id, template_code, period_start, status);

ALTER TABLE public.payroll_return_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "return_runs_org_read"
ON public.payroll_return_runs
FOR SELECT TO authenticated
USING (public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'read'));

CREATE POLICY "return_runs_managers_write"
ON public.payroll_return_runs
FOR ALL TO authenticated
USING (public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write'))
WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write'));

CREATE POLICY "return_runs_service_role_all"
ON public.payroll_return_runs
FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER payroll_return_runs_updated_at
BEFORE UPDATE ON public.payroll_return_runs
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
