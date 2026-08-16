DO $$
DECLARE
  v_actor uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_actor, 'role','authenticated')::text, true);
  PERFORM set_config('role','authenticated', true);

  r := public.landed_cost_post_voucher('5d694ab8-4376-4001-8ae2-be1b9667c766', v_actor);
  RAISE NOTICE 'LCV-2026-00002 => %', r;

  r := public.landed_cost_post_voucher('a001e7ae-d782-4ab4-98fd-f22a86035499', v_actor);
  RAISE NOTICE 'LCV-2026-00003 => %', r;

  PERFORM set_config('role','none', true);
END $$;