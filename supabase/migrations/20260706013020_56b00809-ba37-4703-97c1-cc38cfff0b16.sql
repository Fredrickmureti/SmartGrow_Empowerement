-- ================================================================
-- Kenya Pack v2026.4.0 — Statutory Certificates Structural Refresh
-- ADR 0060 follow-through — Section 6 (P9A + CERT_OF_SERVICE +
-- pack-level structural gate).
--
-- NO tenant business data is modified.  Only pack template rows.
-- Fanout to installed tenants happens via
-- public.publish_localization_pack_version_sql() (called from a
-- follow-up data insert, not from this migration).
-- ================================================================

-- 1. Ensure a labour-side authority exists so CERT_OF_SERVICE
--    can satisfy the authority-required gate without pretending
--    KRA issues it.  Idempotent.
DO $$
DECLARE
  _ke_pack UUID;
BEGIN
  SELECT id INTO _ke_pack FROM public.localization_packs
    WHERE country_code = 'KE' LIMIT 1;
  IF _ke_pack IS NULL THEN
    RAISE NOTICE 'KE pack not present; skipping labour authority seed';
    RETURN;
  END IF;

  INSERT INTO public.statutory_authorities
    (pack_id, country_code, code, display_name, portal_url, efiling_endpoint, contact)
  VALUES
    (_ke_pack, 'KE', 'MINISTRY_OF_LABOUR',
     'Ministry of Labour and Social Protection',
     'https://labour.go.ke', NULL, '{}'::jsonb)
  ON CONFLICT DO NOTHING;
END $$;

-- 2. Rebuild the KE P9A (Low Income Employees) template.
--    Full KRA 2024 revision: columns A–K, identity headers,
--    signature block, statutory footnote, real legal metadata.
DO $$
DECLARE
  _ke_pack UUID;
  _kra_id  UUID;
BEGIN
  SELECT id INTO _ke_pack FROM public.localization_packs
    WHERE country_code = 'KE' LIMIT 1;
  IF _ke_pack IS NULL THEN
    RAISE NOTICE 'KE pack not present; skipping P9A refresh';
    RETURN;
  END IF;

  SELECT id INTO _kra_id FROM public.statutory_authorities
    WHERE pack_id = _ke_pack AND country_code = 'KE' AND code = 'KRA'
    LIMIT 1;

  UPDATE public.localization_pack_certificate_templates
     SET display_name        = 'P9A — Tax Deduction Card (Low Income Employees)',
         description         = 'KRA statutory annual tax deduction card for low-income employees under the Income Tax Act CAP 470 s.37. Rebuilt to the 2024 KRA revision with columns A–K.',
         authority_id        = _kra_id,
         legal_reference     = 'Income Tax Act, CAP 470',
         regulation_citation = 'Section 37 — Deduction of tax from emoluments (P9A form, low-income employees)',
         effective_date      = DATE '2024-07-01',
         issued_to           = 'employee',
         approval_required   = false,
         revision_notes      = 'v2026.4.0 P9A structural rebuild: employer/employee identity headers, 12-row monthly grid (KRA columns A–K), YTD totals band, signature block with statutory certification wording, and Sec.37 statutory footnote. Replaces the legacy 2-section stub that fell back to the generic YTD renderer.',
         body = jsonb_build_object(
           'data_source', 'payroll_employee_ytd',
           'sections', jsonb_build_array(
             jsonb_build_object('type','employer_header',
               'title','Employer',
               'include', jsonb_build_array('name','tax_pin','address','tax_office')),
             jsonb_build_object('type','employee_header',
               'title','Employee',
               'include', jsonb_build_array('full_name','employee_number','tax_pin','national_id','position','department')),
             jsonb_build_object('type','fiscal_period_band','title','Tax Year'),
             jsonb_build_object('type','monthly_breakdown',
               'title','Monthly PAYE Computation (KRA P9A cols A–K)',
               'rule_codes', jsonb_build_array(
                 'basic_salary','benefits_non_cash','value_of_quarters',
                 'gross_pay','defined_contribution_retirement',
                 'owner_occupier_interest','chargeable_pay',
                 'tax_charged','personal_relief','insurance_relief','paye'),
               'columns', jsonb_build_array(
                 jsonb_build_object('key','basic_salary',                   'header','A. Basic Salary',              'source','rule_code','format','money'),
                 jsonb_build_object('key','benefits_non_cash',              'header','B. Benefits (Non-Cash)',       'source','rule_code','format','money'),
                 jsonb_build_object('key','value_of_quarters',              'header','C. Value of Quarters',         'source','rule_code','format','money'),
                 jsonb_build_object('key','gross_pay',                      'header','D. Total Gross Pay',           'source','rule_code','format','money'),
                 jsonb_build_object('key','defined_contribution_retirement','header','E. DC Retirement (30%/actual/30k)','source','rule_code','format','money'),
                 jsonb_build_object('key','owner_occupier_interest',        'header','F. Owner-Occupier Interest',   'source','rule_code','format','money'),
                 jsonb_build_object('key','chargeable_pay',                 'header','G. Chargeable Pay',            'source','rule_code','format','money'),
                 jsonb_build_object('key','tax_charged',                    'header','H. Tax Charged',               'source','rule_code','format','money'),
                 jsonb_build_object('key','personal_relief',                'header','I. Personal Relief',           'source','rule_code','format','money'),
                 jsonb_build_object('key','insurance_relief',               'header','J. Insurance Relief',          'source','rule_code','format','money'),
                 jsonb_build_object('key','paye',                           'header','K. PAYE Tax (Net)',            'source','rule_code','format','money')
               )
             ),
             jsonb_build_object('type','totals','title','Year-to-Date Totals (Columns D, G, H, K)'),
             jsonb_build_object('type','statutory_footnote',
               'body','Issued under Section 37 of the Income Tax Act (CAP 470). This P9A summarises PAYE deducted from a low-income employee and remitted by the employer to the Kenya Revenue Authority for the tax year shown. Personal Relief: KES 2,400 / month. Insurance Relief cap: KES 5,000 / month. Retain for filing your annual individual return (IT1).'),
             jsonb_build_object('type','signature_block',
               'title','Employer Certification',
               'include', jsonb_build_array('preparer','date','employer_stamp'),
               'body','I certify that the total tax shown above has been duly deducted from the employee''s emoluments and remitted to the Commissioner of Domestic Taxes.')
           ),
           'footer_note','Kenya Revenue Authority · P9A Tax Deduction Card (Low Income Employees)'
         )
   WHERE pack_id = _ke_pack AND code = 'P9A';
END $$;

-- 3. Attach a labour authority to the KE Certificate of Service
--    (so the "statutory template must have authority" gate is
--    satisfied without misattribution to KRA).
DO $$
DECLARE
  _ke_pack   UUID;
  _labour_id UUID;
BEGIN
  SELECT id INTO _ke_pack FROM public.localization_packs
    WHERE country_code = 'KE' LIMIT 1;
  IF _ke_pack IS NULL THEN RETURN; END IF;

  SELECT id INTO _labour_id FROM public.statutory_authorities
    WHERE pack_id = _ke_pack AND country_code = 'KE' AND code = 'MINISTRY_OF_LABOUR'
    LIMIT 1;

  UPDATE public.localization_pack_certificate_templates
     SET authority_id = _labour_id
   WHERE pack_id = _ke_pack AND code = 'CERT_OF_SERVICE'
     AND authority_id IS NULL;
END $$;

-- 4. Structural gate — enforce section-array contract on
--    localization_pack_certificate_templates.  Applies to future
--    inserts/updates.  Existing rows have already been repaired
--    above; the gate will reject any regression.
CREATE OR REPLACE FUNCTION public.enforce_certificate_template_structure()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _sections     JSONB;
  _types        TEXT[];
  _needed_ident TEXT[] := ARRAY['employer_header','employee_header','signature_block'];
  _needed_data  TEXT[] := ARRAY['monthly_breakdown','ytd_table','totals'];
  _missing_ident TEXT[];
  _has_data      BOOLEAN;
  _statutory_re  TEXT := '^(P9|P10|VAT|PAYE|NSSF|SHIF|AHL|WHT|NHIF|NITA|HELB)';
BEGIN
  _sections := COALESCE(NEW.body -> 'sections', '[]'::jsonb);
  IF jsonb_typeof(_sections) <> 'array' OR jsonb_array_length(_sections) = 0 THEN
    RAISE EXCEPTION 'Certificate template % (%): body.sections must be a non-empty array. '
                    'Legacy blocks-only templates are no longer publishable.',
                    NEW.code, NEW.display_name
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT array_agg(elem->>'type')
    INTO _types
    FROM jsonb_array_elements(_sections) AS elem;

  SELECT array_agg(needed)
    INTO _missing_ident
    FROM unnest(_needed_ident) AS needed
   WHERE needed <> ALL (_types);

  IF _missing_ident IS NOT NULL AND array_length(_missing_ident, 1) > 0 THEN
    RAISE EXCEPTION 'Certificate template % (%): sections missing required identity/signature types: %. '
                    'Every certificate must include employer_header, employee_header, and signature_block.',
                    NEW.code, NEW.display_name, array_to_string(_missing_ident, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  _has_data := EXISTS (SELECT 1 FROM unnest(_needed_data) t WHERE t = ANY (_types));
  IF NOT _has_data THEN
    RAISE EXCEPTION 'Certificate template % (%): must contain at least one data section (monthly_breakdown, ytd_table, or totals).',
                    NEW.code, NEW.display_name
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.effective_date IS NULL OR NEW.effective_date < DATE '2000-01-01' THEN
    RAISE EXCEPTION 'Certificate template % (%): effective_date must be set and >= 2000-01-01 (got %).',
                    NEW.code, NEW.display_name, NEW.effective_date
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.code ~ _statutory_re AND NEW.authority_id IS NULL THEN
    RAISE EXCEPTION 'Certificate template % (%): statutory code requires authority_id (link a statutory_authorities row).',
                    NEW.code, NEW.display_name
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.legal_reference IS NOT NULL AND NEW.legal_reference <> ''
     AND (NEW.regulation_citation IS NULL OR NEW.regulation_citation = '') THEN
    RAISE EXCEPTION 'Certificate template % (%): regulation_citation is required whenever legal_reference is set.',
                    NEW.code, NEW.display_name
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_certificate_template_structure
  ON public.localization_pack_certificate_templates;

CREATE TRIGGER trg_certificate_template_structure
  BEFORE INSERT OR UPDATE ON public.localization_pack_certificate_templates
  FOR EACH ROW EXECUTE FUNCTION public.enforce_certificate_template_structure();

-- 5. Bump KE pack version marker so the fanout call in step 6
--    (publish_localization_pack_version_sql, invoked from a follow-up
--    insert) snapshots the correct version.
UPDATE public.localization_packs
   SET version = '2026.4.0',
       updated_at = now()
 WHERE country_code = 'KE';
