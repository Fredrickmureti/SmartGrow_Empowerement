-- Payroll Phase F — close-out of the gaps surfaced by the 2026-06-01
-- verification re-audit (P3 + P4). Country-agnostic, idempotent.

-- ─── P3.1: pack_account_roles for KE ──────────────────────────────────
WITH ke AS (SELECT id FROM public.localization_packs WHERE country_code = 'KE')
INSERT INTO public.pack_account_roles
  (pack_id, role_key, display_name, account_type, detail_type, description, is_required)
SELECT ke.id, r.role_key, r.display_name, r.account_type, r.detail_type, r.description, r.is_required
FROM ke, (VALUES
  ('salary_expense',               'Salary & Wages Expense',         'expense',   'payroll_expense',       'Gross salary expense debited on payroll posting.',                         true),
  ('net_salary_payable',           'Net Salary Payable',             'liability', 'payroll_clearing',      'Net pay liability credited on payroll posting; cleared on disbursement.',  true),
  ('paye_payable',                 'PAYE Payable',                   'liability', 'statutory_liability',   'Pay-As-You-Earn income tax withheld from employees.',                      true),
  ('nssf_payable',                 'NSSF Payable',                   'liability', 'statutory_liability',   'Employee + employer NSSF contributions.',                                  true),
  ('shif_payable',                 'SHIF Payable',                   'liability', 'statutory_liability',   'Social Health Insurance Fund contributions.',                              true),
  ('housing_levy_payable',         'Housing Levy Payable',           'liability', 'statutory_liability',   'Affordable Housing Levy (employee + employer).',                           true),
  ('employer_nssf_expense',        'Employer NSSF Expense',          'expense',   'employer_contribution', 'Employer share of NSSF contributions.',                                    false),
  ('employer_shif_expense',        'Employer SHIF Expense',          'expense',   'employer_contribution', 'Employer share of SHIF contributions.',                                    false),
  ('employer_housing_levy_expense','Employer Housing Levy Expense',  'expense',   'employer_contribution', 'Employer share of Affordable Housing Levy.',                               false)
) AS r(role_key, display_name, account_type, detail_type, description, is_required)
ON CONFLICT (pack_id, role_key) DO NOTHING;

-- ─── P3.2: localization_pack_remittance_schedules for KE ─────────────
WITH ke AS (SELECT id FROM public.localization_packs WHERE country_code = 'KE')
INSERT INTO public.localization_pack_remittance_schedules
  (pack_id, rule_code, authority_name, frequency, due_day, liability_account_setting_key)
SELECT ke.id, r.rule_code, r.authority_name, r.frequency, r.due_day, r.liability_account_setting_key
FROM ke, (VALUES
  ('paye',         'Kenya Revenue Authority (KRA)',                 'monthly',  9::smallint, 'paye_payable'),
  ('nssf',         'National Social Security Fund (NSSF)',          'monthly',  9::smallint, 'nssf_payable'),
  ('shif',         'Social Health Authority (SHA)',                 'monthly',  9::smallint, 'shif_payable'),
  ('housing_levy', 'Kenya Revenue Authority (AHL)',                 'monthly',  9::smallint, 'housing_levy_payable'),
  ('nita',         'National Industrial Training Authority (NITA)', 'annual',   1::smallint, NULL)
) AS r(rule_code, authority_name, frequency, due_day, liability_account_setting_key)
ON CONFLICT DO NOTHING;

-- ─── P4.1: required role keys per skeleton pack ──────────────────────
INSERT INTO public.pack_account_roles
  (pack_id, role_key, display_name, account_type, detail_type, description, is_required)
SELECT p.id, r.role_key, r.display_name, r.account_type, r.detail_type,
       'Required role slot — populate code/name in pack template before publish.', true
FROM public.localization_packs p
CROSS JOIN (VALUES
  ('salary_expense',     'Salary & Wages Expense',  'expense',   'payroll_expense'),
  ('net_salary_payable', 'Net Salary Payable',      'liability', 'payroll_clearing'),
  ('paye_payable',       'PAYE Payable',            'liability', 'statutory_liability')
) AS r(role_key, display_name, account_type, detail_type)
WHERE p.country_code IN ('GH','NG','TZ','UG','ZA')
ON CONFLICT (pack_id, role_key) DO NOTHING;

-- Per-country social-security liability role key
INSERT INTO public.pack_account_roles
  (pack_id, role_key, display_name, account_type, detail_type, description, is_required)
SELECT p.id, m.role_key, m.display_name, 'liability', 'statutory_liability',
       'Required statutory liability slot — populate before publish.', true
FROM public.localization_packs p
JOIN (VALUES
  ('GH', 'ssnit_payable',  'SSNIT Payable'),
  ('NG', 'pencom_payable', 'PENCOM Payable'),
  ('TZ', 'nssf_payable',   'NSSF Payable'),
  ('UG', 'nssf_payable',   'NSSF Payable'),
  ('ZA', 'uif_payable',    'UIF Payable')
) AS m(country_code, role_key, display_name) ON m.country_code = p.country_code
ON CONFLICT (pack_id, role_key) DO NOTHING;

-- ─── P4.2: PLACEHOLDER account templates for skeleton packs ─────────
INSERT INTO public.localization_pack_account_templates
  (pack_id, code, name, account_type, detail_type, role_key, description, is_system, sort_order)
SELECT par.pack_id,
       'PLACEHOLDER-' || p.country_code || '-' || par.role_key,
       'PLACEHOLDER — ' || par.display_name || ' (' || p.country_code || ')',
       par.account_type, par.detail_type, par.role_key,
       'PLACEHOLDER — replace code/name with the pack-defined chart of accounts entry before publish.',
       false, 0
FROM public.pack_account_roles par
JOIN public.localization_packs p ON p.id = par.pack_id
WHERE p.country_code IN ('GH','NG','TZ','UG','ZA')
  AND NOT EXISTS (
    SELECT 1 FROM public.localization_pack_account_templates t
    WHERE t.pack_id = par.pack_id AND t.role_key = par.role_key
  );

-- ─── P4.3: country statutory-ID tokens ──────────────────────────────
INSERT INTO public.pack_token_registry
  (pack_id, token_path, source, data_type, description)
SELECT p.id, t.token_path, t.source, t.data_type, t.description
FROM public.localization_packs p
JOIN (VALUES
  ('GH', 'employee.tin',           'employee_statutory_identifiers', 'string', 'Ghana Tax Identification Number (GRA)'),
  ('GH', 'employee.ssnit_number',  'employee_statutory_identifiers', 'string', 'SSNIT membership number'),
  ('NG', 'employee.tin',           'employee_statutory_identifiers', 'string', 'Nigeria Taxpayer Identification Number (FIRS/State IRS)'),
  ('NG', 'employee.pencom_number', 'employee_statutory_identifiers', 'string', 'PENCOM PIN / RSA'),
  ('TZ', 'employee.tin',           'employee_statutory_identifiers', 'string', 'Tanzania Tax Identification Number (TRA)'),
  ('TZ', 'employee.nssf_number',   'employee_statutory_identifiers', 'string', 'NSSF / PSSSF membership number'),
  ('UG', 'employee.tin',           'employee_statutory_identifiers', 'string', 'Uganda Tax Identification Number (URA)'),
  ('UG', 'employee.nssf_number',   'employee_statutory_identifiers', 'string', 'NSSF membership number'),
  ('ZA', 'employee.tax_reference', 'employee_statutory_identifiers', 'string', 'SARS Income Tax Reference Number'),
  ('ZA', 'employee.uif_number',    'employee_statutory_identifiers', 'string', 'UIF reference number')
) AS t(country_code, token_path, source, data_type, description) ON t.country_code = p.country_code
WHERE NOT EXISTS (
  SELECT 1 FROM public.pack_token_registry r
  WHERE r.pack_id = p.id AND r.token_path = t.token_path
);

-- ─── P4.4: PLACEHOLDER remittance schedule slots ────────────────────
INSERT INTO public.localization_pack_remittance_schedules
  (pack_id, rule_code, authority_name, frequency, due_day, liability_account_setting_key)
SELECT p.id, s.rule_code, s.authority_name, 'monthly', NULL::smallint, s.liability_account_setting_key
FROM public.localization_packs p
JOIN (VALUES
  ('GH', 'paye',  'Ghana Revenue Authority (GRA) — PLACEHOLDER',           'paye_payable'),
  ('GH', 'ssnit', 'Social Security & National Insurance Trust — PLACEHOLDER','ssnit_payable'),
  ('NG', 'paye',  'State Internal Revenue Service — PLACEHOLDER',          'paye_payable'),
  ('NG', 'pencom','National Pension Commission — PLACEHOLDER',             'pencom_payable'),
  ('TZ', 'paye',  'Tanzania Revenue Authority (TRA) — PLACEHOLDER',        'paye_payable'),
  ('TZ', 'nssf',  'NSSF / PSSSF — PLACEHOLDER',                            'nssf_payable'),
  ('UG', 'paye',  'Uganda Revenue Authority (URA) — PLACEHOLDER',          'paye_payable'),
  ('UG', 'nssf',  'National Social Security Fund — PLACEHOLDER',           'nssf_payable'),
  ('ZA', 'paye',  'South African Revenue Service (SARS) — PLACEHOLDER',    'paye_payable'),
  ('ZA', 'uif',   'UIF Commissioner — PLACEHOLDER',                        'uif_payable')
) AS s(country_code, rule_code, authority_name, liability_account_setting_key) ON s.country_code = p.country_code
WHERE NOT EXISTS (
  SELECT 1 FROM public.localization_pack_remittance_schedules r
  WHERE r.pack_id = p.id AND r.rule_code = s.rule_code
);

-- ─── P4 guard: block publish while PLACEHOLDER rows remain ──────────
CREATE OR REPLACE FUNCTION public.guard_pack_publish_no_placeholders()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _placeholder_accounts int;
  _placeholder_remit    int;
BEGIN
  IF NEW.is_published = true AND COALESCE(OLD.is_published, false) = false THEN
    SELECT count(*) INTO _placeholder_accounts
      FROM public.localization_pack_account_templates
     WHERE pack_id = NEW.id
       AND (code LIKE 'PLACEHOLDER%' OR name LIKE 'PLACEHOLDER%');

    SELECT count(*) INTO _placeholder_remit
      FROM public.localization_pack_remittance_schedules
     WHERE pack_id = NEW.id
       AND authority_name LIKE '%PLACEHOLDER%';

    IF _placeholder_accounts > 0 OR _placeholder_remit > 0 THEN
      RAISE EXCEPTION 'Cannot publish localization pack % (%): % placeholder account template(s) and % placeholder remittance schedule(s) remain. Populate them with country-specific data first.',
        NEW.name, NEW.country_code, _placeholder_accounts, _placeholder_remit
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_pack_publish_no_placeholders ON public.localization_packs;
CREATE TRIGGER trg_guard_pack_publish_no_placeholders
  BEFORE UPDATE ON public.localization_packs
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_pack_publish_no_placeholders();

COMMENT ON FUNCTION public.guard_pack_publish_no_placeholders() IS
  'Phase F (P4 guard): refuses to flip a localization pack to is_published=true while any child row is still a PLACEHOLDER. Country-agnostic — inspects account templates + remittance schedules only.';