-- FX Foundation Step 3b — the exposure drill-down uses the same eligibility rule.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fx_exposure_open_items';
  IF v_def IS NULL THEN RAISE EXCEPTION 'fx_exposure_open_items is missing'; END IF;

  v_new := replace(v_def,
$old$       AND upper(COALESCE(je.currency, '')) = _cur
       AND _cur <> _base
       AND a.account_type IN ('asset','liability')$old$,
$new$       AND upper(COALESCE(jel.original_currency, je.currency, '')) = _cur
       AND _cur <> _base
       AND public.fx_is_monetary_account(a.account_type::text, a.detail_type::text)$new$);

  IF v_new = v_def THEN
    RAISE EXCEPTION 'fx_exposure_open_items did not match the expected shape; not patched';
  END IF;

  EXECUTE v_new;
END $$;