
CREATE TABLE IF NOT EXISTS public.localization_pack_certificate_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id uuid REFERENCES public.localization_packs(id) ON DELETE CASCADE,
  code text NOT NULL,
  display_name text NOT NULL,
  description text,
  period text NOT NULL DEFAULT 'annual',
  layout text NOT NULL DEFAULT 'standard',
  body jsonb NOT NULL DEFAULT '{}'::jsonb,
  due_day integer,
  due_month_offset integer,
  sort_order integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cert_tpl_pack_code_uniq
  ON public.localization_pack_certificate_templates (COALESCE(pack_id, '00000000-0000-0000-0000-000000000000'::uuid), code);

ALTER TABLE public.localization_pack_certificate_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cert_tpl_read_all_authenticated"
ON public.localization_pack_certificate_templates
FOR SELECT TO authenticated USING (true);

CREATE POLICY "cert_tpl_service_role_all"
ON public.localization_pack_certificate_templates
FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.localization_pack_certificate_templates (pack_id, code, display_name, description, period, layout, body, due_month_offset, due_day, sort_order)
SELECT NULL, 'ANNUAL_EARNINGS_STATEMENT', 'Annual Earnings Statement',
       'Generic annual earnings & deductions summary built from payroll history.',
       'annual', 'standard',
       jsonb_build_object(
         'sections', jsonb_build_array(
           jsonb_build_object('type','employee_header'),
           jsonb_build_object('type','ytd_table','title','Earnings & Deductions',
             'columns', jsonb_build_array('rule_code','category','employee_amount','employer_amount','taxable_amount')),
           jsonb_build_object('type','totals')
         )
       ),
       1, 31, 10
WHERE NOT EXISTS (
  SELECT 1 FROM public.localization_pack_certificate_templates
  WHERE pack_id IS NULL AND code = 'ANNUAL_EARNINGS_STATEMENT'
);

INSERT INTO public.localization_pack_certificate_templates (pack_id, code, display_name, description, period, layout, body, due_month_offset, due_day, sort_order)
SELECT lp.id, 'P9', 'P9 Tax Deduction Card',
       'KRA P9 — Annual tax deduction card for employees.',
       'annual', 'p9',
       jsonb_build_object(
         'sections', jsonb_build_array(
           jsonb_build_object('type','employee_header','include', jsonb_build_array('tax_pin','national_id')),
           jsonb_build_object('type','monthly_breakdown',
             'rule_codes', jsonb_build_array('basic','gross','paye','nssf','shif','housing_levy','personal_relief')),
           jsonb_build_object('type','totals')
         )
       ),
       2, 28, 1
FROM public.localization_packs lp
WHERE lp.country_code='KE'
  AND NOT EXISTS (
    SELECT 1 FROM public.localization_pack_certificate_templates t
    WHERE t.pack_id = lp.id AND t.code = 'P9'
  );


CREATE TABLE IF NOT EXISTS public.payroll_tax_certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  employee_id uuid NOT NULL,
  template_code text NOT NULL,
  template_pack_id uuid REFERENCES public.localization_packs(id),
  fiscal_year integer NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  pdf_path text,
  serial_number text NOT NULL,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('draft','issued','superseded')),
  superseded_by uuid REFERENCES public.payroll_tax_certificates(id) ON DELETE SET NULL,
  generated_by uuid,
  generated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payroll_tax_certificates_issued_uniq
  ON public.payroll_tax_certificates (organization_id, business_id, employee_id, template_code, fiscal_year)
  WHERE status = 'issued';

CREATE INDEX IF NOT EXISTS payroll_tax_certificates_lookup
  ON public.payroll_tax_certificates (organization_id, business_id, fiscal_year, template_code, status);

ALTER TABLE public.payroll_tax_certificates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tax_cert_org_read"
ON public.payroll_tax_certificates
FOR SELECT TO authenticated
USING (public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'read'));

CREATE POLICY "tax_cert_managers_write"
ON public.payroll_tax_certificates
FOR ALL TO authenticated
USING (public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write'))
WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write'));

CREATE POLICY "tax_cert_service_role_all"
ON public.payroll_tax_certificates
FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER tax_certificates_updated_at
BEFORE UPDATE ON public.payroll_tax_certificates
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
