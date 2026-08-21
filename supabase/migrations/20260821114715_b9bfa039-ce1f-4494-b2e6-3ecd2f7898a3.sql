-- FX Foundation Step 3 — monetary eligibility + line-level currency.

-- One classifier, used by every FX exposure/revaluation surface.
CREATE OR REPLACE FUNCTION public.fx_is_monetary_account(_account_type text, _detail_type text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT _account_type IN ('asset','liability')
     AND COALESCE(_detail_type, '') NOT IN (
       -- Non-monetary assets: carried at historical cost, never revalued (IAS 21.23(b)).
       'inventory','prepaid_expenses','deferred_tax_asset',
       'assets_available_for_sale','assets_held_for_sale',
       'land','buildings','vehicles','machinery_equipment','furniture_fixtures',
       'leasehold_improvements','lease_buyout','depletable_assets',
       'goodwill','intangible_assets','licenses','organizational_costs','development_costs',
       'fixed_asset_computers','fixed_asset_copiers','fixed_asset_furniture',
       'fixed_asset_other_tools','fixed_asset_phone','fixed_asset_photo_video',
       'fixed_asset_software','other_fixed_asset','other_non_current_asset',
       'accumulated_depreciation','accumulated_amortization','accumulated_depletion',
       -- Non-monetary liabilities: settled by delivering goods/services, not cash.
       'deferred_revenue','unearned_revenue','customer_deposits','deferred_tax_liability'
     );
$$;

COMMENT ON FUNCTION public.fx_is_monetary_account(text, text) IS
  'Single source of truth for FX monetary eligibility (IAS 21). Only monetary asset/liability detail types are revalued or reported as exposure. A NULL detail type is treated as monetary so an unclassified receivable/payable is never silently dropped.';

REVOKE ALL ON FUNCTION public.fx_is_monetary_account(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fx_is_monetary_account(text, text) TO authenticated, service_role;

DO $$
DECLARE v_def text; v_new text; r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('revalue_fx_balances', ARRAY[
        ARRAY['      upper(je.currency) AS currency,',
              '      upper(COALESCE(jel.original_currency, je.currency)) AS currency,'],
        ARRAY['      AND je.currency IS NOT NULL' || chr(10) ||
              '      AND upper(je.currency) <> upper(_base_currency)' || chr(10) ||
              '      AND a.account_type IN (''asset'',''liability'')',
              '      AND COALESCE(jel.original_currency, je.currency) IS NOT NULL' || chr(10) ||
              '      AND upper(COALESCE(jel.original_currency, je.currency)) <> upper(_base_currency)' || chr(10) ||
              '      AND public.fx_is_monetary_account(a.account_type::text, a.detail_type::text)'],
        ARRAY['    GROUP BY jel.account_id, upper(je.currency)',
              '    GROUP BY jel.account_id, upper(COALESCE(jel.original_currency, je.currency))']
      ]),
      ('fx_exposure_by_currency', ARRAY[
        ARRAY['    SELECT upper(je.currency) AS currency,',
              '    SELECT upper(COALESCE(jel.original_currency, je.currency)) AS currency,'],
        ARRAY['       AND je.currency IS NOT NULL' || chr(10) ||
              '       AND upper(je.currency) <> _base' || chr(10) ||
              '       AND a.account_type IN (''asset'',''liability'')',
              '       AND COALESCE(jel.original_currency, je.currency) IS NOT NULL' || chr(10) ||
              '       AND upper(COALESCE(jel.original_currency, je.currency)) <> _base' || chr(10) ||
              '       AND public.fx_is_monetary_account(a.account_type::text, a.detail_type::text)'],
        ARRAY['     GROUP BY upper(je.currency)',
              '     GROUP BY upper(COALESCE(jel.original_currency, je.currency))']
      ])
    ) AS t(fname, edits)
  LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname = r.fname;
    IF v_def IS NULL THEN RAISE EXCEPTION '% is missing', r.fname; END IF;

    v_new := v_def;
    FOR i IN 1 .. array_length(r.edits, 1) LOOP
      IF position(r.edits[i][1] IN v_new) = 0 THEN
        RAISE EXCEPTION '% does not contain the expected fragment #%; not patched', r.fname, i;
      END IF;
      v_new := replace(v_new, r.edits[i][1], r.edits[i][2]);
    END LOOP;

    EXECUTE v_new;
  END LOOP;
END $$;