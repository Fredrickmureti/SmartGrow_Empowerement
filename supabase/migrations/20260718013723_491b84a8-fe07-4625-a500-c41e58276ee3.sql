-- WMS Phase 14f — extend E2E seed with a wms_qc_hold_reasons row per caller's business.
-- Keeps the existing 14b seed body intact; appends an idempotent block for QC.

CREATE OR REPLACE FUNCTION public.wms_e2e_ensure_seed()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz uuid; v_org uuid; v_branch uuid;
  v_wh uuid;
  v_loc_in uuid; v_loc_stock uuid; v_loc_out uuid;
  v_prod_a uuid; v_prod_b uuid;
  v_vendor uuid;
  v_po uuid;
  v_po_line1 uuid; v_po_line2 uuid;
  v_hold_reason uuid;
BEGIN
  SELECT business_id, organization_id, branch_id
    INTO v_biz, v_org, v_branch
    FROM public._wms_caller_business_branch();

  IF v_biz IS NULL THEN
    RAISE EXCEPTION 'caller has no business access' USING ERRCODE='42501';
  END IF;
  IF v_branch IS NULL THEN
    RAISE EXCEPTION 'business % has no branches; create one before running the E2E seed', v_biz
      USING ERRCODE='P0001';
  END IF;

  SELECT id INTO v_wh FROM public.warehouses
   WHERE business_id = v_biz AND code = 'E2E_WH';
  IF v_wh IS NULL THEN
    INSERT INTO public.warehouses(organization_id, business_id, branch_id, code, name,
                                  is_active, is_sample_data)
    VALUES (v_org, v_biz, v_branch, 'E2E_WH', 'E2E Warehouse', true, true)
    RETURNING id INTO v_wh;
  END IF;

  SELECT id INTO v_loc_in FROM public.stock_locations
   WHERE business_id = v_biz AND warehouse_id = v_wh AND code = 'E2E_INBOUND';
  IF v_loc_in IS NULL THEN
    INSERT INTO public.stock_locations(organization_id, business_id, branch_id, warehouse_id,
      code, name, location_type, usage, is_active, is_receiving_staging, structure_level)
    VALUES (v_org, v_biz, v_branch, v_wh, 'E2E_INBOUND', 'E2E Inbound Staging',
            'internal', 'internal', true, true, 'zone')
    RETURNING id INTO v_loc_in;
  END IF;

  SELECT id INTO v_loc_stock FROM public.stock_locations
   WHERE business_id = v_biz AND warehouse_id = v_wh AND code = 'E2E_STOCK';
  IF v_loc_stock IS NULL THEN
    INSERT INTO public.stock_locations(organization_id, business_id, branch_id, warehouse_id,
      code, name, location_type, usage, is_active, is_putaway_target, pick_sequence, structure_level)
    VALUES (v_org, v_biz, v_branch, v_wh, 'E2E_STOCK', 'E2E Stock Bin A1',
            'internal', 'internal', true, true, 10, 'bin')
    RETURNING id INTO v_loc_stock;
  END IF;

  SELECT id INTO v_loc_out FROM public.stock_locations
   WHERE business_id = v_biz AND warehouse_id = v_wh AND code = 'E2E_OUTBOUND';
  IF v_loc_out IS NULL THEN
    INSERT INTO public.stock_locations(organization_id, business_id, branch_id, warehouse_id,
      code, name, location_type, usage, is_active, structure_level)
    VALUES (v_org, v_biz, v_branch, v_wh, 'E2E_OUTBOUND', 'E2E Outbound Staging',
            'internal', 'internal', true, 'zone')
    RETURNING id INTO v_loc_out;
  END IF;

  SELECT id INTO v_prod_a FROM public.products
   WHERE business_id = v_biz AND sku = 'E2E-SKU-A';
  IF v_prod_a IS NULL THEN
    INSERT INTO public.products(organization_id, business_id, name, sku, type, unit_price,
                                is_active, track_inventory, is_sample_data)
    VALUES (v_org, v_biz, 'E2E Product A', 'E2E-SKU-A', 'good', 10.00, true, true, true)
    RETURNING id INTO v_prod_a;
  END IF;

  SELECT id INTO v_prod_b FROM public.products
   WHERE business_id = v_biz AND sku = 'E2E-SKU-B';
  IF v_prod_b IS NULL THEN
    INSERT INTO public.products(organization_id, business_id, name, sku, type, unit_price,
                                is_active, track_inventory, is_sample_data)
    VALUES (v_org, v_biz, 'E2E Product B', 'E2E-SKU-B', 'good', 20.00, true, true, true)
    RETURNING id INTO v_prod_b;
  END IF;

  SELECT id INTO v_vendor FROM public.contacts
   WHERE business_id = v_biz AND name = 'E2E Vendor' AND type = 'vendor';
  IF v_vendor IS NULL THEN
    INSERT INTO public.contacts(organization_id, business_id, name, type, is_company,
                                supplier_rank, is_sample_data)
    VALUES (v_org, v_biz, 'E2E Vendor', 'vendor', true, 1, true)
    RETURNING id INTO v_vendor;
  END IF;

  SELECT id INTO v_po FROM public.purchase_orders
   WHERE business_id = v_biz AND po_number = 'E2E-PO-0001';
  IF v_po IS NULL THEN
    INSERT INTO public.purchase_orders(organization_id, business_id, branch_id, vendor_id,
      po_number, status, order_date, subtotal, total, is_sample_data)
    VALUES (v_org, v_biz, v_branch, v_vendor, 'E2E-PO-0001', 'confirmed', CURRENT_DATE,
            100, 100, true)
    RETURNING id INTO v_po;

    INSERT INTO public.purchase_order_items(purchase_order_id, product_id, description,
      quantity, unit_price, line_total, sort_order, is_sample_data)
    VALUES (v_po, v_prod_a, 'E2E Product A', 5, 10.00, 50.00, 1, true)
    RETURNING id INTO v_po_line1;

    INSERT INTO public.purchase_order_items(purchase_order_id, product_id, description,
      quantity, unit_price, line_total, sort_order, is_sample_data)
    VALUES (v_po, v_prod_b, 'E2E Product B', 5, 20.00, 100.00, 2, true)
    RETURNING id INTO v_po_line2;
  END IF;

  -- 14f: ensure at least one QC hold reason exists for the caller's business.
  SELECT id INTO v_hold_reason FROM public.wms_qc_hold_reasons
   WHERE business_id = v_biz AND code = 'E2E_HOLD';
  IF v_hold_reason IS NULL THEN
    INSERT INTO public.wms_qc_hold_reasons(organization_id, business_id, code, label,
                                           severity, is_active)
    VALUES (v_org, v_biz, 'E2E_HOLD', 'E2E hold reason', 'minor', true)
    RETURNING id INTO v_hold_reason;
  END IF;

  RETURN jsonb_build_object(
    'business_id', v_biz,
    'branch_id', v_branch,
    'warehouse_id', v_wh,
    'locations', jsonb_build_object('inbound', v_loc_in, 'stock', v_loc_stock, 'outbound', v_loc_out),
    'products', jsonb_build_array(v_prod_a, v_prod_b),
    'vendor_id', v_vendor,
    'purchase_order_id', v_po,
    'qc_hold_reason_id', v_hold_reason
  );
END $$;

GRANT EXECUTE ON FUNCTION public.wms_e2e_ensure_seed() TO authenticated;