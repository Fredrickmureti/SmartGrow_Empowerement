DO $mig$
DECLARE
  v_actor uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  v_v     uuid;
  v_res   jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);

  SELECT id INTO v_v FROM public.landed_cost_vouchers WHERE voucher_number = 'LCV-2026-00005';

  v_res := public.landed_cost_reverse_voucher(
    v_v, 'Phase F2 — warehouse-split reversal proof', v_actor);
  RAISE NOTICE 'reverse: %', v_res;

  IF (SELECT status FROM public.landed_cost_vouchers WHERE id = v_v) <> 'reversed' THEN
    RAISE EXCEPTION 'reversal did not complete: %', v_res;
  END IF;
END $mig$;