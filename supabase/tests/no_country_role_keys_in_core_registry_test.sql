-- ADR 0057 regression guard.
--
-- `system_account_roles` is the country-agnostic core role registry.
-- Country-specific role keys belong in `pack_account_roles` (pack-scoped)
-- and are surfaced to consumers via the `v_account_roles` union view.
--
-- This test fails the build if a future migration inserts a role_key
-- into `system_account_roles` that matches the country deny-list, or
-- names a role after a specific jurisdiction.

BEGIN;
SELECT plan(2);

-- (1) No country-specific role keys in the core registry.
SELECT is(
  (SELECT count(*)::int FROM public.system_account_roles
   WHERE role_key ~* '(nita|paye|shif|ahl|nssf|nhif|^kra_|_kra$|_sha_|payg|_usc|_sdl)'),
  0,
  'system_account_roles must contain only country-agnostic role keys. '
  'Country-specific keys belong in pack_account_roles (see ADR 0057).'
);

-- (2) No role labels tied to a specific jurisdiction.
SELECT is(
  (SELECT count(*)::int FROM public.system_account_roles
   WHERE label ~* '(kenya|uganda|tanzania|rwanda|nigeria|south africa|\bUK\b|USA|NITA|PAYE|NSSF|SHIF|NHIF|AHL|KRA|SHA)'),
  0,
  'system_account_roles.label must not name a country or statutory scheme. '
  'Move the row into a pack (pack_account_roles) per ADR 0057.'
);

SELECT * FROM finish();
ROLLBACK;