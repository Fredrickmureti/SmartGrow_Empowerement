-- Architecture Phase 2/3 cleanup: retire duplicate sources of truth and
-- remove the country-specific entry that leaked into the global registry.
--
-- See .lovable/plan.md (Phase 2 step 7, Phase 3 step 11).
--
-- 1) Drop legacy `payroll_statutory_rates` table.
--    The audit confirmed the live payroll engine does NOT read this table;
--    rg across src/ and supabase/functions/ returns zero references. The
--    canonical source of truth going forward is `payroll_statutory_rules`
--    (installed via the localization pack installer).
DROP TABLE IF EXISTS public.payroll_statutory_rates CASCADE;

-- 2) Remove the country-specific NITA role from the global system_account_roles
--    registry. NITA is a Kenya-only training levy; it must be installed by
--    the Kenya localization pack, not seeded into the global registry.
--    Eligibility rows (account_role_eligibility) referencing this role are
--    cleaned up to avoid orphaned FKs.
DELETE FROM public.account_role_eligibility
WHERE role_key = 'employer_nita_expense';

DELETE FROM public.system_account_template
WHERE role_key = 'employer_nita_expense';

DELETE FROM public.system_account_roles
WHERE role_key = 'employer_nita_expense';