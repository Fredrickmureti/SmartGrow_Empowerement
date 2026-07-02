-- =========================================================================
-- Wave HR-Payroll-Fin Hardening Phase 2 — Posting Invariants (retry)
-- Uses existing detail_type catalog entries: payroll_tax_payable,
-- payroll_clearing, payroll_expense, payroll_tax_expense.
-- =========================================================================

-- ---------- 1. Policy table ----------------------------------------------
CREATE TABLE IF NOT EXISTS public.payroll_account_role_policy (
  setting_key_pattern text PRIMARY KEY,
  allowed_account_types text[] NOT NULL,
  denied_detail_types text[] NOT NULL DEFAULT ARRAY[]::text[],
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.payroll_account_role_policy ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payroll_account_role_policy readable" ON public.payroll_account_role_policy;
CREATE POLICY "payroll_account_role_policy readable"
  ON public.payroll_account_role_policy
  FOR SELECT
  TO authenticated
  USING (true);

INSERT INTO public.payroll_account_role_policy
  (setting_key_pattern, allowed_account_types, denied_detail_types, description)
VALUES
  ('salary_expense',            ARRAY['expense'],   ARRAY['cost_of_goods_sold'], 'Gross salary expense must be a payroll/operating expense, never COGS.'),
  ('%\_employer\_expense',      ARRAY['expense'],   ARRAY['cost_of_goods_sold'], 'Employer statutory contribution expense must be an operating expense, never COGS.'),
  ('%\_payable',                ARRAY['liability'], ARRAY['accounts_payable'],   'Statutory payable must be a dedicated payroll-liability account, never generic AP.'),
  ('net_salary_payable',        ARRAY['liability'], ARRAY['accounts_payable'],   'Net pay clearing must be a dedicated payroll liability, never generic AP.')
ON CONFLICT (setting_key_pattern) DO UPDATE
  SET allowed_account_types = EXCLUDED.allowed_account_types,
      denied_detail_types   = EXCLUDED.denied_detail_types,
      description           = EXCLUDED.description;

-- ---------- 2. Extended mapping role assertion ---------------------------
CREATE OR REPLACE FUNCTION public._payroll_assert_mapping_role(
  _setting_key text,
  _account_id uuid
) RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_acct   public.accounts%ROWTYPE;
  v_policy public.payroll_account_role_policy%ROWTYPE;
  v_matched boolean := false;
BEGIN
  IF _setting_key IS NULL OR _account_id IS NULL THEN RETURN; END IF;

  SELECT * INTO v_acct FROM public.accounts WHERE id = _account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: account % not found', _account_id
      USING ERRCODE = '22023';
  END IF;

  IF COALESCE(v_acct.is_header, false) THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % cannot map to a header / parent account (%)',
      _setting_key, v_acct.code USING ERRCODE = '22023';
  END IF;

  FOR v_policy IN
    SELECT *
    FROM public.payroll_account_role_policy p
    WHERE _setting_key LIKE p.setting_key_pattern ESCAPE '\'
  LOOP
    v_matched := true;

    IF NOT (v_acct.account_type::text = ANY (v_policy.allowed_account_types)) THEN
      RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % requires account_type in %, got % (%)',
        _setting_key, v_policy.allowed_account_types, v_acct.account_type, v_acct.code
        USING ERRCODE = '22023';
    END IF;

    IF v_acct.detail_type IS NOT NULL
       AND v_acct.detail_type = ANY (v_policy.denied_detail_types) THEN
      RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % cannot map to detail_type % (account %)',
        _setting_key, v_acct.detail_type, v_acct.code
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  IF NOT v_matched
     AND (_setting_key = 'salary_expense' OR _setting_key LIKE '%\_employer\_expense' ESCAPE '\')
     AND public._payroll_is_cogs_account(_account_id) THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % cannot map to a Cost of Goods Sold / Cost of Sales account (%)',
      _setting_key, v_acct.code USING ERRCODE = '22023';
  END IF;
END;
$function$;

-- ---------- 3 + 4. Provision + repoint -----------------------------------
DO $$
DECLARE
  r RECORD;
  v_salary_id uuid;
  v_paye_id   uuid;
  v_nssf_id   uuid;
  v_shif_id   uuid;
  v_ahl_id    uuid;
  v_nita_id   uuid;
  v_generic_payable_id uuid;
  v_netpay_id uuid;
  v_emp_nssf_id uuid;
  v_emp_shif_id uuid;
  v_emp_ahl_id  uuid;
  v_emp_nita_id uuid;
  v_emp_generic_id uuid;
BEGIN
  PERFORM set_config('app.bypass_org_lock', 'on', true);

  FOR r IN
    SELECT DISTINCT das.organization_id, das.business_id
    FROM public.default_account_settings das
    JOIN public.accounts a ON a.id = das.account_id
    WHERE (das.setting_key = 'salary_expense'
           OR das.setting_key LIKE '%\_payable' ESCAPE '\'
           OR das.setting_key LIKE '%\_employer\_expense' ESCAPE '\')
      AND das.setting_key <> 'accounts_payable'
      AND (
            COALESCE(a.is_header, false)
         OR a.detail_type = 'cost_of_goods_sold'
         OR a.detail_type = 'accounts_payable'
         OR a.account_type::text NOT IN ('expense','liability')
          )
  LOOP
    -- Liability provisioning
    SELECT id INTO v_paye_id FROM public.accounts WHERE business_id = r.business_id AND code = '2140' LIMIT 1;
    IF v_paye_id IS NULL THEN
      INSERT INTO public.accounts (organization_id, business_id, account_type, code, name, detail_type, is_header, is_system, description)
      VALUES (r.organization_id, r.business_id, 'liability', '2140', 'PAYE Payable', 'payroll_tax_payable', false, true, 'Auto-provisioned by payroll hardening Phase 2')
      RETURNING id INTO v_paye_id;
    END IF;

    SELECT id INTO v_nssf_id FROM public.accounts WHERE business_id = r.business_id AND code = '2150' LIMIT 1;
    IF v_nssf_id IS NULL THEN
      INSERT INTO public.accounts (organization_id, business_id, account_type, code, name, detail_type, is_header, is_system, description)
      VALUES (r.organization_id, r.business_id, 'liability', '2150', 'NSSF Payable', 'payroll_tax_payable', false, true, 'Auto-provisioned by payroll hardening Phase 2')
      RETURNING id INTO v_nssf_id;
    END IF;

    SELECT id INTO v_shif_id FROM public.accounts WHERE business_id = r.business_id AND code = '2160' LIMIT 1;
    IF v_shif_id IS NULL THEN
      INSERT INTO public.accounts (organization_id, business_id, account_type, code, name, detail_type, is_header, is_system, description)
      VALUES (r.organization_id, r.business_id, 'liability', '2160', 'SHIF Payable', 'payroll_tax_payable', false, true, 'Auto-provisioned by payroll hardening Phase 2')
      RETURNING id INTO v_shif_id;
    END IF;

    SELECT id INTO v_ahl_id FROM public.accounts WHERE business_id = r.business_id AND code = '2170' LIMIT 1;
    IF v_ahl_id IS NULL THEN
      INSERT INTO public.accounts (organization_id, business_id, account_type, code, name, detail_type, is_header, is_system, description)
      VALUES (r.organization_id, r.business_id, 'liability', '2170', 'Affordable Housing Levy Payable', 'payroll_tax_payable', false, true, 'Auto-provisioned by payroll hardening Phase 2')
      RETURNING id INTO v_ahl_id;
    END IF;

    SELECT id INTO v_nita_id FROM public.accounts WHERE business_id = r.business_id AND code = '2175' LIMIT 1;
    IF v_nita_id IS NULL THEN
      INSERT INTO public.accounts (organization_id, business_id, account_type, code, name, detail_type, is_header, is_system, description)
      VALUES (r.organization_id, r.business_id, 'liability', '2175', 'NITA Payable', 'payroll_tax_payable', false, true, 'Auto-provisioned by payroll hardening Phase 2')
      RETURNING id INTO v_nita_id;
    END IF;

    SELECT id INTO v_netpay_id FROM public.accounts WHERE business_id = r.business_id AND code = '2190' LIMIT 1;
    IF v_netpay_id IS NULL THEN
      INSERT INTO public.accounts (organization_id, business_id, account_type, code, name, detail_type, is_header, is_system, description)
      VALUES (r.organization_id, r.business_id, 'liability', '2190', 'Net Salary Payable', 'payroll_clearing', false, true, 'Auto-provisioned by payroll hardening Phase 2')
      RETURNING id INTO v_netpay_id;
    END IF;

    SELECT id INTO v_generic_payable_id FROM public.accounts WHERE business_id = r.business_id AND code = '2199' LIMIT 1;
    IF v_generic_payable_id IS NULL THEN
      INSERT INTO public.accounts (organization_id, business_id, account_type, code, name, detail_type, is_header, is_system, description)
      VALUES (r.organization_id, r.business_id, 'liability', '2199', 'Other Payroll Liabilities', 'payroll_tax_payable', false, true, 'Auto-provisioned by payroll hardening Phase 2')
      RETURNING id INTO v_generic_payable_id;
    END IF;

    -- Expense provisioning
    SELECT id INTO v_salary_id FROM public.accounts
     WHERE business_id = r.business_id AND code = '6110' AND COALESCE(is_header,false) = false LIMIT 1;
    IF v_salary_id IS NULL THEN
      SELECT id INTO v_salary_id FROM public.accounts
       WHERE business_id = r.business_id AND code = '6100' AND COALESCE(is_header,false) = false LIMIT 1;
    END IF;
    IF v_salary_id IS NULL THEN
      INSERT INTO public.accounts (organization_id, business_id, account_type, code, name, detail_type, is_header, is_system, description)
      VALUES (r.organization_id, r.business_id, 'expense', '6110', 'Staff Salaries', 'payroll_expense', false, true, 'Auto-provisioned by payroll hardening Phase 2')
      RETURNING id INTO v_salary_id;
    END IF;

    SELECT id INTO v_emp_nssf_id FROM public.accounts WHERE business_id = r.business_id AND code = '6150' LIMIT 1;
    IF v_emp_nssf_id IS NULL THEN
      INSERT INTO public.accounts (organization_id, business_id, account_type, code, name, detail_type, is_header, is_system, description)
      VALUES (r.organization_id, r.business_id, 'expense', '6150', 'NSSF Employer Contribution', 'payroll_tax_expense', false, true, 'Auto-provisioned by payroll hardening Phase 2')
      RETURNING id INTO v_emp_nssf_id;
    END IF;

    SELECT id INTO v_emp_shif_id FROM public.accounts WHERE business_id = r.business_id AND code = '6160' LIMIT 1;
    IF v_emp_shif_id IS NULL THEN
      INSERT INTO public.accounts (organization_id, business_id, account_type, code, name, detail_type, is_header, is_system, description)
      VALUES (r.organization_id, r.business_id, 'expense', '6160', 'SHIF Employer Contribution', 'payroll_tax_expense', false, true, 'Auto-provisioned by payroll hardening Phase 2')
      RETURNING id INTO v_emp_shif_id;
    END IF;

    SELECT id INTO v_emp_ahl_id FROM public.accounts WHERE business_id = r.business_id AND code = '6170' LIMIT 1;
    IF v_emp_ahl_id IS NULL THEN
      INSERT INTO public.accounts (organization_id, business_id, account_type, code, name, detail_type, is_header, is_system, description)
      VALUES (r.organization_id, r.business_id, 'expense', '6170', 'AHL Employer Contribution', 'payroll_tax_expense', false, true, 'Auto-provisioned by payroll hardening Phase 2')
      RETURNING id INTO v_emp_ahl_id;
    END IF;

    SELECT id INTO v_emp_nita_id FROM public.accounts WHERE business_id = r.business_id AND code = '6175' LIMIT 1;
    IF v_emp_nita_id IS NULL THEN
      INSERT INTO public.accounts (organization_id, business_id, account_type, code, name, detail_type, is_header, is_system, description)
      VALUES (r.organization_id, r.business_id, 'expense', '6175', 'NITA Employer Contribution', 'payroll_tax_expense', false, true, 'Auto-provisioned by payroll hardening Phase 2')
      RETURNING id INTO v_emp_nita_id;
    END IF;

    SELECT id INTO v_emp_generic_id FROM public.accounts WHERE business_id = r.business_id AND code = '6199' LIMIT 1;
    IF v_emp_generic_id IS NULL THEN
      INSERT INTO public.accounts (organization_id, business_id, account_type, code, name, detail_type, is_header, is_system, description)
      VALUES (r.organization_id, r.business_id, 'expense', '6199', 'Other Payroll Employer Expense', 'payroll_tax_expense', false, true, 'Auto-provisioned by payroll hardening Phase 2')
      RETURNING id INTO v_emp_generic_id;
    END IF;

    -- Repoint dirty rows
    UPDATE public.default_account_settings SET account_id = v_salary_id
     WHERE organization_id = r.organization_id AND business_id = r.business_id
       AND setting_key = 'salary_expense';

    UPDATE public.default_account_settings SET account_id = v_netpay_id
     WHERE organization_id = r.organization_id AND business_id = r.business_id
       AND setting_key = 'net_salary_payable';

    UPDATE public.default_account_settings SET account_id = v_paye_id
     WHERE organization_id = r.organization_id AND business_id = r.business_id
       AND setting_key LIKE 'paye%_payable';

    UPDATE public.default_account_settings SET account_id = v_nssf_id
     WHERE organization_id = r.organization_id AND business_id = r.business_id
       AND setting_key LIKE 'nssf%_payable';

    UPDATE public.default_account_settings SET account_id = v_shif_id
     WHERE organization_id = r.organization_id AND business_id = r.business_id
       AND (setting_key LIKE 'shif%_payable' OR setting_key LIKE 'nhif%_payable' OR setting_key LIKE 'sha%_payable');

    UPDATE public.default_account_settings SET account_id = v_ahl_id
     WHERE organization_id = r.organization_id AND business_id = r.business_id
       AND (setting_key LIKE 'ahl%_payable' OR setting_key LIKE 'affordable_housing%_payable' OR setting_key LIKE 'housing_levy%_payable');

    UPDATE public.default_account_settings SET account_id = v_nita_id
     WHERE organization_id = r.organization_id AND business_id = r.business_id
       AND setting_key LIKE 'nita%_payable';

    UPDATE public.default_account_settings das SET account_id = v_generic_payable_id
      FROM public.accounts a
     WHERE das.organization_id = r.organization_id AND das.business_id = r.business_id
       AND das.setting_key LIKE '%\_payable' ESCAPE '\'
       AND das.setting_key <> 'accounts_payable'
       AND a.id = das.account_id
       AND (a.detail_type = 'accounts_payable' OR COALESCE(a.is_header,false));

    UPDATE public.default_account_settings SET account_id = v_emp_nssf_id
     WHERE organization_id = r.organization_id AND business_id = r.business_id
       AND setting_key LIKE 'nssf%_employer_expense';

    UPDATE public.default_account_settings SET account_id = v_emp_shif_id
     WHERE organization_id = r.organization_id AND business_id = r.business_id
       AND (setting_key LIKE 'shif%_employer_expense' OR setting_key LIKE 'nhif%_employer_expense' OR setting_key LIKE 'sha%_employer_expense');

    UPDATE public.default_account_settings SET account_id = v_emp_ahl_id
     WHERE organization_id = r.organization_id AND business_id = r.business_id
       AND (setting_key LIKE 'ahl%_employer_expense' OR setting_key LIKE 'affordable_housing%_employer_expense' OR setting_key LIKE 'housing_levy%_employer_expense');

    UPDATE public.default_account_settings SET account_id = v_emp_nita_id
     WHERE organization_id = r.organization_id AND business_id = r.business_id
       AND setting_key LIKE 'nita%_employer_expense';

    UPDATE public.default_account_settings das SET account_id = v_emp_generic_id
      FROM public.accounts a
     WHERE das.organization_id = r.organization_id AND das.business_id = r.business_id
       AND das.setting_key LIKE '%\_employer\_expense' ESCAPE '\'
       AND a.id = das.account_id
       AND (a.detail_type = 'cost_of_goods_sold' OR COALESCE(a.is_header,false) OR a.account_type::text <> 'expense');
  END LOOP;

  PERFORM set_config('app.bypass_org_lock', 'off', true);
END$$;

-- ---------- 5. JE-line guard trigger -------------------------------------
CREATE OR REPLACE FUNCTION public._payroll_assert_je_line_account(_account_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_acct public.accounts%ROWTYPE;
BEGIN
  IF _account_id IS NULL THEN RETURN; END IF;
  SELECT * INTO v_acct FROM public.accounts WHERE id = _account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll_je_account_violation: account % not found', _account_id USING ERRCODE = '22023';
  END IF;
  IF COALESCE(v_acct.is_header, false) THEN
    RAISE EXCEPTION 'payroll_je_account_violation: payroll JE line cannot post to header/parent account (%)', v_acct.code USING ERRCODE = '22023';
  END IF;
  IF v_acct.account_type::text = 'revenue' THEN
    RAISE EXCEPTION 'payroll_je_account_violation: payroll JE line cannot post to revenue account (%)', v_acct.code USING ERRCODE = '22023';
  END IF;
  IF v_acct.detail_type IN ('cost_of_goods_sold','accounts_receivable','accounts_payable') THEN
    RAISE EXCEPTION 'payroll_je_account_violation: payroll JE line cannot post to detail_type % (%)', v_acct.detail_type, v_acct.code USING ERRCODE = '22023';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public._payroll_je_line_class_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_source text;
BEGIN
  IF NEW.account_id IS NULL THEN RETURN NEW; END IF;
  SELECT source_type INTO v_source FROM public.journal_entries WHERE id = NEW.journal_entry_id;
  IF v_source = 'payroll' THEN
    PERFORM public._payroll_assert_je_line_account(NEW.account_id);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_payroll_je_account_class ON public.journal_entry_lines;
CREATE TRIGGER trg_enforce_payroll_je_account_class
  BEFORE INSERT OR UPDATE OF account_id ON public.journal_entry_lines
  FOR EACH ROW
  EXECUTE FUNCTION public._payroll_je_line_class_trigger();