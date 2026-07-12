-- ADR-0060 refinement — certificate template v2 block AST.
-- 1. Widen the pack_rule_type_schemas entry so bodies may carry EITHER
--    the legacy `sections[]` (rendered by the XLSX twin + v1 PDF path)
--    or the new `blocks[]` block AST (rendered by certificateRendererV2).
--    Templates opt into the new PDF renderer by setting body.schema_version = 2.
INSERT INTO public.pack_rule_type_schemas
  (rule_type, computation_kind, schema_version, json_schema, description)
VALUES (
  'certificate_template','v2',2,
  jsonb_build_object(
    '$schema','http://json-schema.org/draft-07/schema#',
    'title','Certificate Template v2 Body (block AST)',
    'type','object',
    'required', jsonb_build_array('data_source'),
    'properties', jsonb_build_object(
      'schema_version', jsonb_build_object('type','integer','minimum',1),
      'data_source', jsonb_build_object('type','string','enum', jsonb_build_array('payroll_employee_ytd')),
      'page', jsonb_build_object('type','object'),
      'footer_note', jsonb_build_object('type','string'),
      'sections', jsonb_build_object('type','array','items', jsonb_build_object('type','object')),
      'blocks', jsonb_build_object(
        'type','array','minItems',1,
        'items', jsonb_build_object(
          'type','object','required', jsonb_build_array('type'),
          'properties', jsonb_build_object(
            'type', jsonb_build_object(
              'type','string',
              'enum', jsonb_build_array(
                'heading','paragraph','field_grid','table','notes',
                'divider','spacer','image','signature_block'
              )
            )
          )
        )
      )
    )
  ),
  'Body schema v2 for localization_pack_certificate_templates (block AST — ADR 0060 refinement).'
) ON CONFLICT DO NOTHING;

-- 2. Rewrite KE P9 / P9A / Certificate of Service to v2 block AST.
DO $$
DECLARE
  _ke_pack uuid;
  _p9_blocks jsonb;
  _cos_blocks jsonb;
  _monthly_cols jsonb;
BEGIN
  SELECT id INTO _ke_pack FROM public.localization_packs WHERE country_code='KE' LIMIT 1;
  IF _ke_pack IS NULL THEN RETURN; END IF;

  _monthly_cols := jsonb_build_array(
    jsonb_build_object('key','month_index','header','Month','width',36,'align','left','format','text'),
    jsonb_build_object('key','basic_salary','header','A · Basic Salary','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','non_cash_benefits','header','B · Non-Cash Benefits','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','housing_benefit','header','C · Value of Quarters','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','gross_pay','header','D · Total Gross Pay','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','pension_30pct_of_basic','header','E1 · 30% of A','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','pension_contribution_actual','header','E2 · Actual Pension','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','pension_statutory_cap','header','E3 · Statutory Cap','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','ahl_employee','header','F · AHL','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','shif_employee','header','G · SHIF','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','prmf_employee','header','H · PRMF','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','mortgage_interest_relief_base','header','I · Owner-Occupied Interest','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','total_relief_deductions','header','J · Total Deductions','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','chargeable_pay','header','K · Chargeable Pay (D − J)','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','paye_gross','header','L · Tax Charged','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','personal_relief','header','M · Personal Relief','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','insurance_relief','header','N · Insurance Relief','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','paye_net','header','O · PAYE (L − M − N)','width','1fr','align','right','format','currency')
  );

  _p9_blocks := jsonb_build_array(
    jsonb_build_object(
      'type','field_grid','title','Employer','columns',2,'data_source','employer',
      'fields', jsonb_build_array(
        jsonb_build_object('key','name','label','Employer Name','emphasis','primary'),
        jsonb_build_object('key','tax_pin','label','Employer KRA PIN'),
        jsonb_build_object('key','address','label','Address'),
        jsonb_build_object('key','tax_office','label','Tax Office')
      )
    ),
    jsonb_build_object(
      'type','field_grid','title','Employee','columns',2,'data_source','employee',
      'fields', jsonb_build_array(
        jsonb_build_object('key','full_name','label','Employee Name','emphasis','primary'),
        jsonb_build_object('key','employee_number','label','Employee Number'),
        jsonb_build_object('key','tax_pin','label','Employee KRA PIN'),
        jsonb_build_object('key','national_id','label','National ID'),
        jsonb_build_object('key','position','label','Position'),
        jsonb_build_object('key','department','label','Department')
      )
    ),
    jsonb_build_object(
      'type','table',
      'title','Monthly PAYE Computation (KRA Columns A–O)',
      'data_source','monthly_breakdown',
      'group_by','month_index',
      'columns', _monthly_cols,
      'footer', jsonb_build_object('label','YTD Total','aggregate','sum'),
      'options', jsonb_build_object('striped',true,'wrap',true,'repeat_header',true,'padding',3,'line_height',1.15,'header_bg',true)
    ),
    jsonb_build_object(
      'type','notes','title','Statutory Notes',
      'paragraphs', jsonb_build_array(
        'Issued under the Income Tax Act CAP 470, Section 37 (Kenya Revenue Authority).',
        'Personal Relief: KES 2,400 per month (KES 28,800 per year). Insurance Relief: 15% of premium, capped at KES 5,000 per month (KES 60,000 per year).',
        'Deductible pension contribution: up to KES 20,000 per month (pre-Dec 2024) or KES 30,000 per month (from Dec 2024). Deductible owner-occupied mortgage interest: up to KES 25,000 per month (pre-Dec 2024) or KES 30,000 per month (from Dec 2024). Deductible PRMF contribution: up to KES 15,000 per month (from Dec 2024).',
        'SHIF and Affordable Housing Levy (AHL) deductions are effective from December 2024.'
      )
    ),
    jsonb_build_object(
      'type','signature_block','title','Signatures',
      'slots', jsonb_build_array(
        jsonb_build_object('caption','Preparer','sub_caption','Name & Signature'),
        jsonb_build_object('caption','Date'),
        jsonb_build_object('caption','Employer Stamp')
      )
    )
  );

  UPDATE public.localization_pack_certificate_templates
     SET body = body
              || jsonb_build_object('schema_version', 2)
              || jsonb_build_object('blocks', _p9_blocks)
   WHERE pack_id = _ke_pack AND code IN ('P9','P9A');

  _cos_blocks := jsonb_build_array(
    jsonb_build_object(
      'type','field_grid','title','Employer','columns',2,'data_source','employer',
      'fields', jsonb_build_array(
        jsonb_build_object('key','name','label','Employer Name','emphasis','primary'),
        jsonb_build_object('key','address','label','Address'),
        jsonb_build_object('key','tax_pin','label','Employer KRA PIN')
      )
    ),
    jsonb_build_object(
      'type','field_grid','title','Employee','columns',2,'data_source','employee',
      'fields', jsonb_build_array(
        jsonb_build_object('key','full_name','label','Employee Name','emphasis','primary'),
        jsonb_build_object('key','employee_number','label','Employee Number'),
        jsonb_build_object('key','national_id','label','National ID'),
        jsonb_build_object('key','position','label','Position'),
        jsonb_build_object('key','department','label','Department')
      )
    ),
    jsonb_build_object(
      'type','field_grid','title','Final Year Earnings','columns',3,'data_source','totals',
      'fields', jsonb_build_array(
        jsonb_build_object('key','employee','label','Employee Deductions','format','currency'),
        jsonb_build_object('key','employer','label','Employer Contributions','format','currency'),
        jsonb_build_object('key','taxable','label','Taxable Income','format','currency','emphasis','primary')
      )
    ),
    jsonb_build_object(
      'type','notes','title','Certificate',
      'paragraphs', jsonb_build_array(
        'Issued in compliance with Section 51 of the Employment Act, 2007. This certificate is not a testimonial.'
      )
    ),
    jsonb_build_object(
      'type','signature_block','title','Signatures',
      'slots', jsonb_build_array(
        jsonb_build_object('caption','Preparer','sub_caption','Name & Signature'),
        jsonb_build_object('caption','Date'),
        jsonb_build_object('caption','Employer Stamp')
      )
    )
  );

  UPDATE public.localization_pack_certificate_templates
     SET body = body
              || jsonb_build_object('schema_version', 2)
              || jsonb_build_object('blocks', _cos_blocks)
   WHERE pack_id = _ke_pack AND code = 'CERT_OF_SERVICE';
END $$;

-- 3. Publish pack version bump so propose-localization-upgrades fans out.
INSERT INTO public.pack_versions (pack_id, version, status, changelog, published_at)
SELECT
  id,
  '2026.8.0',
  'published',
  jsonb_build_object(
    'adr','0060-refinement',
    'summary','Certificate templates migrated to v2 block-AST renderer.',
    'templates', jsonb_build_array('P9','P9A','CERT_OF_SERVICE')
  ),
  now()
FROM public.localization_packs
WHERE country_code='KE'
ON CONFLICT DO NOTHING;