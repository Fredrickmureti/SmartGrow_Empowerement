
DO $$
DECLARE
  v_pack_id uuid := 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  v_new_version text := '2026.1.1';
  v_prev_version text := '2026.1.0';
  v_prev_version_id uuid;
  v_new_version_id uuid;
  v_snapshot jsonb;
  v_changelog jsonb;
  v_diff jsonb;
  v_hash text;
BEGIN
  IF EXISTS (SELECT 1 FROM pack_versions WHERE pack_id = v_pack_id AND version = v_new_version) THEN
    RAISE NOTICE 'Pack version % already exists — skipping.', v_new_version;
    RETURN;
  END IF;

  SELECT id INTO v_prev_version_id
    FROM pack_versions WHERE pack_id = v_pack_id AND version = v_prev_version
    ORDER BY published_at DESC NULLS LAST LIMIT 1;

  SELECT jsonb_build_object(
    'localization_packs', (SELECT to_jsonb(p) FROM localization_packs p WHERE p.id = v_pack_id),
    'statutory_authorities', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.code) FROM statutory_authorities t WHERE t.pack_id = v_pack_id), '[]'::jsonb),
    'payroll_statutory_rules', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.rule_code) FROM payroll_statutory_rules t WHERE t.country_code = 'KE'), '[]'::jsonb),
    'localization_pack_return_templates', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.code) FROM localization_pack_return_templates t WHERE t.pack_id = v_pack_id), '[]'::jsonb),
    'localization_pack_certificate_templates', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.code) FROM localization_pack_certificate_templates t WHERE t.pack_id = v_pack_id), '[]'::jsonb),
    'localization_pack_remittance_schedules', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM localization_pack_remittance_schedules t WHERE t.pack_id = v_pack_id), '[]'::jsonb),
    'localization_pack_garnishment_kinds', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.code) FROM localization_pack_garnishment_kinds t WHERE t.pack_id = v_pack_id), '[]'::jsonb),
    'localization_pack_garnishment_policies', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM localization_pack_garnishment_policies t WHERE t.pack_id = v_pack_id), '[]'::jsonb),
    'localization_pack_account_templates', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM localization_pack_account_templates t WHERE t.pack_id = v_pack_id), '[]'::jsonb),
    'localization_pack_tax_templates', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM localization_pack_tax_templates t WHERE t.pack_id = v_pack_id), '[]'::jsonb),
    'localization_pack_bank_export_templates', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM localization_pack_bank_export_templates t WHERE t.pack_id = v_pack_id), '[]'::jsonb),
    'localization_pack_payroll_templates', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM localization_pack_payroll_templates t WHERE t.pack_id = v_pack_id), '[]'::jsonb),
    'pack_account_roles', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM pack_account_roles t WHERE t.pack_id = v_pack_id), '[]'::jsonb),
    'pack_requirements', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM pack_requirements t WHERE t.pack_id = v_pack_id), '[]'::jsonb)
  ) INTO v_snapshot;

  v_hash := encode(digest(v_snapshot::text, 'sha256'), 'hex');

  v_changelog := jsonb_build_object(
    'summary', 'Kenya pack completion: HELB authority + return, garnishment kinds & §19(3) policy, return submission metadata backfill.',
    'highlights', jsonb_build_array(
      'Added HELB (Higher Education Loans Board) statutory authority with portal + e-filing endpoint.',
      'Added HELB_LR monthly loan repayment return template (CSV, due day 15 of following month).',
      'Backfilled submission_channel, submission_format, legal_reference, regulation_citation, effective_date, acknowledgement_spec on 7 existing return templates (P10, P10A, P10D, AHL_RET, NSSF_RET, SHIF_RET, NITA_RET).',
      'Populated portal_url and e_filing_endpoint on KRA, NSSF, SHA, NITA authorities.',
      'Seeded 6 garnishment kinds: child_maintenance, kra_agency_notice, court_attachment, helb_recovery, sacco_checkoff, employer_advance.',
      'Seeded default garnishment policy implementing Employment Act 2007 §19(3) two-thirds aggregate cap with one-third protected-earnings floor.'
    ),
    'legal_basis', jsonb_build_array(
      'Income Tax Act Cap 470 §37', 'Tax Procedures Act 2015 §17/§42',
      'NSSF Act 2013', 'Social Health Insurance Act 2023 + SHIF Regs 2024',
      'Affordable Housing Act 2024 §4', 'Industrial Training Act Cap 237 §5B',
      'HELB Act 1995 §15', 'Employment Act 2007 §19', 'Children Act 2022',
      'Co-operative Societies Act §35A'
    )
  );

  v_diff := jsonb_build_object(
    'added', jsonb_build_object(
      'statutory_authorities', jsonb_build_array('HIGHER_EDUCATION_LOANS_BOARD'),
      'return_templates', jsonb_build_array('HELB_LR'),
      'garnishment_kinds', jsonb_build_array(
        'child_maintenance','kra_agency_notice','court_attachment',
        'helb_recovery','sacco_checkoff','employer_advance'
      ),
      'garnishment_policies', jsonb_build_array('default')
    ),
    'modified', jsonb_build_object(
      'statutory_authorities', jsonb_build_array('KRA','NSSF','SHA','NITA'),
      'return_templates', jsonb_build_array('P10','P10A','P10D','AHL_RET','NSSF_RET','SHIF_RET','NITA_RET')
    ),
    'removed', jsonb_build_object()
  );

  INSERT INTO pack_versions (
    pack_id, version, status, changelog, snapshot, published_at, published_by,
    parent_version_id, content_hash, schema_version
  ) VALUES (
    v_pack_id, v_new_version, 'published', v_changelog, v_snapshot, now(), NULL,
    v_prev_version_id, v_hash, 1
  )
  RETURNING id INTO v_new_version_id;

  UPDATE localization_packs
     SET version = v_new_version, updated_at = now()
   WHERE id = v_pack_id;

  INSERT INTO pack_upgrade_proposals (
    organization_id, business_id, pack_id, from_version, to_version, diff, status, created_at
  )
  SELECT DISTINCT
    i.organization_id, i.business_id, v_pack_id, i.pack_version, v_new_version, v_diff, 'pending', now()
  FROM installed_localization_packs i
  WHERE i.pack_id = v_pack_id
    AND i.pack_version = v_prev_version
    AND NOT EXISTS (
      SELECT 1 FROM pack_upgrade_proposals p
       WHERE p.pack_id = v_pack_id
         AND p.organization_id = i.organization_id
         AND COALESCE(p.business_id::text,'') = COALESCE(i.business_id::text,'')
         AND p.to_version = v_new_version
         AND p.status = 'pending'
    );

  RAISE NOTICE 'Published pack version % (id=%) with snapshot hash %.', v_new_version, v_new_version_id, v_hash;
END $$;
