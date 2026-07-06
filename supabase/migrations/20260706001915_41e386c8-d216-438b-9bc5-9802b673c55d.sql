
-- ADR 0060 — Certificate template parity with returns.
-- Pack-only changes; no tenant data touched.

-- 1. First-class metadata columns on certificate templates
ALTER TABLE public.localization_pack_certificate_templates
  ADD COLUMN IF NOT EXISTS authority_id uuid REFERENCES public.statutory_authorities(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS legal_reference text,
  ADD COLUMN IF NOT EXISTS regulation_citation text,
  ADD COLUMN IF NOT EXISTS effective_date date NOT NULL DEFAULT DATE '1900-01-01',
  ADD COLUMN IF NOT EXISTS sunset_date date,
  ADD COLUMN IF NOT EXISTS revision_notes text,
  ADD COLUMN IF NOT EXISTS issued_to text NOT NULL DEFAULT 'employee',
  ADD COLUMN IF NOT EXISTS approval_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS legacy_unvalidated boolean NOT NULL DEFAULT true;

ALTER TABLE public.localization_pack_certificate_templates
  DROP CONSTRAINT IF EXISTS cert_tpl_issued_to_check;
ALTER TABLE public.localization_pack_certificate_templates
  ADD CONSTRAINT cert_tpl_issued_to_check
  CHECK (issued_to IN ('employee','employer','both'));

CREATE INDEX IF NOT EXISTS idx_cert_templates_authority_id
  ON public.localization_pack_certificate_templates(authority_id);
CREATE INDEX IF NOT EXISTS idx_cert_templates_effective_date
  ON public.localization_pack_certificate_templates(effective_date);

-- 2. certificate_template_v2 JSON Schema
INSERT INTO public.pack_rule_type_schemas
  (rule_type, computation_kind, schema_version, json_schema, description)
VALUES (
  'certificate_template',
  'v2',
  1,
  jsonb_build_object(
    '$schema','http://json-schema.org/draft-07/schema#',
    'title','Certificate Template v2 Body',
    'type','object',
    'required', jsonb_build_array('sections','data_source'),
    'properties', jsonb_build_object(
      'data_source', jsonb_build_object('type','string','enum', jsonb_build_array('payroll_employee_ytd')),
      'sections', jsonb_build_object(
        'type','array','minItems',1,
        'items', jsonb_build_object(
          'type','object','required', jsonb_build_array('type'),
          'properties', jsonb_build_object(
            'type', jsonb_build_object(
              'type','string',
              'enum', jsonb_build_array(
                'employer_header','employee_header','fiscal_period_band',
                'monthly_breakdown','ytd_table','totals','relief_summary',
                'signature_block','statutory_footnote'
              )
            )
          )
        )
      ),
      'footer_note', jsonb_build_object('type', array['string','null']::text[])
    )
  ),
  'Body schema for localization_pack_certificate_templates (ADR 0060).'
)
ON CONFLICT DO NOTHING;

-- 3. Dedicated validator trigger for certificate templates
CREATE OR REPLACE FUNCTION public.assert_certificate_template_body_valid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  _schema jsonb;
  _errs text[];
BEGIN
  SELECT json_schema INTO _schema
  FROM public.pack_rule_type_schemas
  WHERE rule_type='certificate_template' AND computation_kind='v2'
  ORDER BY schema_version DESC LIMIT 1;

  IF _schema IS NULL THEN
    NEW.legacy_unvalidated := true;
    RETURN NEW;
  END IF;

  -- Legacy bodies (no data_source) are accepted but flagged so the
  -- editor can nag publishers to migrate; writes are not blocked.
  IF NEW.body IS NULL OR NOT (NEW.body ? 'data_source') THEN
    NEW.legacy_unvalidated := true;
    RETURN NEW;
  END IF;

  _errs := public.validate_jsonb_against_schema(NEW.body, _schema);
  IF array_length(_errs,1) > 0 THEN
    RAISE EXCEPTION 'Invalid certificate template body for % : %',
      NEW.code, array_to_string(_errs,'; ');
  END IF;
  NEW.legacy_unvalidated := false;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_assert_certificate_template_body_valid
  ON public.localization_pack_certificate_templates;
CREATE TRIGGER trg_assert_certificate_template_body_valid
  BEFORE INSERT OR UPDATE ON public.localization_pack_certificate_templates
  FOR EACH ROW EXECUTE FUNCTION public.assert_certificate_template_body_valid();

-- 4. Kenya pack v-next: authority + P9 body refresh + Certificate of Service
DO $$
DECLARE
  _ke_pack uuid;
  _kra_id uuid;
BEGIN
  SELECT id INTO _ke_pack FROM public.localization_packs WHERE country_code='KE' LIMIT 1;
  IF _ke_pack IS NULL THEN RETURN; END IF;

  INSERT INTO public.statutory_authorities (pack_id, country_code, code, display_name, portal_url)
  VALUES (_ke_pack, 'KE', 'KRA', 'Kenya Revenue Authority', 'https://itax.kra.go.ke')
  ON CONFLICT (pack_id, country_code, code) DO NOTHING;

  SELECT id INTO _kra_id FROM public.statutory_authorities
    WHERE pack_id=_ke_pack AND country_code='KE' AND code='KRA' LIMIT 1;

  UPDATE public.localization_pack_certificate_templates SET
    authority_id       = _kra_id,
    legal_reference    = 'Income Tax Act, CAP 470',
    regulation_citation= 'Section 37 — Deduction of tax from emoluments',
    effective_date     = DATE '2024-07-01',
    revision_notes     = 'P9A structural refresh: employer/employee header, monthly PAYE triad (chargeable pay, relief, PAYE), YTD totals, signature block, statutory footnote.',
    issued_to          = 'employee',
    approval_required  = false,
    body = jsonb_build_object(
      'data_source','payroll_employee_ytd',
      'sections', jsonb_build_array(
        jsonb_build_object('type','employer_header',
          'include', jsonb_build_array('name','tax_pin','address','tax_office')),
        jsonb_build_object('type','employee_header',
          'include', jsonb_build_array('employee_number','full_name','tax_pin','national_id','position','department')),
        jsonb_build_object('type','fiscal_period_band','title','Tax Year'),
        jsonb_build_object('type','monthly_breakdown',
          'title','Monthly PAYE Computation',
          'rule_codes', jsonb_build_array('gross_pay','nssf','shif','housing_levy','chargeable_pay','tax_charged','personal_relief','insurance_relief','paye'),
          'columns', jsonb_build_array(
            jsonb_build_object('key','gross_pay',       'header','Gross Pay',        'source','rule_code','format','money'),
            jsonb_build_object('key','nssf',            'header','NSSF',              'source','rule_code','format','money'),
            jsonb_build_object('key','shif',            'header','SHIF',              'source','rule_code','format','money'),
            jsonb_build_object('key','housing_levy',    'header','AHL',               'source','rule_code','format','money'),
            jsonb_build_object('key','chargeable_pay',  'header','Chargeable Pay',    'source','rule_code','format','money'),
            jsonb_build_object('key','tax_charged',     'header','Tax Charged',       'source','rule_code','format','money'),
            jsonb_build_object('key','personal_relief', 'header','Personal Relief',   'source','rule_code','format','money'),
            jsonb_build_object('key','insurance_relief','header','Insurance Relief',  'source','rule_code','format','money'),
            jsonb_build_object('key','paye',            'header','PAYE',              'source','rule_code','format','money')
          )
        ),
        jsonb_build_object('type','totals','title','Year-to-Date Totals'),
        jsonb_build_object('type','statutory_footnote',
          'body','Issued under Section 37 of the Income Tax Act (CAP 470). This P9A summarises PAYE deducted and remitted by the employer to the Kenya Revenue Authority for the tax year shown. Retain for filing your annual individual return (IT1).'),
        jsonb_build_object('type','signature_block',
          'include', jsonb_build_array('preparer','date','employer_stamp'))
      ),
      'footer_note','Kenya Revenue Authority · P9A Tax Deduction Card'
    )
  WHERE pack_id=_ke_pack AND code='P9';

  INSERT INTO public.localization_pack_certificate_templates
    (pack_id, code, display_name, description, period, layout,
     authority_id, legal_reference, regulation_citation,
     effective_date, issued_to, approval_required, sort_order, body)
  SELECT
    _ke_pack, 'CERT_OF_SERVICE', 'Certificate of Service',
    'Employer certificate confirming an employee''s tenure, position and remuneration on exit — mandatory under the Employment Act.',
    'annual','standard', NULL,
    'Employment Act, 2007','Section 51 — Certificate of Service',
    DATE '2024-01-01','employee', true, 20,
    jsonb_build_object(
      'data_source','payroll_employee_ytd',
      'sections', jsonb_build_array(
        jsonb_build_object('type','employer_header',
          'include', jsonb_build_array('name','address','tax_pin')),
        jsonb_build_object('type','employee_header',
          'include', jsonb_build_array('full_name','employee_number','national_id','position','department')),
        jsonb_build_object('type','fiscal_period_band','title','Period of Service'),
        jsonb_build_object('type','totals','title','Final Year Earnings'),
        jsonb_build_object('type','statutory_footnote',
          'body','Issued in compliance with Section 51 of the Employment Act, 2007. This certificate is not a testimonial.'),
        jsonb_build_object('type','signature_block',
          'include', jsonb_build_array('preparer','date','employer_stamp'))
      ),
      'footer_note','Certificate of Service · Employment Act, 2007'
    )
  WHERE NOT EXISTS (
    SELECT 1 FROM public.localization_pack_certificate_templates
    WHERE pack_id=_ke_pack AND code='CERT_OF_SERVICE'
  );
END $$;
