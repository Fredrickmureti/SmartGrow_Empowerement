
-- =====================================================================
-- Phase A.2 — Fix is_header during CoA seed and re-backfill
-- =====================================================================
-- Root cause: provision_default_chart_of_accounts inserts every template
-- row with the table default is_header=false. The enforce_account_detail_type
-- trigger then fires; its "structural header" exemption looks for existing
-- children, but during INSERT none exist yet, so root header rows
-- (e.g. "1000 Assets") are rejected with
--   "detail_type is required for postable (leaf) accounts".
-- The function's outer EXCEPTION block then swallows the error and the
-- whole company ends up with zero accounts.
--
-- Fix: derive is_header from the template tree itself — any template whose
-- account_code is referenced as another template's parent_code IS a header.
-- This is country-agnostic and template-driven; no hardcoding.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.provision_default_chart_of_accounts(
  _org_id uuid, _business_id uuid, _country_code text DEFAULT NULL::text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _template public.default_chart_of_accounts%ROWTYPE;
  _parent_id uuid;
  _new_id uuid;
  _code_to_id jsonb := '{}'::jsonb;
  _accounts_created integer := 0;
  _resolved_country text := upper(coalesce(_country_code, 'INT'));
  _is_header boolean;
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

    -- Derive header flag from the template tree: a row is a header iff
    -- some other template in the same country set references it as parent.
    SELECT EXISTS (
      SELECT 1 FROM public.default_chart_of_accounts c
       WHERE c.country_code = _resolved_country
         AND c.parent_code = _template.account_code
    ) INTO _is_header;

    _new_id := NULL;

    IF _template.role_key IS NOT NULL THEN
      BEGIN
        _new_id := public.upsert_system_account(
          _org_id, _business_id, _template.role_key,
          _template.account_type::text, _template.detail_type,
          _template.account_code, _template.account_name,
          _template.description, _parent_id, _is_header
        );
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'upsert_system_account failed for role %: %', _template.role_key, SQLERRM;
        _new_id := NULL;
      END;
    ELSE
      BEGIN
        INSERT INTO public.accounts (
          organization_id, business_id, code, name, account_type,
          detail_type, parent_id, description, is_system, is_header, is_active
        ) VALUES (
          _org_id, _business_id, _template.account_code, _template.account_name,
          _template.account_type, _template.detail_type,
          _parent_id, _template.description,
          coalesce(_template.is_system, false), _is_header, true
        )
        ON CONFLICT DO NOTHING
        RETURNING id INTO _new_id;
      EXCEPTION WHEN OTHERS THEN
        -- Per-row failure should not abort the whole seed.
        RAISE NOTICE 'account insert failed for template % (%): %',
          _template.account_code, _template.account_name, SQLERRM;
        _new_id := NULL;
      END;
    END IF;

    IF _new_id IS NOT NULL THEN
      _code_to_id := _code_to_id || jsonb_build_object(_template.account_code, _new_id::text);
      _accounts_created := _accounts_created + 1;
    END IF;
  END LOOP;

  PERFORM public.backfill_account_detail_types(_org_id, _business_id);

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
$function$;

-- Re-run repair for every business that is still empty/degraded/pending.
DO $backfill$
DECLARE
  _row record;
  _result jsonb;
BEGIN
  FOR _row IN
    SELECT b.id AS business_id, b.organization_id
      FROM public.businesses b
     WHERE b.finance_readiness IN ('pending','degraded')
        OR NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.business_id = b.id)
  LOOP
    BEGIN
      _result := public.repair_finance_setup(_row.organization_id, _row.business_id);
      RAISE NOTICE 'Re-backfilled business %: %', _row.business_id, _result;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Re-backfill failed for business %: %', _row.business_id, SQLERRM;
    END;
  END LOOP;
END;
$backfill$;
