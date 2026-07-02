DO $$
DECLARE
  v_result jsonb;
  v_err_state text;
  v_err_msg   text;
  v_err_ctx   text;
BEGIN
  BEGIN
    v_result := public.create_product_with_opening_stock_atomic(
      jsonb_build_object(
        'organization_id','feec0616-039d-4d2a-b013-9fc4647ae6e6',
        'business_id','f0d5de27-7ac1-48ba-95f0-46f75ea52b30',
        'name','__DIAG2 Paracetamol 500mg',
        'sku','__DIAG2-PARS-500',
        'type','product',
        'category_id','5a7f5759-b405-421f-95b5-420b2e600f9e',
        'unit_price',5,
        'cost_price',2,
        'track_inventory',true
      ),
      jsonb_build_array(
        jsonb_build_object(
          'warehouse_id','1cafea71-34cb-48e3-8fa8-d9f4e2d0f4ea',
          'quantity_adjustment',1000,
          'unit_cost',2
        )
      ),
      '2b928fdd-c000-4880-964d-f134d96de286'::uuid
    );
    RAISE WARNING 'DIAG2 SUCCESS: %', v_result;
    RAISE EXCEPTION 'DIAG2_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      v_err_state = RETURNED_SQLSTATE,
      v_err_msg   = MESSAGE_TEXT,
      v_err_ctx   = PG_EXCEPTION_CONTEXT;
    RAISE WARNING 'DIAG2 sqlstate=% msg=% ctx=%', v_err_state, v_err_msg, v_err_ctx;
  END;
END$$;