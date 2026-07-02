
-- 1. Delete statutory rows from the global seed.
DELETE FROM public.default_chart_of_accounts
WHERE lower(account_name) LIKE '%nhif%'
   OR lower(account_name) LIKE '%shif%'
   OR lower(account_name) LIKE '%paye%'
   OR lower(account_name) LIKE '%nssf%'
   OR lower(account_name) LIKE '%housing levy%'
   OR lower(account_name) LIKE '%uif payable%'
   OR lower(account_name) LIKE '%cpf payable%'
   OR lower(account_name) LIKE '%epf payable%'
   OR lower(account_name) LIKE '%provident fund%'
   OR lower(account_name) LIKE '%esic%'
   OR lower(account_name) LIKE '%pf payable%';

-- 2. Now safe to add the CHECK constraint.
ALTER TABLE public.default_chart_of_accounts
  DROP CONSTRAINT IF EXISTS default_coa_no_statutory;
ALTER TABLE public.default_chart_of_accounts
  ADD CONSTRAINT default_coa_no_statutory
  CHECK (
    lower(account_name) NOT LIKE '%nhif%'
    AND lower(account_name) NOT LIKE '%shif%'
    AND lower(account_name) NOT LIKE '%paye%'
    AND lower(account_name) NOT LIKE '%nssf%'
    AND lower(account_name) NOT LIKE '%housing levy%'
    AND lower(account_name) NOT LIKE '%uif payable%'
    AND lower(account_name) NOT LIKE '%cpf payable%'
    AND lower(account_name) NOT LIKE '%epf payable%'
    AND lower(account_name) NOT LIKE '%provident fund%'
    AND lower(account_name) NOT LIKE '%esic%'
    AND lower(account_name) NOT LIKE '%pf payable%'
  );

-- 3. Repair existing organizations.
DO $repair$
DECLARE
  _r record;
  _has_postings boolean;
  _new_name text;
BEGIN
  -- Drop bogus default_account_settings mappings to statutory accounts
  FOR _r IN
    SELECT d.id, d.setting_key, d.account_id, a.name
    FROM public.default_account_settings d
    JOIN public.accounts a ON a.id = d.account_id
    WHERE (lower(a.name) LIKE '%nhif%'
        OR lower(a.name) LIKE '%paye%'
        OR lower(a.name) LIKE '%nssf%'
        OR lower(a.name) LIKE '%housing levy%'
        OR lower(a.name) LIKE '%uif payable%'
        OR lower(a.name) LIKE '%cpf payable%'
        OR lower(a.name) LIKE '%epf payable%')
      AND d.setting_key NOT IN (
        'paye_payable','nssf_payable','shif_payable','housing_levy_payable',
        'employer_nssf_expense','employer_shif_expense','employer_housing_levy_expense'
      )
  LOOP
    INSERT INTO public.account_change_audit_log
      (account_id, change_type, old_value, reason)
    VALUES (_r.account_id, 'system_repair',
      jsonb_build_object('setting_key', _r.setting_key, 'account_name', _r.name),
      'Removed bogus default_account_settings mapping to statutory account during COA overhaul');
    DELETE FROM public.default_account_settings WHERE id = _r.id;
  END LOOP;

  -- Statutory accounts in the wild: rename + archive (no postings) or archive only (has postings)
  FOR _r IN
    SELECT a.id, a.organization_id, a.business_id, a.code, a.name, a.is_active
    FROM public.accounts a
    WHERE (lower(a.name) LIKE '%nhif%'
        OR lower(a.name) LIKE '%paye%'
        OR lower(a.name) LIKE '%nssf%'
        OR lower(a.name) LIKE '%housing levy%'
        OR lower(a.name) LIKE '%uif payable%'
        OR lower(a.name) LIKE '%cpf payable%'
        OR lower(a.name) LIKE '%epf payable%')
      AND lower(a.name) NOT LIKE '%shif%'
      AND lower(a.name) NOT LIKE '%(legacy%'
  LOOP
    SELECT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE account_id = _r.id) INTO _has_postings;

    IF _has_postings THEN
      IF _r.is_active THEN
        UPDATE public.accounts SET is_active = false WHERE id = _r.id;
      END IF;
    ELSE
      _new_name := _r.name || ' (legacy — install country localization pack)';
      UPDATE public.accounts
      SET name = _new_name, is_active = false
      WHERE id = _r.id;
    END IF;
  END LOOP;
END $repair$;
