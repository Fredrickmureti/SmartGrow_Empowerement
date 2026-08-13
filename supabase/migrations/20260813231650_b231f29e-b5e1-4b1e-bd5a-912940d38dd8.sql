CREATE OR REPLACE FUNCTION public.save_product_atomic(
  p_product jsonb,
  p_product_id uuid DEFAULT NULL,
  p_packaging jsonb DEFAULT '[]'::jsonb,
  p_physical jsonb DEFAULT '[]'::jsonb,
  p_identifiers jsonb DEFAULT '[]'::jsonb
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
  v_key_map    jsonb := '{}'::jsonb;   -- client_key -> packaging uuid
  v_pack_id    uuid;
  v_ident_id   uuid;
  v_pack_ref   text;
  v_cols       text[];
  v_sql        text;
  v_phys_id    uuid;
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
    IF v_biz IS NULL THEN
      RAISE EXCEPTION 'PRODUCT_PAYLOAD_INVALID: business_id is required'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  PERFORM public._assert_org_member(v_biz);

  ------------------------------------------------------------------
  -- 1. Product master
  ------------------------------------------------------------------
  SELECT array_agg(quote_ident(k))
    INTO v_cols
  FROM jsonb_object_keys(p_product) AS k
  WHERE k IN (
    SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='products'
  )
    AND k NOT IN ('id','created_at','updated_at');

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

  ------------------------------------------------------------------
  -- 2. Packaging levels (parents first: caller order is respected)
  ------------------------------------------------------------------
  FOR v_row IN SELECT * FROM jsonb_array_elements(coalesce(p_packaging,'[]'::jsonb)) LOOP
    v_pack_id := nullif(v_row->>'id','')::uuid;

    -- resolve a parent given either a uuid or a client_key from this payload
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

  ------------------------------------------------------------------
  -- 3. Physical attributes
  ------------------------------------------------------------------
  FOR v_row IN SELECT * FROM jsonb_array_elements(coalesce(p_physical,'[]'::jsonb)) LOOP
    v_phys_id := nullif(v_row->>'id','')::uuid;
    v_pack_ref := coalesce(
      nullif(v_row->>'packaging_id',''),
      v_key_map->>coalesce(v_row->>'packaging_client_key','')
    );

    IF coalesce((v_row->>'_delete')::boolean, false) THEN
      IF v_phys_id IS NOT NULL THEN
        DELETE FROM public.product_physical_attributes
         WHERE id = v_phys_id AND product_id = v_product_id;
      END IF;
      CONTINUE;
    END IF;

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
    )
    ON CONFLICT (product_id, coalesce(packaging_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO UPDATE SET
      net_weight          = EXCLUDED.net_weight,
      net_weight_uom_id   = EXCLUDED.net_weight_uom_id,
      tare_weight         = EXCLUDED.tare_weight,
      tare_weight_uom_id  = EXCLUDED.tare_weight_uom_id,
      volume              = EXCLUDED.volume,
      volume_uom_id       = EXCLUDED.volume_uom_id,
      length              = EXCLUDED.length,
      width               = EXCLUDED.width,
      height              = EXCLUDED.height,
      dimension_uom_id    = EXCLUDED.dimension_uom_id,
      updated_at          = now();
  END LOOP;

  ------------------------------------------------------------------
  -- 4. Identifiers — reuse the canonical write RPC so lifecycle,
  --    primary-label and supplier-scope invariants stay in one place.
  ------------------------------------------------------------------
  FOR v_row IN SELECT * FROM jsonb_array_elements(coalesce(p_identifiers,'[]'::jsonb)) LOOP
    v_pack_ref := coalesce(
      nullif(v_row->>'packaging_id',''),
      v_key_map->>coalesce(v_row->>'packaging_client_key','')
    );

    IF coalesce((v_row->>'_retire')::boolean, false) THEN
      PERFORM public.retire_product_identifier(nullif(v_row->>'id','')::uuid);
      CONTINUE;
    END IF;

    IF nullif(btrim(coalesce(v_row->>'code','')),'') IS NULL THEN
      CONTINUE;
    END IF;

    v_ident_id := public.upsert_product_identifier(
      v_biz,
      v_product_id,
      v_row->>'code',
      coalesce(v_row->>'kind','gtin'),
      coalesce((v_row->>'is_primary')::boolean, false),
      v_pack_ref::uuid,
      nullif(v_row->>'supplier_id','')::uuid
    );
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'product_id', v_product_id,
    'packaging_keys', v_key_map
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.save_product_atomic(jsonb, uuid, jsonb, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_product_atomic(jsonb, uuid, jsonb, jsonb, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.save_product_atomic(jsonb, uuid, jsonb, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_product_atomic(jsonb, uuid, jsonb, jsonb, jsonb) TO service_role;