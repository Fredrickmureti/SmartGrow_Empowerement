CREATE OR REPLACE FUNCTION public.landed_cost_selftest(p_business uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_out jsonb := '[]'::jsonb;
  v_detail text;
  v_org uuid;
  v_wh uuid;
  v_branch uuid;
  v_vendor uuid;
  v_type text;
  v_p1 uuid;
  v_p2 uuid;
  v_pnon uuid;
  v_po uuid;
  v_poi1 uuid; v_poi2 uuid; v_poi3 uuid;
  v_grn uuid;
  v_gri1 uuid; v_gri2 uuid; v_gri3 uuid;
  v_v uuid;
  v_exp_acct uuid;
  v_res jsonb;
  v_res2 jsonb;
  v_post jsonb;
  v_rev jsonb;
  v_alloc_total numeric;
  v_alloc_total2 numeric;
  v_uc1 numeric; v_uc2 numeric;
  v_je_dr numeric; v_je_cr numeric;
  v_reval int;
  v_err text;
BEGIN
  BEGIN
    SELECT organization_id INTO v_org FROM public.businesses WHERE id = p_business;
    SELECT id, branch_id INTO v_wh, v_branch FROM public.warehouses
     WHERE business_id = p_business AND COALESCE(is_in_transit,false) = false
     ORDER BY is_default DESC NULLS LAST LIMIT 1;
    SELECT id INTO v_vendor FROM public.contacts
     WHERE business_id = p_business AND type IN ('supplier','both') LIMIT 1;
    SELECT type::text INTO v_type FROM public.products WHERE business_id = p_business LIMIT 1;
    SELECT id INTO v_exp_acct FROM public.accounts
     WHERE business_id = p_business AND account_type = 'expense' AND COALESCE(is_active,true) LIMIT 1;

    IF v_wh IS NULL OR v_vendor IS NULL OR v_exp_acct IS NULL THEN
      RAISE EXCEPTION 'selftest prerequisites missing (warehouse/vendor/expense account)';
    END IF;

    -- ---- seed products -------------------------------------------------
    INSERT INTO public.products (organization_id, business_id, name, sku, type, track_inventory, cost_price, unit_price)
    VALUES (v_org, p_business, 'LCTEST Widget A', 'LCTEST-A', COALESCE(v_type,'product')::product_type, true, 10, 15)
    RETURNING id INTO v_p1;
    INSERT INTO public.products (organization_id, business_id, name, sku, type, track_inventory, cost_price, unit_price)
    VALUES (v_org, p_business, 'LCTEST Widget B', 'LCTEST-B', COALESCE(v_type,'product')::product_type, true, 20, 30)
    RETURNING id INTO v_p2;
    INSERT INTO public.products (organization_id, business_id, name, sku, type, track_inventory, cost_price, unit_price)
    VALUES (v_org, p_business, 'LCTEST Non-stock', 'LCTEST-N', COALESCE(v_type,'product')::product_type, false, 30, 40)
    RETURNING id INTO v_pnon;

    -- ---- purchase order --------------------------------------------------
    INSERT INTO public.purchase_orders (organization_id, business_id, branch_id, vendor_id, po_number, order_date, status, currency, created_by)
    VALUES (v_org, p_business, v_branch, v_vendor, 'LCTEST-PO-' || substr(gen_random_uuid()::text,1,8), CURRENT_DATE, 'draft', 'KES', p_actor)
    RETURNING id INTO v_po;

    INSERT INTO public.purchase_order_items (purchase_order_id, product_id, description, quantity, unit_price, line_total, sort_order)
    VALUES (v_po, v_p1, 'LCTEST Widget A', 100, 10, 1000, 1) RETURNING id INTO v_poi1;
    INSERT INTO public.purchase_order_items (purchase_order_id, product_id, description, quantity, unit_price, line_total, sort_order)
    VALUES (v_po, v_p2, 'LCTEST Widget B', 50, 20, 1000, 2) RETURNING id INTO v_poi2;
    INSERT INTO public.purchase_order_items (purchase_order_id, product_id, description, quantity, unit_price, line_total, sort_order)
    VALUES (v_po, v_pnon, 'LCTEST Non-stock', 5, 30, 150, 3) RETURNING id INTO v_poi3;

    -- ---- goods receipt ---------------------------------------------------
    INSERT INTO public.goods_receipts (organization_id, business_id, branch_id, purchase_order_id, receipt_number, receipt_date, warehouse_id, status, received_by)
    VALUES (v_org, p_business, v_branch, v_po, 'LCTEST-GRN-' || substr(gen_random_uuid()::text,1,8), CURRENT_DATE, v_wh, 'completed', p_actor)
    RETURNING id INTO v_grn;

    INSERT INTO public.goods_receipt_items (goods_receipt_id, purchase_order_item_id, product_id, description, quantity_ordered, quantity_received, sort_order)
    VALUES (v_grn, v_poi1, v_p1, 'LCTEST Widget A', 100, 100, 1) RETURNING id INTO v_gri1;
    INSERT INTO public.goods_receipt_items (goods_receipt_id, purchase_order_item_id, product_id, description, quantity_ordered, quantity_received, sort_order)
    VALUES (v_grn, v_poi2, v_p2, 'LCTEST Widget B', 50, 50, 2) RETURNING id INTO v_gri2;
    INSERT INTO public.goods_receipt_items (goods_receipt_id, purchase_order_item_id, product_id, description, quantity_ordered, quantity_received, sort_order)
    VALUES (v_grn, v_poi3, v_pnon, 'LCTEST Non-stock', 5, 5, 3) RETURNING id INTO v_gri3;

    -- ---- stock movements create the cost layers --------------------------
    INSERT INTO public.stock_movements (organization_id, business_id, branch_id, warehouse_id, product_id, movement_type, quantity, unit_cost, reference_type, reference_id, created_by)
    VALUES (v_org, p_business, v_branch, v_wh, v_p1, 'receipt', 100, 10, 'goods_receipt', v_grn, p_actor);
    INSERT INTO public.stock_movements (organization_id, business_id, branch_id, warehouse_id, product_id, movement_type, quantity, unit_cost, reference_type, reference_id, created_by)
    VALUES (v_org, p_business, v_branch, v_wh, v_p2, 'receipt', 50, 20, 'goods_receipt', v_grn, p_actor);

    -- simulate 40 units of product A already sold
    UPDATE public.cost_layers SET qty_remaining = 60
     WHERE business_id = p_business AND product_id = v_p1;

    -- ---- voucher ---------------------------------------------------------
    INSERT INTO public.landed_cost_vouchers (organization_id, business_id, branch_id, voucher_date, vendor_id, default_basis, currency, exchange_rate, created_by)
    VALUES (v_org, p_business, v_branch, CURRENT_DATE, v_vendor, 'value', 'KES', 1, p_actor)
    RETURNING id INTO v_v;

    INSERT INTO public.landed_cost_voucher_receipts (organization_id, business_id, voucher_id, goods_receipt_id)
    VALUES (v_org, p_business, v_v, v_grn);

    INSERT INTO public.landed_cost_components (organization_id, business_id, voucher_id, description, amount, basis, is_capitalizable, sort_order)
    VALUES (v_org, p_business, v_v, 'Ocean freight', 3000, 'value', true, 1);
    INSERT INTO public.landed_cost_components (organization_id, business_id, voucher_id, description, amount, basis, is_capitalizable, expense_account_id, sort_order)
    VALUES (v_org, p_business, v_v, 'Bank charges', 500, 'value', false, v_exp_acct, 2);

    -- ---- 1. allocate ------------------------------------------------------
    v_res := public.landed_cost_allocate_voucher(v_v, p_actor);
    SELECT COALESCE(SUM(allocated_amount),0) INTO v_alloc_total
      FROM public.landed_cost_allocations WHERE voucher_id = v_v;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'check','allocation total equals charge total',
      'ok', v_alloc_total = 3500, 'expected', 3500, 'actual', v_alloc_total));

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'check','non-stock line skipped with reason',
      'ok', (v_res->'skipped_lines') @> jsonb_build_array(jsonb_build_object(
              'goods_receipt_item_id', v_gri3, 'product_id', v_pnon, 'reason','not_inventory_tracked')),
      'actual', v_res->'skipped_lines'));

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'check','no allocation rows against the non-stock line',
      'ok', NOT EXISTS (SELECT 1 FROM public.landed_cost_allocations
                         WHERE voucher_id = v_v AND goods_receipt_item_id = v_gri3)));

    -- ---- 2. allocation is idempotent --------------------------------------
    v_res2 := public.landed_cost_allocate_voucher(v_v, p_actor);
    SELECT COALESCE(SUM(allocated_amount),0) INTO v_alloc_total2
      FROM public.landed_cost_allocations WHERE voucher_id = v_v;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'check','re-allocation is idempotent',
      'ok', v_alloc_total2 = v_alloc_total, 'actual', v_alloc_total2));

    -- ---- 3. post ----------------------------------------------------------
    v_post := public.landed_cost_post_voucher(v_v, p_actor);

    SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0) INTO v_je_dr, v_je_cr
      FROM public.journal_entry_lines WHERE journal_entry_id = (v_post->>'journal_entry_id')::uuid;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'check','posting journal balances', 'ok', v_je_dr = v_je_cr AND v_je_dr = 3500,
      'debit', v_je_dr, 'credit', v_je_cr));

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'check','capitalised + expensed equals capitalisable charge',
      'ok', (v_post->>'capitalized_amount')::numeric + (v_post->>'expensed_amount')::numeric = 3000,
      'capitalized', v_post->>'capitalized_amount', 'expensed', v_post->>'expensed_amount'));

    SELECT unit_cost INTO v_uc1 FROM public.cost_layers WHERE business_id = p_business AND product_id = v_p1;
    SELECT unit_cost INTO v_uc2 FROM public.cost_layers WHERE business_id = p_business AND product_id = v_p2;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'check','unit cost uplift applies to remaining quantity only',
      'ok', v_uc1 = 10 + (900::numeric/60) AND v_uc2 = 20 + (1500::numeric/50),
      'product_a_unit_cost', v_uc1, 'product_b_unit_cost', v_uc2));

    SELECT count(*) INTO v_reval FROM public.inventory_cost_revaluations
     WHERE source_type = 'landed_cost_voucher' AND source_id = v_v AND reversed_at IS NULL;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'check','one live revaluation row per cost layer', 'ok', v_reval = 2, 'actual', v_reval));

    -- ---- 4. double posting refused ----------------------------------------
    BEGIN
      PERFORM public.landed_cost_post_voucher(v_v, p_actor);
      v_out := v_out || jsonb_build_array(jsonb_build_object('check','double posting refused','ok', false));
    EXCEPTION WHEN OTHERS THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object('check','double posting refused','ok', true, 'error', SQLERRM));
    END;

    -- ---- 5. reversal without a reason refused -----------------------------
    BEGIN
      PERFORM public.landed_cost_reverse_voucher(v_v, '', p_actor);
      v_out := v_out || jsonb_build_array(jsonb_build_object('check','reversal requires a reason','ok', false));
    EXCEPTION WHEN OTHERS THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object('check','reversal requires a reason','ok', true, 'error', SQLERRM));
    END;

    -- ---- 6. reverse --------------------------------------------------------
    v_rev := public.landed_cost_reverse_voucher(v_v, 'selftest reversal', p_actor);

    SELECT unit_cost INTO v_uc1 FROM public.cost_layers WHERE business_id = p_business AND product_id = v_p1;
    SELECT unit_cost INTO v_uc2 FROM public.cost_layers WHERE business_id = p_business AND product_id = v_p2;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'check','reversal restores original unit costs',
      'ok', v_uc1 = 10 AND v_uc2 = 20, 'product_a_unit_cost', v_uc1, 'product_b_unit_cost', v_uc2));

    SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0) INTO v_je_dr, v_je_cr
      FROM public.journal_entry_lines WHERE journal_entry_id = (v_rev->>'reversal_journal_entry_id')::uuid;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'check','reversal journal mirrors the original', 'ok', v_je_dr = 3500 AND v_je_cr = 3500,
      'debit', v_je_dr, 'credit', v_je_cr));

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'check','voucher marked reversed',
      'ok', EXISTS (SELECT 1 FROM public.landed_cost_vouchers
                     WHERE id = v_v AND status = 'reversed' AND reversed_at IS NOT NULL)));

    RAISE EXCEPTION 'LC_SELFTEST_ROLLBACK' USING DETAIL = v_out::text;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_err := SQLERRM;
    IF v_err = 'LC_SELFTEST_ROLLBACK' THEN
      v_out := v_detail::jsonb;
    ELSE
      v_out := jsonb_build_array(jsonb_build_object('check','selftest aborted','ok', false, 'error', v_err, 'detail', v_detail));
    END IF;
  END;

  RETURN jsonb_build_object(
    'passed', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_out) e WHERE (e->>'ok')::boolean IS NOT TRUE),
    'checks', v_out);
END;
$fn$;

REVOKE ALL ON FUNCTION public.landed_cost_selftest(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landed_cost_selftest(uuid, uuid) TO service_role;