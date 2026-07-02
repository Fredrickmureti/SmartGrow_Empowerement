INSERT INTO public.localization_packs (country_code, name, description, version, is_active, is_published)
SELECT v.country_code, v.name, v.description, '0.1.0', false, false
FROM (VALUES
  ('GH', 'Ghana Fiscal Localization', 'Skeleton pack for Ghana. Awaiting statutory rates (GRA PAYE, SSNIT, NHIL/GETFund) and returns templates.'),
  ('NG', 'Nigeria Fiscal Localization', 'Skeleton pack for Nigeria. Awaiting statutory rates (PAYE, PENCOM, NHF, NSITF, ITF) and returns templates.'),
  ('TZ', 'Tanzania Fiscal Localization', 'Skeleton pack for Tanzania. Awaiting statutory rates (PAYE, NSSF/PSSSF, NHIF, WCF, SDL) and returns templates.'),
  ('UG', 'Uganda Fiscal Localization', 'Skeleton pack for Uganda. Awaiting statutory rates (PAYE, NSSF, LST) and returns templates.'),
  ('ZA', 'South Africa Fiscal Localization', 'Skeleton pack for South Africa. Awaiting statutory rates (PAYE, UIF, SDL) and returns templates.')
) AS v(country_code, name, description)
WHERE NOT EXISTS (
  SELECT 1 FROM public.localization_packs p WHERE p.country_code = v.country_code
);