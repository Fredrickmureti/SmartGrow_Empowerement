DO $mig$
DECLARE
  v_org   uuid := '8e682296-c634-44c8-ae00-bc48940ec28b';
  v_biz   uuid := 'bf392ca6-a743-435c-ae41-5bf25199470d';
  v_branch uuid := 'aeb86a80-af26-437b-a033-e95615fdaa28';
  v_actor uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  v_cable uuid := '86a5fec4-799c-4218-a932-1d9f46f3ca87';
  v_nkr   uuid := '62853bd5-96be-4d9d-983c-67bb4f154775';
  v_res   jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);

  v_res := public.apply_or_request_stock_adjustment(
    jsonb_build_object(
      'organization_id', v_org,
      'business_id', v_biz,
      'branch_id', v_branch,
      'warehouse_id', v_nkr,
      'adjustment_number', public.get_next_adjustment_number(v_org, v_biz),
      'reason', 'damage',
      'notes', 'Phase F2 — consume uplifted stock before landed cost reversal',
      'client_request_id', gen_random_uuid(),
      'items', jsonb_build_array(jsonb_build_object(
        'product_id', v_cable,
        'warehouse_id', v_nkr,
        'quantity_adjustment', -20,
        'unit_cost', 59.2485549132947977,
        'notes', 'F2 post-uplift write-off'))
    ),
    v_actor);

  IF NOT COALESCE((v_res->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'stock adjustment failed: %', v_res;
  END IF;
END $mig$;