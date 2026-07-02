
-- Round V6 cleanup: remove country-specific paths from the CORE token registry.
-- The core registry (pack_id IS NULL) must be country-agnostic — country
-- identifiers and rule codes belong in their respective pack registries
-- (e.g. the Kenya pack publishes `employee.nssf_number`, `run.paye`, etc.
-- with pack_id = <l10n_ke pack uuid>). Tenants are empty (0 orgs / 0
-- payslips), so this is safe to apply unconditionally.
DELETE FROM public.pack_token_registry
WHERE pack_id IS NULL
  AND token_path IN (
    'employee.nssf_number',
    'employee.shif_number',
    'run.paye'
  );
