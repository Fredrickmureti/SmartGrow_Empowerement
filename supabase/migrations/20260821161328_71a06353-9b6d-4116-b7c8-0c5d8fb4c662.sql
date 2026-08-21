DO $mig$
DECLARE
  fn text; d text; d2 text;
  resolution text := '  SELECT ba.account_id INTO v_bank_gl FROM public.bank_accounts ba WHERE ba.id = _bank_account_id;' || E'\n' ||
    '  IF v_bank_gl IS NULL THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Bank account % has no general ledger account configured'', _bank_account_id USING ERRCODE = ''23502'';' || E'\n' ||
    '  END IF;' || E'\n' || E'\n';
BEGIN
  FOREACH fn IN ARRAY ARRAY['refund_customer_atomic','refund_from_vendor_atomic'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO d
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = fn;
    IF d IS NULL THEN RAISE EXCEPTION '% is missing', fn; END IF;

    d2 := regexp_replace(d, E'\nDECLARE\n', E'\nDECLARE\n  v_bank_gl uuid;\n');
    IF d2 = d THEN RAISE EXCEPTION '%: DECLARE block not found', fn; END IF;
    d := d2;

    d2 := replace(d, '  v_lines := jsonb_build_array(', resolution || '  v_lines := jsonb_build_array(');
    IF d2 = d THEN RAISE EXCEPTION '%: journal line construction not found', fn; END IF;
    d := d2;

    d2 := replace(d, '''account_id'', _bank_account_id', '''account_id'', v_bank_gl');
    IF d2 = d THEN RAISE EXCEPTION '%: bank journal line not found', fn; END IF;

    EXECUTE d2;
  END LOOP;

  FOREACH fn IN ARRAY ARRAY['refund_customer_atomic','refund_from_vendor_atomic'] LOOP
    SELECT p.prosrc INTO d FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = fn;
    IF d ~ '''account_id'',\s*_bank_account_id' THEN
      RAISE EXCEPTION '% still posts the bank record id as a ledger account', fn;
    END IF;
  END LOOP;
END $mig$;