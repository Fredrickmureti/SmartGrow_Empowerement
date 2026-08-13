DO $mig$
DECLARE
  v_def text;
  v_new text;
  v_guard text := $g$
  IF v_voucher.exchange_rate IS NULL OR v_voucher.exchange_rate <= 0 THEN
    RAISE EXCEPTION
      'voucher % has no exchange rate on file for % — a landed cost cannot be allocated at parity',
      p_voucher_id, v_voucher.currency
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.landed_cost_allocations WHERE voucher_id = p_voucher_id;$g$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'landed_cost_allocate_voucher';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'landed_cost_allocate_voucher not found';
  END IF;

  v_new := replace(v_def,
    'COALESCE(v_voucher.exchange_rate, 1)', 'v_voucher.exchange_rate');
  IF v_new = v_def THEN
    RAISE EXCEPTION 'expected 1:1 fallback not found in landed_cost_allocate_voucher';
  END IF;

  v_def := v_new;
  v_new := replace(v_def,
    '  DELETE FROM public.landed_cost_allocations WHERE voucher_id = p_voucher_id;',
    v_guard);
  IF v_new = v_def THEN
    RAISE EXCEPTION 'allocation reset anchor not found in landed_cost_allocate_voucher';
  END IF;

  EXECUTE v_new;
END $mig$;
