CREATE TABLE IF NOT EXISTS public._pret_sim_log (
  id bigserial primary key,
  step text not null,
  ok boolean not null,
  detail jsonb,
  at timestamptz not null default now()
);
GRANT ALL ON public._pret_sim_log TO service_role;
ALTER TABLE public._pret_sim_log ENABLE ROW LEVEL SECURITY;

DO $sim$
DECLARE
  v_uid uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  v_biz uuid := 'bf392ca6-a743-435c-ae41-5bf25199470d';
  v_grn uuid := '90a655e9-5b6c-413e-8227-48cbb07bc566';
  v_vendor uuid := '54709d33-f976-4c42-8f2e-f27cca6a85fd';
  v_line record;
  v_res jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);

  -- 1. The screen that failed: the returnable ledger.
  FOR v_line IN SELECT * FROM public.purchase_return_returnable_lines(v_grn) LOOP
    INSERT INTO public._pret_sim_log(step, ok, detail)
    VALUES ('returnable_line', true, to_jsonb(v_line));
  END LOOP;

  -- 2. Create a goods return for 10 base units of the first line.
  SELECT * INTO v_line FROM public.purchase_return_returnable_lines(v_grn)
   ORDER BY 1 LIMIT 1;

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

  INSERT INTO public._pret_sim_log(step, ok, detail) VALUES ('create', true, v_res);
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public._pret_sim_log(step, ok, detail)
  VALUES ('error', false, jsonb_build_object('sqlstate', SQLSTATE, 'message', SQLERRM));
END
$sim$;