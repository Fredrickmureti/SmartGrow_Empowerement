-- 1. save_product_atomic gains a localization payload (old 5-arg signature dropped
--    so PostgREST has exactly one candidate).
DROP FUNCTION IF EXISTS public.save_product_atomic(jsonb, uuid, jsonb, jsonb, jsonb);

CREATE OR REPLACE FUNCTION public.save_product_atomic(
  p_product jsonb,
  p_product_id uuid DEFAULT NULL::uuid,
  p_packaging jsonb DEFAULT '[]'::jsonb,
  p_physical jsonb DEFAULT '[]'::jsonb,
  p_identifiers jsonb DEFAULT '[]'::jsonb,
  p_localization jsonb DEFAULT NULL::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org        uuid;
  v_biz        uuid;
  v_product_id uuid := p_product_id;
  v_row        jsonb;
  v_key_map    jsonb := '{}'::jsonb;
  v_pack_id    uuid;
  v_pack_ref   text;
  v_cols       text[];
  v_sql        text;
  v_phys_id    uuid;
  v_loc        jsonb;
BEGIN
  IF p_product IS NULL OR jsonb_typeof(p_product) <> 'object' THEN
    RAISE EXCEPTION 'PRODUCT_PAYLOAD_INVALID: p_product must be a JSON object'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_product_id IS NOT NULL THEN
    SELECT organization_id, business_id INTO v_org, v_biz
      FROM public.products WHERE id = v_product_id;
    IF v_biz IS NULL THEN
      RAISE EXCEPTION 'PRODUCT_NOT_FOUND: product does not exist'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    v_org := nullif(p_product->>'organization_id','')::uuid;
    v_biz := nullif(p_product->>'business_id','')::uuid;
    IF v_biz IS NULL OR v_org IS NULL THEN
      RAISE EXCEPTION 'PRODUCT_PAYLOAD_INVALID: organization_id and business_id are required'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  PERFORM public._assert_org_member(v_org);

  -- Legacy callers may still send etims_* keys on the master; route them to the
  -- localization extension instead of silently dropping them.
  v_loc := coalesce(p_localization, '{}'::jsonb);
  IF p_product ? 'etims_classification_code' AND NOT (v_loc ? 'classification_code') THEN
    v_loc := v_loc || jsonb_build_object('classification_code', p_product->>'etims_classification_code');
  END IF;
  IF p_product ? 'etims_unit_code' AND NOT (v_loc ? 'unit_code') THEN
    v_loc := v_loc || jsonb_build_object('unit_code', p_product->>'etims_unit_code');
  END IF;
  IF p_product ? 'etims_packaging_unit' AND NOT (v_loc ? 'packaging_unit') THEN
    v_loc := v_loc || jsonb_build_object('packaging_unit', p_product->>'etims_packaging_unit');
  END IF;
  IF (p_product ? 'etims_country_origin' OR p_product ? 'etims_origin_country')
     AND NOT (v_loc ? 'origin_country') THEN
    v_loc := v_loc || jsonb_build_object('origin_country',
      coalesce(nullif(p_product->>'etims_origin_country',''), p_product->>'etims_country_origin'));
  END IF;
  IF v_loc = '{}'::jsonb THEN
    v_loc := NULL;
  END IF;

  -- 1. Product master
  SELECT array_agg(quote_ident(k))
    INTO v_cols
  FROM jsonb_object_keys(p_product) AS k
  WHERE k IN (
    SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='products'
  )
    AND k NOT IN ('id','created_at','updated_at','archived_at','archived_by');

  IF v_cols IS NULL OR array_length(v_cols,1) = 0 THEN
    RAISE EXCEPTION 'PRODUCT_PAYLOAD_INVALID: no writable product columns supplied'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_product_id IS NULL THEN
    v_sql := format(
      'INSERT INTO public.products (%s) SELECT %s FROM jsonb_populate_record(null::public.products, $1) RETURNING id',
      array_to_string(v_cols, ', '), array_to_string(v_cols, ', '));
    EXECUTE v_sql USING p_product INTO v_product_id;
  ELSE
    v_sql := format(
      'UPDATE public.products p SET (%s) = (SELECT %s FROM jsonb_populate_record(null::public.products, $1)) WHERE p.id = $2',
      array_to_string(v_cols, ', '), array_to_string(v_cols, ', '));
    EXECUTE v_sql USING p_product, v_product_id;
  END IF;

  -- 2. Packaging levels (caller supplies parents before children)
  FOR v_row IN SELECT * FROM jsonb_array_elements(coalesce(p_packaging,'[]'::jsonb)) LOOP
    v_pack_id := nullif(v_row->>'id','')::uuid;
    v_pack_ref := coalesce(
      nullif(v_row->>'parent_packaging_id',''),
      v_key_map->>coalesce(v_row->>'parent_client_key','')
    );

    IF v_pack_id IS NULL THEN
      INSERT INTO public.product_packaging (
        organization_id, business_id, product_id, name, qty_in_base_uom,
        is_purchase_default, is_sales_default,
        parent_packaging_id, qty_in_parent, is_shipping_unit
      ) VALUES (
        v_org, v_biz, v_product_id,
        btrim(v_row->>'name'),
        (v_row->>'qty_in_base_uom')::numeric,
        coalesce((v_row->>'is_purchase_default')::boolean, false),
        coalesce((v_row->>'is_sales_default')::boolean, false),
        v_pack_ref::uuid,
        nullif(v_row->>'qty_in_parent','')::numeric,
        coalesce((v_row->>'is_shipping_unit')::boolean, false)
      )
      RETURNING id INTO v_pack_id;
    ELSE
      UPDATE public.product_packaging SET
        name                = btrim(v_row->>'name'),
        qty_in_base_uom     = (v_row->>'qty_in_base_uom')::numeric,
        is_purchase_default = coalesce((v_row->>'is_purchase_default')::boolean, false),
        is_sales_default    = coalesce((v_row->>'is_sales_default')::boolean, false),
        parent_packaging_id = v_pack_ref::uuid,
        qty_in_parent       = nullif(v_row->>'qty_in_parent','')::numeric,
        is_shipping_unit    = coalesce((v_row->>'is_shipping_unit')::boolean, false),
        updated_at          = now()
      WHERE id = v_pack_id AND product_id = v_product_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'PACKAGING_SCOPE: packaging level does not belong to this product'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    IF nullif(v_row->>'client_key','') IS NOT NULL THEN
      v_key_map := v_key_map || jsonb_build_object(v_row->>'client_key', v_pack_id::text);
    END IF;
  END LOOP;

  -- 3. Physical attributes (partial unique indexes: match by hand)
  FOR v_row IN SELECT * FROM jsonb_array_elements(coalesce(p_physical,'[]'::jsonb)) LOOP
    v_phys_id := nullif(v_row->>'id','')::uuid;
    v_pack_ref := coalesce(
      nullif(v_row->>'packaging_id',''),
      v_key_map->>coalesce(v_row->>'packaging_client_key','')
    );

    IF coalesce((v_row->>'_delete')::boolean, false) THEN
      DELETE FROM public.product_physical_attributes
       WHERE product_id = v_product_id
         AND (
           (v_phys_id IS NOT NULL AND id = v_phys_id)
           OR (v_phys_id IS NULL AND packaging_id IS NOT DISTINCT FROM v_pack_ref::uuid)
         );
      CONTINUE;
    END IF;

    IF v_phys_id IS NULL THEN
      SELECT id INTO v_phys_id
        FROM public.product_physical_attributes
       WHERE product_id = v_product_id
         AND packaging_id IS NOT DISTINCT FROM v_pack_ref::uuid;
    END IF;

    IF v_phys_id IS NULL THEN
      INSERT INTO public.product_physical_attributes (
        organization_id, business_id, product_id, packaging_id,
        net_weight, net_weight_uom_id, tare_weight, tare_weight_uom_id,
        volume, volume_uom_id, length, width, height, dimension_uom_id
      ) VALUES (
        v_org, v_biz, v_product_id, v_pack_ref::uuid,
        nullif(v_row->>'net_weight','')::numeric,
        nullif(v_row->>'net_weight_uom_id','')::uuid,
        nullif(v_row->>'tare_weight','')::numeric,
        nullif(v_row->>'tare_weight_uom_id','')::uuid,
        nullif(v_row->>'volume','')::numeric,
        nullif(v_row->>'volume_uom_id','')::uuid,
        nullif(v_row->>'length','')::numeric,
        nullif(v_row->>'width','')::numeric,
        nullif(v_row->>'height','')::numeric,
        nullif(v_row->>'dimension_uom_id','')::uuid
      );
    ELSE
      UPDATE public.product_physical_attributes SET
        net_weight          = nullif(v_row->>'net_weight','')::numeric,
        net_weight_uom_id   = nullif(v_row->>'net_weight_uom_id','')::uuid,
        tare_weight         = nullif(v_row->>'tare_weight','')::numeric,
        tare_weight_uom_id  = nullif(v_row->>'tare_weight_uom_id','')::uuid,
        volume              = nullif(v_row->>'volume','')::numeric,
        volume_uom_id       = nullif(v_row->>'volume_uom_id','')::uuid,
        length              = nullif(v_row->>'length','')::numeric,
        width               = nullif(v_row->>'width','')::numeric,
        height              = nullif(v_row->>'height','')::numeric,
        dimension_uom_id    = nullif(v_row->>'dimension_uom_id','')::uuid,
        updated_at          = now()
      WHERE id = v_phys_id AND product_id = v_product_id;
    END IF;
  END LOOP;

  -- 4. Identifiers through the canonical write RPCs
  FOR v_row IN SELECT * FROM jsonb_array_elements(coalesce(p_identifiers,'[]'::jsonb)) LOOP
    v_pack_ref := coalesce(
      nullif(v_row->>'packaging_id',''),
      v_key_map->>coalesce(v_row->>'packaging_client_key','')
    );

    IF coalesce((v_row->>'_retire')::boolean, false) THEN
      IF nullif(v_row->>'id','') IS NOT NULL THEN
        PERFORM public.retire_product_identifier(
          p_business_id   => v_biz,
          p_identifier_id => (v_row->>'id')::uuid
        );
      END IF;
      CONTINUE;
    END IF;

    IF nullif(btrim(coalesce(v_row->>'code','')),'') IS NULL THEN
      CONTINUE;
    END IF;

    PERFORM public.upsert_product_identifier(
      p_business_id   => v_biz,
      p_product_id    => v_product_id,
      p_code          => v_row->>'code',
      p_kind          => coalesce(nullif(v_row->>'kind',''),'gtin')::product_identifier_kind,
      p_packaging_id  => v_pack_ref::uuid,
      p_is_primary    => coalesce((v_row->>'is_primary')::boolean, false),
      p_supplier_id   => nullif(v_row->>'supplier_id','')::uuid,
      p_identifier_id => nullif(v_row->>'id','')::uuid
    );
  END LOOP;

  -- 5. Tax localization extension (same transaction)
  IF v_loc IS NOT NULL THEN
    PERFORM public.upsert_product_tax_localization(v_product_id, v_loc);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'product_id', v_product_id,
    'packaging_keys', v_key_map
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.save_product_atomic(jsonb, uuid, jsonb, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_product_atomic(jsonb, uuid, jsonb, jsonb, jsonb, jsonb) TO authenticated, service_role;

-- 2. Opening-stock creation writes localization to the extension table
CREATE OR REPLACE FUNCTION public.create_product_with_opening_stock_atomic(p_product jsonb, p_opening_items jsonb, p_user_id uuid)
 RETURNS jsonb
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
  v_jur text;
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

  -- Country-specific fiscal metadata lives in the localization extension
  v_jur := COALESCE(
    NULLIF(btrim(COALESCE(p_product->'localization'->>'jurisdiction','')),''),
    NULLIF(btrim(COALESCE(p_product->'localization'->>'origin_country','')),''),
    NULLIF(btrim(COALESCE(p_product->>'etims_origin_country','')),''),
    NULLIF(btrim(COALESCE(p_product->>'etims_country_origin','')),''),
    'KE');

  INSERT INTO public.product_tax_localization (
    organization_id, business_id, product_id, jurisdiction,
    classification_code, unit_code, packaging_unit, origin_country
  ) VALUES (
    v_org_id, v_biz_id, v_product_id, v_jur,
    COALESCE(
      NULLIF(btrim(COALESCE(p_product->'localization'->>'classification_code','')),''),
      NULLIF(btrim(COALESCE(p_product->>'etims_classification_code','')),'')),
    COALESCE(
      NULLIF(btrim(COALESCE(p_product->'localization'->>'unit_code','')),''),
      NULLIF(btrim(COALESCE(p_product->>'etims_unit_code','')),''), 'U'),
    COALESCE(
      NULLIF(btrim(COALESCE(p_product->'localization'->>'packaging_unit','')),''),
      NULLIF(btrim(COALESCE(p_product->>'etims_packaging_unit','')),''), 'CT'),
    v_jur
  )
  ON CONFLICT (product_id, jurisdiction) DO NOTHING;

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

-- 3. The product master no longer carries one country's tax vocabulary
ALTER TABLE public.products
  DROP COLUMN IF EXISTS etims_classification_code,
  DROP COLUMN IF EXISTS etims_item_code,
  DROP COLUMN IF EXISTS etims_unit_code,
  DROP COLUMN IF EXISTS etims_packaging_unit,
  DROP COLUMN IF EXISTS etims_origin_country,
  DROP COLUMN IF EXISTS etims_country_origin,
  DROP COLUMN IF EXISTS etims_registration_status,
  DROP COLUMN IF EXISTS etims_registered_at;