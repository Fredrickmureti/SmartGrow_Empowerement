-- C-PAY-5 regression guard.
--
-- Fiscal rules belong in localization packs (`payroll_statutory_rules` rows
-- with `computation_method` + `parameters`), NOT in named SQL functions.
-- A previous prototype shipped `public.calculate_kenya_paye` and similar
-- country-named helpers. This test fails the build if any future migration
-- re-creates one.

BEGIN;
SELECT plan(2);

-- (1) The dead Kenya helper must not exist.
SELECT is(
  (SELECT count(*)::int FROM pg_proc p
   JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='calculate_kenya_paye'),
  0,
  'calculate_kenya_paye must be retired'
);

-- (2) No public-schema function may be named after a country or a
-- statutory rule code. Drive behaviour from rule.parameters instead.
SELECT is(
  (SELECT count(*)::int FROM pg_proc p
   JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname ~* '(_kenya|_uganda|_tanzania|_rwanda|_nigeria|_south_africa|_uk$|_usa|paye|^nhif|_nhif|^shif|_shif|nssf_employee|nssf_employer|housing_levy|^ahl_|_ahl$|^nita_|_nita$|kra_)'),
  0,
  'No public-schema function may be named after a country or statutory code (PAYE/NHIF/SHIF/NSSF/AHL/NITA/KRA/_kenya/_uk/...). Move the logic into a localization pack rule.'
);

SELECT * FROM finish();
ROLLBACK;
