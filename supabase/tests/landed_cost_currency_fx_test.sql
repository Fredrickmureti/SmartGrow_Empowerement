-- Landed cost — currency & FX contract (ADR 0135 / 0136 / 0123).
--
-- Contract assertions read the catalog; behavioural assertions run inside a
-- transaction that is rolled back, so the file is safe against any environment.

-- 1) The FX stamping trigger exists and routes through the canonical stamper.
DO $$
DECLARE v_src text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'landed_cost_vouchers'
       AND t.tgname = 'trg_lc_vouchers_fx_stamp' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'landed_cost_vouchers has no server-side FX stamping trigger';
  END IF;

  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_landed_cost_voucher_fx_stamp';

  IF v_src !~* 'fx_stamp_document' THEN
    RAISE EXCEPTION 'landed cost does not stamp through fx_stamp_document';
  END IF;
  IF v_src !~* 'currencies' THEN
    RAISE EXCEPTION 'landed cost does not validate the currency against the catalogue';
  END IF;
  IF v_src !~* 'cannot be changed' THEN
    RAISE EXCEPTION 'landed cost does not freeze the rate of a posted voucher';
  END IF;
END $$;

-- 2) No silent 1:1 anywhere in the landed cost valuation path.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE '%landed_cost%'
  LOOP
    IF r.prosrc ~* 'coalesce\s*\(\s*[a-z_.]*exchange_rate\s*,\s*1\s*\)' THEN
      RAISE EXCEPTION '% falls back to a 1:1 exchange rate', r.proname;
    END IF;
  END LOOP;
END $$;

-- 3) No schema-level currency or rate literal defaults on the voucher.
DO $$
DECLARE v_cur text; v_rate text;
BEGIN
  SELECT column_default INTO v_cur FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'landed_cost_vouchers'
     AND column_name = 'currency';
  SELECT column_default INTO v_rate FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'landed_cost_vouchers'
     AND column_name = 'exchange_rate';
  IF v_cur IS NOT NULL THEN
    RAISE EXCEPTION 'landed_cost_vouchers.currency carries a literal default: %', v_cur;
  END IF;
  IF v_rate IS NOT NULL THEN
    RAISE EXCEPTION 'landed_cost_vouchers.exchange_rate carries a default: %', v_rate;
  END IF;
END $$;

-- 4) Posting stays inside the canonical journal boundary (ADR 0123).
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'landed_cost_post_voucher';
  IF v_src ~* 'insert\s+into\s+(public\.)?journal_entr' THEN
    RAISE EXCEPTION 'landed_cost_post_voucher writes journal rows directly (ADR 0123)';
  END IF;
  IF v_src !~* 'post_journal_entry_atomic' THEN
    RAISE EXCEPTION 'landed_cost_post_voucher does not post through the canonical engine';
  END IF;
END $$;

-- 5) Behavioural: catalogue validation, missing-rate refusal, posted immutability.
DO $$
DECLARE
  v_org uuid; v_biz uuid; v_base text; v_id uuid; v_rate numeric; v_ok boolean;
BEGIN
  SELECT b.organization_id, b.id, upper(b.base_currency)
    INTO v_org, v_biz, v_base
    FROM public.businesses b
   WHERE b.base_currency IS NOT NULL
   LIMIT 1;

  IF v_biz IS NULL THEN
    RAISE NOTICE 'no business with a base currency — behavioural checks skipped';
    RETURN;
  END IF;

  -- (a) an invented currency code is rejected
  v_ok := false;
  BEGIN
    INSERT INTO public.landed_cost_vouchers (organization_id, business_id, currency)
    VALUES (v_org, v_biz, 'XXZ') RETURNING id INTO v_id;
  EXCEPTION WHEN OTHERS THEN v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'an arbitrary currency code was accepted on a landed cost voucher';
  END IF;

  -- (b) a base-currency voucher stamps rate 1 without needing a rate row
  INSERT INTO public.landed_cost_vouchers (organization_id, business_id, currency)
  VALUES (v_org, v_biz, v_base) RETURNING id, exchange_rate INTO v_id, v_rate;
  IF v_rate <> 1 THEN
    RAISE EXCEPTION 'base-currency voucher stamped rate % instead of 1', v_rate;
  END IF;

  -- (c) currency/rate of a posted voucher are immutable
  UPDATE public.landed_cost_vouchers SET status = 'posted' WHERE id = v_id;
  v_ok := false;
  BEGIN
    UPDATE public.landed_cost_vouchers SET exchange_rate = 999 WHERE id = v_id;
  EXCEPTION WHEN OTHERS THEN v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'the exchange rate of a posted landed cost voucher was mutated';
  END IF;

  -- (d) a foreign currency with no rate on file fails loudly, never at parity
  IF NOT EXISTS (
    SELECT 1 FROM public.currencies c
     WHERE c.is_active AND c.code <> v_base
       AND NOT EXISTS (
         SELECT 1 FROM public.exchange_rates er
          WHERE er.organization_id = v_org
            AND upper(er.from_currency) = c.code AND upper(er.to_currency) = v_base)
  ) THEN
    RAISE NOTICE 'every active currency has a rate — missing-rate check skipped';
  ELSE
    v_ok := false;
    BEGIN
      INSERT INTO public.landed_cost_vouchers (organization_id, business_id, currency)
      SELECT v_org, v_biz, c.code
        FROM public.currencies c
       WHERE c.is_active AND c.code <> v_base
         AND NOT EXISTS (
           SELECT 1 FROM public.exchange_rates er
            WHERE er.organization_id = v_org
              AND upper(er.from_currency) = c.code AND upper(er.to_currency) = v_base)
       LIMIT 1;
    EXCEPTION WHEN OTHERS THEN v_ok := true;
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'a foreign-currency voucher was accepted with no rate on file';
    END IF;
  END IF;

  RAISE EXCEPTION 'rollback: landed cost currency behavioural checks passed';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'rollback: landed cost currency behavioural checks passed' THEN
    RAISE NOTICE '%', SQLERRM;
  ELSE
    RAISE;
  END IF;
END $$;
