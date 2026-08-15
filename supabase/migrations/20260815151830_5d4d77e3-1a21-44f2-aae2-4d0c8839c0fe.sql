-- 1. set_invoice_status_atomic: pass the acting user to user_has_business_access
CREATE OR REPLACE FUNCTION public.set_invoice_status_atomic(p_invoice_id uuid, p_status text, p_user_id uuid DEFAULT auth.uid())
 RETURNS invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inv public.invoices%ROWTYPE;
  v_target public.invoice_status;
  v_old text;
  v_actor uuid := COALESCE(p_user_id, auth.uid());
BEGIN
  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'set_invoice_status_atomic: invoice % not found', p_invoice_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_actor IS NULL OR NOT public.user_has_business_access(v_actor, v_inv.business_id) THEN
    RAISE EXCEPTION 'set_invoice_status_atomic: not authorized for this business'
      USING ERRCODE = '42501';
  END IF;

  v_target := (CASE WHEN p_status = 'confirmed' THEN 'sent' ELSE p_status END)::public.invoice_status;
  v_old := v_inv.status::text;

  IF v_target::text = v_old THEN
    RETURN v_inv;
  END IF;

  IF v_old = 'draft' AND v_target::text NOT IN ('cancelled') THEN
    RAISE EXCEPTION
      'Invoice % is a draft — confirm it (confirm_invoice_atomic) before moving it to %.',
      v_inv.invoice_number, v_target
      USING ERRCODE = '42501';
  END IF;

  IF v_old IN ('paid', 'voided', 'cancelled') THEN
    RAISE EXCEPTION
      'Invoice % is %; it may only be corrected by a credit note or reversal, not by a status change.',
      v_inv.invoice_number, v_old
      USING ERRCODE = '42501';
  END IF;

  IF v_target::text IN ('partial', 'paid') THEN
    RAISE EXCEPTION
      'Invoice % — settlement status is derived from payments; record or unapply a payment instead.',
      v_inv.invoice_number
      USING ERRCODE = '42501';
  END IF;

  IF v_target::text IN ('voided') THEN
    RAISE EXCEPTION
      'Invoice % — use void_invoice_atomic to void an invoice.', v_inv.invoice_number
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.invoices
     SET status = v_target,
         updated_at = now()
   WHERE id = p_invoice_id
  RETURNING * INTO v_inv;

  RETURN v_inv;
END;
$function$;

-- 2. Pack provenance must be resolved BEFORE the ledger snapshot is frozen.
--    Previously this ran AFTER INSERT, so _stamp_ledger_uom_snapshot had already
--    written pack_name = NULL / factor = 1 / display = base quantity.
CREATE OR REPLACE FUNCTION public._backfill_movement_packaging()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_pkg uuid; v_uom uuid;
BEGIN
  IF NEW.reference_id IS NULL OR NEW.product_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.source_packaging_id IS NOT NULL AND NEW.source_uom_id IS NOT NULL THEN RETURN NEW; END IF;

  CASE NEW.reference_type
    WHEN 'invoice' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom FROM public.invoice_items
       WHERE invoice_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST LIMIT 1;
    WHEN 'delivery_note' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom FROM public.delivery_note_items
       WHERE delivery_note_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST LIMIT 1;
    WHEN 'goods_receipt' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom FROM public.goods_receipt_items
       WHERE goods_receipt_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST LIMIT 1;
    WHEN 'stock_adjustment' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom FROM public.stock_adjustment_items
       WHERE adjustment_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST LIMIT 1;
    WHEN 'stock_transfer' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom FROM public.stock_transfer_items
       WHERE transfer_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST LIMIT 1;
    WHEN 'pos_transaction' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom FROM public.pos_transaction_items
       WHERE transaction_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST LIMIT 1;
    WHEN 'sales_return' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom FROM public.sales_return_items
       WHERE return_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST LIMIT 1;
    WHEN 'purchase_return' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom FROM public.purchase_return_items
       WHERE return_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST LIMIT 1;
    WHEN 'credit_note' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom FROM public.credit_note_items
       WHERE credit_note_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST LIMIT 1;
    WHEN 'bill' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom FROM public.bill_items
       WHERE bill_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST LIMIT 1;
    ELSE
      RETURN NEW;
  END CASE;

  NEW.source_packaging_id := COALESCE(NEW.source_packaging_id, v_pkg);
  NEW.source_uom_id       := COALESCE(NEW.source_uom_id, v_uom);
  RETURN NEW;
END; $function$;

DROP TRIGGER IF EXISTS trg_backfill_movement_packaging ON public.stock_movements;
-- Name matters: BEFORE triggers fire alphabetically, so trg_backfill_* must
-- precede trg_stamp_ledger_uom_snapshot.
CREATE TRIGGER trg_backfill_movement_packaging
BEFORE INSERT ON public.stock_movements
FOR EACH ROW EXECUTE FUNCTION public._backfill_movement_packaging();

-- 3. Integrality guard: countable base units (rounding >= 1) cannot move in fractions.
CREATE OR REPLACE FUNCTION public._enforce_movement_uom_granularity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_round numeric; v_code text;
BEGIN
  IF NEW.product_id IS NULL OR NEW.quantity IS NULL THEN RETURN NEW; END IF;

  SELECT u.rounding, COALESCE(u.code, u.name)
    INTO v_round, v_code
    FROM public.products p
    JOIN public.units_of_measure u ON u.id = p.base_uom_id
   WHERE p.id = NEW.product_id;

  IF v_round IS NULL OR v_round < 1 THEN RETURN NEW; END IF;

  IF mod(ABS(NEW.quantity)::numeric, v_round) <> 0 THEN
    RAISE EXCEPTION
      'Quantity % is not valid for a countable unit (%): it must be a whole multiple of %.',
      NEW.quantity, COALESCE(v_code, 'unit'), v_round
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END; $function$;

DROP TRIGGER IF EXISTS trg_enforce_movement_uom_granularity ON public.stock_movements;
CREATE TRIGGER trg_enforce_movement_uom_granularity
BEFORE INSERT ON public.stock_movements
FOR EACH ROW EXECUTE FUNCTION public._enforce_movement_uom_granularity();

-- 4. Opening stock: reject mis-keyed payloads instead of silently creating zero stock.
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

  -- Payload shape guard: an opening line MUST carry quantity_adjustment.
  -- Previously a line keyed 'quantity' / 'qty' was silently ignored and the
  -- product was created with no stock at all.
  FOR v_item IN SELECT jsonb_array_elements(v_items_arr) LOOP
    IF NOT (v_item ? 'quantity_adjustment') THEN
      RAISE EXCEPTION
        'OPENING_STOCK_BAD_PAYLOAD: each opening stock line must use the key "quantity_adjustment" (got keys: %)',
        (SELECT string_agg(k, ', ') FROM jsonb_object_keys(v_item) k)
        USING ERRCODE = '22023';
    END IF;
    IF (v_item->>'quantity_adjustment') IS NULL
       OR (v_item->>'quantity_adjustment')::numeric < 0 THEN
      RAISE EXCEPTION
        'OPENING_STOCK_BAD_PAYLOAD: quantity_adjustment must be a non-negative number'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

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
    organization_id, business_id, name, description, type, sku, unit_price,
    cost_price, tax_rate, image_url, track_inventory, reorder_level,
    reorder_quantity, min_order_quantity, order_quantity_increment, category_id,
    sales_account_id, purchase_account_id, cogs_account_id, inventory_account_id,
    tax_rate_id, plu_code, base_uom_id, sales_uom_id, purchase_uom_id,
    is_lot_tracked, is_expiry_tracked, expiry_alert_days, is_active
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