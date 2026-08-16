DO $mig$
DECLARE
  v_org   uuid := '8e682296-c634-44c8-ae00-bc48940ec28b';
  v_biz   uuid := 'bf392ca6-a743-435c-ae41-5bf25199470d';
  v_actor uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  v_grn   uuid := 'c4778e6b-2f43-4bed-9ef6-21de128b916a';
  v_type  uuid := 'bab54642-d94f-453c-a2ae-6104708b3306';
  v_v     uuid;
  v_res   jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);

  INSERT INTO public.landed_cost_vouchers (
    organization_id, business_id, status, voucher_date, shipment_reference,
    default_basis, currency, exchange_rate, total_amount, total_base_amount, created_by, notes
  ) VALUES (
    v_org, v_biz, 'draft', CURRENT_DATE,
    'Phase F2 — warehouse-split proof', 'value', 'KES', 1, 2000, 2000, v_actor,
    'Freight on GRN-2026-00004; stock split HQ/Nakuru with prior consumption'
  ) RETURNING id INTO v_v;

  INSERT INTO public.landed_cost_voucher_receipts (organization_id, business_id, voucher_id, goods_receipt_id)
  VALUES (v_org, v_biz, v_v, v_grn);

  INSERT INTO public.landed_cost_components (
    organization_id, business_id, voucher_id, component_type_id, description,
    amount, base_amount, basis, is_capitalizable, sort_order
  ) VALUES (
    v_org, v_biz, v_v, v_type, 'Inland freight', 2000, 2000, 'value', true, 0
  );

  v_res := public.landed_cost_allocate_voucher(v_v, v_actor);
  RAISE NOTICE 'allocate: %', v_res;
  IF COALESCE(v_res->>'status','') <> 'allocated' THEN
    RAISE EXCEPTION 'allocation failed: %', v_res;
  END IF;

  v_res := public.landed_cost_post_voucher(v_v, v_actor);
  RAISE NOTICE 'post: %', v_res;
  IF COALESCE(v_res->>'status','') NOT IN ('posted','pending_approval') THEN
    RAISE EXCEPTION 'posting failed: %', v_res;
  END IF;
END $mig$;