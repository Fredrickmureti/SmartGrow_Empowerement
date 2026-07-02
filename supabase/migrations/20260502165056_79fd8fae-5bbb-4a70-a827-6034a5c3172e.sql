-- ============================================================
-- Repair misclassified detail_types (deterministic, name-driven)
-- Only updates rows where the current detail_type is NULL or
-- known-bad for the account's name, so this is safe to re-run.
-- ============================================================

-- 1a. FX accounts (income side)
UPDATE public.accounts
SET detail_type = 'other_misc_income'
WHERE account_type = 'income'
  AND coalesce(is_header,false) = false
  AND name ~* '\m(foreign\s*exchange|fx)\m.*\m(gain|gains)\m'
  AND (detail_type IS NULL
       OR detail_type IN ('sales_income','service_income','other_primary_income','cash_receipt_income'));

-- 1b. FX accounts (expense side)
UPDATE public.accounts
SET detail_type = 'exchange_gain_loss'
WHERE account_type = 'expense'
  AND coalesce(is_header,false) = false
  AND name ~* '\m(foreign\s*exchange|fx)\m.*\m(loss|losses)\m'
  AND (detail_type IS NULL
       OR detail_type IN ('other_business_expenses','other_expense','finance_costs'));

-- 1c. Rounding accounts
UPDATE public.accounts
SET detail_type = 'other_misc_income'
WHERE account_type = 'income'
  AND coalesce(is_header,false) = false
  AND name ~* '\mrounding\m'
  AND (detail_type IS NULL OR detail_type NOT IN ('other_misc_income','other_income'));

UPDATE public.accounts
SET detail_type = 'other_expense'
WHERE account_type = 'expense'
  AND coalesce(is_header,false) = false
  AND name ~* '\mrounding\m'
  AND (detail_type IS NULL OR detail_type NOT IN ('other_expense','other_business_expenses'));

-- 1d. Discounts received (income)
UPDATE public.accounts
SET detail_type = 'other_misc_income'
WHERE account_type = 'income'
  AND coalesce(is_header,false) = false
  AND name ~* '\mdiscounts?\s*received\m'
  AND (detail_type IS NULL OR detail_type NOT IN ('other_misc_income','other_income'));

-- 1e. Accumulated depreciation
UPDATE public.accounts
SET detail_type = 'accumulated_depreciation'
WHERE account_type = 'asset'
  AND coalesce(is_header,false) = false
  AND name ~* '\maccumulated\s*deprec'
  AND coalesce(detail_type,'') <> 'accumulated_depreciation';

-- 1f. Fixed asset leaves that were tagged as accounts_receivable (seeded bug)
UPDATE public.accounts
SET detail_type = 'machinery_equipment'
WHERE account_type = 'asset'
  AND coalesce(is_header,false) = false
  AND name ~* '\m(property|plant|equipment|machinery)\m'
  AND detail_type = 'accounts_receivable';

UPDATE public.accounts
SET detail_type = 'furniture_fixtures'
WHERE account_type = 'asset'
  AND coalesce(is_header,false) = false
  AND name ~* '\mfurniture\m'
  AND detail_type = 'accounts_receivable';

UPDATE public.accounts
SET detail_type = 'vehicles'
WHERE account_type = 'asset'
  AND coalesce(is_header,false) = false
  AND name ~* '\mvehicles?\m'
  AND detail_type = 'accounts_receivable';

-- 1g. Header (group) accounts must never expose a postable detail_type
UPDATE public.accounts
SET detail_type = NULL
WHERE coalesce(is_header,false) = true
  AND detail_type IS NOT NULL;

-- ============================================================
-- 2. Make new-business provisioning role-complete
--    (chain provision_missing_system_accounts at the end so
--     every signup boots with one eligible leaf per role).
-- ============================================================
CREATE OR REPLACE FUNCTION public.provision_default_chart_of_accounts(
  _org_id uuid,
  _business_id uuid,
  _country_code text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _template public.default_chart_of_accounts%ROWTYPE;
  _parent_id uuid;
  _new_id uuid;
  _code_to_id jsonb := '{}'::jsonb;
  _accounts_created integer := 0;
  _resolved_country text := upper(coalesce(_country_code, 'INT'));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.default_chart_of_accounts WHERE country_code = _resolved_country LIMIT 1) THEN
    _resolved_country := 'INT';
  END IF;

  FOR _template IN
    SELECT * FROM public.default_chart_of_accounts
    WHERE country_code = _resolved_country AND is_country_neutral = true
      AND account_name !~* '\m(nhif|shif|paye|nssf|housing\s*levy|uif|sdl|wcf|skills\s*levy|gratuity|epf|esic|provident\s*fund|pf\s*payable|kra|sars|ura|tra|bir)\m'
    ORDER BY account_code
  LOOP
    _parent_id := NULL;
    IF _template.parent_code IS NOT NULL THEN
      _parent_id := NULLIF(_code_to_id->>_template.parent_code, '')::uuid;
    END IF;

    INSERT INTO public.accounts (
      organization_id, business_id, code, name, account_type,
      detail_type, parent_id, description, is_system, is_active
    ) VALUES (
      _org_id, _business_id, _template.account_code, _template.account_name,
      _template.account_type, _template.detail_type,
      _parent_id, _template.description,
      coalesce(_template.is_system, false), true
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO _new_id;

    IF _new_id IS NOT NULL THEN
      _code_to_id := _code_to_id || jsonb_build_object(_template.account_code, _new_id::text);
      _accounts_created := _accounts_created + 1;
    END IF;
  END LOOP;

  PERFORM public.backfill_account_detail_types(_org_id, _business_id);

  -- NEW: ensure every system role has at least one eligible postable leaf,
  -- using the existing template + provisioning engine. Errors are swallowed
  -- so a single bad role never breaks tenant signup.
  BEGIN
    PERFORM public.provision_missing_system_accounts(_org_id, _business_id, false);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'provision_missing_system_accounts failed for biz %: %', _business_id, SQLERRM;
  END;

  INSERT INTO public.default_account_settings (organization_id, business_id, setting_key, account_id)
  SELECT a.organization_id, a.business_id, 'opening_balance_equity', a.id
  FROM public.accounts a
  WHERE a.business_id = _business_id AND a.detail_type = 'opening_balance_equity' AND a.is_active = true
    AND NOT EXISTS (SELECT 1 FROM public.default_account_settings d
                    WHERE d.business_id = a.business_id AND d.setting_key = 'opening_balance_equity')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.default_account_settings (organization_id, business_id, setting_key, account_id)
  SELECT a.organization_id, a.business_id, 'suspense', a.id
  FROM public.accounts a
  WHERE a.business_id = _business_id AND a.detail_type = 'suspense' AND a.is_active = true
    AND NOT EXISTS (SELECT 1 FROM public.default_account_settings d
                    WHERE d.business_id = a.business_id AND d.setting_key = 'suspense')
  ON CONFLICT DO NOTHING;

  RETURN _accounts_created;
END;
$$;