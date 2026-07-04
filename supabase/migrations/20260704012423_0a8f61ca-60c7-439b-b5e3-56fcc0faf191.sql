-- ADR 0057: Remove Kenya-specific statutory role keys from country-agnostic core registry.
-- Pack-scoped copies in pack_account_roles are also cleared so the Kenya localization pack
-- can re-declare them cleanly (per user instruction — payroll module will recreate).
DO $$
DECLARE
  kenya_role_keys text[] := ARRAY[
    'mpesa','paye_payable','nssf_payable','shif_payable','nhif_payable',
    'housing_levy_payable','nita_payable','employer_nssf_expense',
    'employer_shif_expense','employer_nhif_expense',
    'employer_housing_levy_expense','employer_nita_expense'
  ];
BEGIN
  ALTER TABLE public.accounts DISABLE TRIGGER USER;
  UPDATE public.accounts
     SET system_role = NULL, is_system = false
   WHERE system_role = ANY(kenya_role_keys);
  ALTER TABLE public.accounts ENABLE TRIGGER USER;

  DELETE FROM public.pack_account_roles              WHERE role_key = ANY(kenya_role_keys);
  DELETE FROM public.localization_pack_account_templates WHERE role_key = ANY(kenya_role_keys);
  DELETE FROM public.account_role_eligibility        WHERE role_key = ANY(kenya_role_keys);
  DELETE FROM public.system_account_template         WHERE role_key = ANY(kenya_role_keys);
  DELETE FROM public.default_chart_of_accounts       WHERE role_key = ANY(kenya_role_keys);
  DELETE FROM public.system_account_roles            WHERE role_key = ANY(kenya_role_keys);
END $$;