ALTER TABLE public._pret_sim_log DISABLE ROW LEVEL SECURITY;
TRUNCATE public._pret_sim_log;

DO $sim$
DECLARE
  v_uid uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  v_biz uuid := 'bf392ca6-a743-435c-ae41-5bf25199470d';
  v_grn uuid := '90a655e9-5b6c-413e-8227-48cbb07bc566';
  v_vendor uuid := '54709d33-f976-4c42-8f2e-f27cca6a85fd';
  v_line record;
  v_res jsonb;
  v_log jsonb := '[]'::jsonb;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
    PERFORM set_config('role', 'authenticated', true);

    FOR v_line IN SELECT * FROM public.purchase_return_returnable_lines(v_grn) LOOP
      v_log := v_log || jsonb_build_array(jsonb_build_object('step','returnable_line','detail',to_jsonb(v_line)));
    END LOOP;

    SELECT * INTO v_line FROM public.purchase_return_returnable_lines(v_grn) ORDER BY 1 LIMIT 1;

    v_res := public.purchase_return_create(
      v_biz, v_vendor,
      jsonb_build_array(jsonb_build_object(
        'goods_receipt_item_id', v_line.goods_receipt_item_id,
        'product_id', v_line.product_id,
        'description', v_line.description,
        'quantity', 10,
        'return_reason', 'damaged'
      )),
      'goods', v_grn, NULL, NULL, CURRENT_DATE, 'damaged', 'Simulated return event', NULL);
    v_log := v_log || jsonb_build_array(jsonb_build_object('step','create','detail',v_res));
  EXCEPTION WHEN OTHERS THEN
    v_log := v_log || jsonb_build_array(jsonb_build_object('step','error','detail',
      jsonb_build_object('sqlstate', SQLSTATE, 'message', SQLERRM)));
  END;

  PERFORM set_config('role', 'none', true);
  RESET role;
  INSERT INTO public._pret_sim_log(step, ok, detail) VALUES ('run', true, v_log);
END
$sim$;