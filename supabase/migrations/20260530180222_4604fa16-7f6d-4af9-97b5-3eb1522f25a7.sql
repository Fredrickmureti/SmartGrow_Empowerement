CREATE OR REPLACE FUNCTION public.create_product_with_opening_stock_atomic(
  p_product jsonb,
  p_opening_items jsonb,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id uuid := NULLIF(p_product->>'organization_id','')::uuid;
  v_biz_id uuid := NULLIF(p_product->>'business_id','')::uuid;
  v_track  boolean := COALESCE((p_product->>'track_inventory')::boolean, false);
  v_cost   numeric := COALESCE((p_product->>'cost_price')::numeric, 0);
  v_product_id uuid;
  v_can_write boolean;
  v_item jsonb;
  v_wh RECORD;
  v_items_arr jsonb := COALESCE(p_opening_items, '[]'::jsonb);
  v_has_opening boolean := false;
  v_adj_input jsonb;
  v_adj_items jsonb;
  v_adj_number text;
  v_client_request_id uuid;
  v_adj_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_wh_id uuid;
  v_failed text;
  v_line_cost numeric;
BEGIN
  IF v_org_id IS NULL OR v_biz_id IS NULL THEN
    RAISE EXCEPTION 'organization_id and business_id are required';
  END IF;
  IF NULLIF(p_product->>'name','') IS NULL THEN
    RAISE EXCEPTION 'product name is required';
  END IF;

  v_can_write := public.user_has_module_permission(p_user_id, v_org_id, 'inventory', 'write');
  IF NOT v_can_write THEN
    RAISE EXCEPTION 'You do not have permission to create products';
  END IF;

  FOR v_item IN SELECT jsonb_array_elements(v_items_arr) LOOP
    IF COALESCE((v_item->>'quantity_adjustment')::numeric, 0) > 0 THEN
      v_has_opening := true;
      EXIT;
    END IF;
  END LOOP;

  IF v_has_opening AND NOT v_track THEN
    RAISE EXCEPTION 'Opening stock requires track_inventory = true';
  END IF;

  IF v_has_opening THEN
    FOR v_item IN SELECT jsonb_array_elements(v_items_arr) LOOP
      IF COALESCE((v_item->>'quantity_adjustment')::numeric, 0) > 0 THEN
        v_wh_id := NULLIF(v_item->>'warehouse_id','')::uuid;
        IF v_wh_id IS NULL THEN
          RAISE EXCEPTION 'Warehouse is required for opening stock';
        END IF;

        SELECT id, organization_id, business_id, branch_id, COALESCE(is_in_transit,false) AS is_in_transit
          INTO v_wh
          FROM public.warehouses
         WHERE id = v_wh_id;

        IF v_wh.id IS NULL THEN
          RAISE EXCEPTION 'Warehouse % not found', v_wh_id;
        END IF;
        IF v_wh.organization_id <> v_org_id OR v_wh.business_id <> v_biz_id THEN
          RAISE EXCEPTION 'Warehouse % belongs to a different organization/company', v_wh_id;
        END IF;
        IF v_wh.is_in_transit THEN
          RAISE EXCEPTION 'Cannot use the in-transit warehouse for opening stock';
        END IF;
        IF v_wh.branch_id IS NULL THEN
          RAISE EXCEPTION 'Cannot resolve branch for warehouse %', v_wh_id;
        END IF;

        v_line_cost := COALESCE((v_item->>'unit_cost')::numeric, v_cost, 0);
        IF v_line_cost IS NULL OR v_line_cost <= 0 THEN
          RAISE EXCEPTION
            'OPENING_STOCK_REQUIRES_COST: opening stock for warehouse % needs a positive unit cost. Set the product cost or enter a per-warehouse unit cost.',
            v_wh_id
          USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO public.products (
    organization_id,
    business_id,
    name,
    description,
    type,
    sku,
    unit_price,
    cost_price,
    tax_rate,
    image_url,
    track_inventory,
    reorder_level,
    reorder_quantity,
    min_order_quantity,
    order_quantity_increment,
    category_id,
    sales_account_id,
    purchase_account_id,
    cogs_account_id,
    inventory_account_id,
    tax_rate_id,
    etims_classification_code,
    etims_unit_code,
    etims_packaging_unit,
    etims_country_origin,
    plu_code,
    base_uom_id,
    sales_uom_id,
    purchase_uom_id,
    is_lot_tracked,
    is_expiry_tracked,
    expiry_alert_days,
    is_active
  ) VALUES (
    v_org_id,
    v_biz_id,
    p_product->>'name',
    NULLIF(p_product->>'description',''),
    COALESCE(NULLIF(p_product->>'type','')::product_type, 'service'),
    NULLIF(p_product->>'sku',''),
    COALESCE((p_product->>'unit_price')::numeric, 0),
    v_cost,
    COALESCE((p_product->>'tax_rate')::numeric, 0),
    NULLIF(p_product->>'image_url',''),
    v_track,
    COALESCE((p_product->>'reorder_level')::numeric, 0),
    COALESCE((p_product->>'reorder_quantity')::numeric, 0),
    COALESCE((p_product->>'min_order_quantity')::numeric, 1),
    COALESCE((p_product->>'order_quantity_increment')::numeric, 1),
    NULLIF(p_product->>'category_id','')::uuid,
    NULLIF(p_product->>'sales_account_id','')::uuid,
    NULLIF(p_product->>'purchase_account_id','')::uuid,
    NULLIF(p_product->>'cogs_account_id','')::uuid,
    NULLIF(p_product->>'inventory_account_id','')::uuid,
    NULLIF(p_product->>'tax_rate_id','')::uuid,
    NULLIF(p_product->>'etims_classification_code',''),
    COALESCE(NULLIF(p_product->>'etims_unit_code',''), 'U'),
    COALESCE(NULLIF(p_product->>'etims_packaging_unit',''), 'CT'),
    COALESCE(NULLIF(p_product->>'etims_country_origin',''), 'KE'),
    NULLIF(p_product->>'plu_code',''),
    NULLIF(p_product->>'base_uom_id','')::uuid,
    NULLIF(p_product->>'sales_uom_id','')::uuid,
    NULLIF(p_product->>'purchase_uom_id','')::uuid,
    COALESCE((p_product->>'is_lot_tracked')::boolean, false),
    COALESCE((p_product->>'is_expiry_tracked')::boolean, false),
    GREATEST(COALESCE((p_product->>'expiry_alert_days')::integer, 30), 0),
    COALESCE((p_product->>'is_active')::boolean, true)
  )
  RETURNING id INTO v_product_id;

  IF v_has_opening THEN
    FOR v_wh IN
      SELECT DISTINCT w.id, w.branch_id
      FROM jsonb_array_elements(v_items_arr) AS i
      JOIN public.warehouses w ON w.id = (i->>'warehouse_id')::uuid
      WHERE COALESCE((i->>'quantity_adjustment')::numeric, 0) > 0
      ORDER BY w.id
    LOOP
      v_adj_items := '[]'::jsonb;

      FOR v_item IN SELECT jsonb_array_elements(v_items_arr) LOOP
        IF COALESCE((v_item->>'quantity_adjustment')::numeric, 0) > 0
           AND (v_item->>'warehouse_id')::uuid = v_wh.id THEN
          v_adj_items := v_adj_items || jsonb_build_array(jsonb_build_object(
            'product_id', v_product_id,
            'warehouse_id', v_wh.id,
            'quantity_adjustment', (v_item->>'quantity_adjustment')::numeric,
            'unit_cost', COALESCE((v_item->>'unit_cost')::numeric, v_cost, 0)
          ));
        END IF;
      END LOOP;

      v_adj_number := public.get_next_adjustment_number(v_org_id, v_biz_id);
      v_client_request_id := gen_random_uuid();

      v_adj_input := jsonb_build_object(
        'organization_id', v_org_id,
        'business_id', v_biz_id,
        'branch_id', v_wh.branch_id,
        'warehouse_id', v_wh.id,
        'adjustment_number', v_adj_number,
        'reason', 'opening_balance',
        'notes', 'Opening balance for ' || (p_product->>'name'),
        'client_request_id', v_client_request_id,
        'items', v_adj_items
      );

      v_adj_result := public.apply_or_request_stock_adjustment(v_adj_input, p_user_id);

      IF NOT COALESCE((v_adj_result->>'success')::boolean, false) THEN
        v_failed := COALESCE(v_adj_result->>'error', 'unknown error');
        RAISE EXCEPTION 'Opening stock failed for warehouse %: %', v_wh.id, v_failed;
      END IF;

      v_results := v_results || jsonb_build_array(
        jsonb_build_object('warehouse_id', v_wh.id, 'branch_id', v_wh.branch_id, 'result', v_adj_result)
      );
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'product_id', v_product_id,
    'opening_stock', CASE
      WHEN jsonb_array_length(v_results) = 0 THEN NULL
      WHEN jsonb_array_length(v_results) = 1 THEN v_results->0->'result'
      ELSE jsonb_build_object(
        'success', true,
        'adjustments', v_results,
        'requires_approval', EXISTS (
          SELECT 1 FROM jsonb_array_elements(v_results) r
          WHERE COALESCE((r->'result'->>'requires_approval')::boolean, false)
        )
      )
    END
  );
END;
$function$;

COMMENT ON FUNCTION public.create_product_with_opening_stock_atomic(jsonb, jsonb, uuid) IS
  'Atomic product + opening stock create path aligned with the current products schema, including UoM and lot/expiry fields, while preserving strict opening-stock validation and GL posting.';