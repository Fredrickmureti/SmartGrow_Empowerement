-- Fix product creation with opening stock so the RPC matches the UI contract.
-- The UI captures opening stock per warehouse; the previous RPC rejected more
-- than one warehouse and also rolled back zero-cost opening quantities via the
-- generic adjustment valuation guard.

CREATE OR REPLACE FUNCTION public.approve_stock_adjustment_atomic(p_adjustment_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_adjustment RECORD;
  v_item RECORD;
  v_org_id UUID;
  v_biz_id UUID;
  v_branch_id UUID;
  v_inventory_account_id UUID;
  v_adjustment_account_id UUID;
  v_offset_account UUID;
  v_reason text;
  v_journal_id UUID;
  v_entry_number text;
  v_resolved_cost numeric;
  v_cost_value numeric;
  v_total_value numeric := 0;
  v_locked_qty numeric;
  v_inv_debit  numeric := 0;
  v_inv_credit numeric := 0;
  v_offset_rec RECORD;
  v_lines jsonb := '[]'::jsonb;
BEGIN
  SELECT id, organization_id, business_id, branch_id, status, reason
    INTO v_adjustment
    FROM stock_adjustments
   WHERE id = p_adjustment_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjustment not found');
  END IF;

  IF v_adjustment.status = 'approved' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjustment is already approved');
  END IF;

  IF v_adjustment.status NOT IN ('draft', 'pending_approval') THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Adjustment cannot be approved (current status: ' || v_adjustment.status || ')');
  END IF;

  v_org_id    := v_adjustment.organization_id;
  v_biz_id    := v_adjustment.business_id;
  v_branch_id := v_adjustment.branch_id;
  v_reason    := v_adjustment.reason;

  IF v_biz_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Adjustment has no business_id; cannot post to GL');
  END IF;

  SELECT inventory_account_id, adjustment_account_id
    INTO v_inventory_account_id, v_adjustment_account_id
    FROM public.ensure_inventory_gl_accounts(v_org_id, v_biz_id);

  IF v_inventory_account_id IS NULL OR v_adjustment_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot approve stock adjustment: inventory or adjustment GL account not provisioned for company %', v_biz_id;
  END IF;

  PERFORM public.ensure_inventory_reason_gl_accounts(v_org_id, v_biz_id);

  CREATE TEMP TABLE IF NOT EXISTS _adj_offset_acc (
    offset_account_id uuid PRIMARY KEY,
    inv_debit  numeric NOT NULL DEFAULT 0,
    inv_credit numeric NOT NULL DEFAULT 0,
    off_debit  numeric NOT NULL DEFAULT 0,
    off_credit numeric NOT NULL DEFAULT 0
  ) ON COMMIT DROP;
  TRUNCATE TABLE _adj_offset_acc;

  FOR v_item IN
    SELECT * FROM stock_adjustment_items WHERE adjustment_id = p_adjustment_id
  LOOP
    SELECT quantity INTO v_locked_qty
      FROM public.warehouse_stock
     WHERE product_id = v_item.product_id
       AND warehouse_id = v_item.warehouse_id
     FOR UPDATE;

    IF v_item.quantity_adjustment = 0 THEN
      v_resolved_cost := 0;
    ELSE
      v_resolved_cost := public.resolve_adjustment_unit_cost(
        v_org_id, v_biz_id, v_item.product_id, v_item.warehouse_id, v_item.unit_cost
      );

      -- Opening stock may legitimately be zero-value inventory. In that case
      -- record the quantity movement and skip GL because the accounting value
      -- is zero. All other non-zero adjustments remain strict and require a
      -- positive valuation cost before they can post.
      IF v_resolved_cost IS NULL OR v_resolved_cost <= 0 THEN
        IF lower(COALESCE(v_reason, '')) = 'opening_balance'
           AND v_item.quantity_adjustment > 0 THEN
          v_resolved_cost := 0;
        ELSE
          RAISE EXCEPTION 'Cannot approve stock adjustment: no valuation cost is available for product %. Provide a unit cost on the adjustment line, or set the product cost first.', v_item.product_id;
        END IF;
      END IF;

      IF v_item.unit_cost IS DISTINCT FROM v_resolved_cost THEN
        UPDATE public.stock_adjustment_items
           SET unit_cost = v_resolved_cost
         WHERE id = v_item.id;
      END IF;
    END IF;

    INSERT INTO stock_movements (
      organization_id, business_id, branch_id, product_id, movement_type,
      quantity, unit_cost, warehouse_id,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      v_org_id, v_biz_id, v_branch_id, v_item.product_id, 'adjustment',
      v_item.quantity_adjustment, v_resolved_cost, v_item.warehouse_id,
      'stock_adjustment', p_adjustment_id, v_item.notes, p_user_id
    );

    v_cost_value := ABS(v_item.quantity_adjustment) * COALESCE(v_resolved_cost, 0);
    IF v_cost_value > 0 THEN
      v_offset_account := public.resolve_adjustment_offset_account(
        v_org_id, v_biz_id, v_reason, v_item.quantity_adjustment
      );
      IF v_offset_account IS NULL THEN
        RAISE EXCEPTION 'Cannot approve stock adjustment: no offset GL account resolved for reason %', v_reason;
      END IF;

      INSERT INTO _adj_offset_acc (offset_account_id, inv_debit, inv_credit, off_debit, off_credit)
      VALUES (
        v_offset_account,
        CASE WHEN v_item.quantity_adjustment > 0 THEN v_cost_value ELSE 0 END,
        CASE WHEN v_item.quantity_adjustment < 0 THEN v_cost_value ELSE 0 END,
        CASE WHEN v_item.quantity_adjustment < 0 THEN v_cost_value ELSE 0 END,
        CASE WHEN v_item.quantity_adjustment > 0 THEN v_cost_value ELSE 0 END
      )
      ON CONFLICT (offset_account_id) DO UPDATE
        SET inv_debit  = _adj_offset_acc.inv_debit  + EXCLUDED.inv_debit,
            inv_credit = _adj_offset_acc.inv_credit + EXCLUDED.inv_credit,
            off_debit  = _adj_offset_acc.off_debit  + EXCLUDED.off_debit,
            off_credit = _adj_offset_acc.off_credit + EXCLUDED.off_credit;

      v_total_value := v_total_value + v_cost_value;
    END IF;
  END LOOP;

  UPDATE stock_adjustments
     SET status = 'approved',
         approved_by = p_user_id,
         approved_at = now()
   WHERE id = p_adjustment_id;

  IF v_total_value > 0 THEN
    FOR v_offset_rec IN SELECT * FROM _adj_offset_acc LOOP
      v_inv_debit  := v_inv_debit  + v_offset_rec.inv_debit;
      v_inv_credit := v_inv_credit + v_offset_rec.inv_credit;

      IF v_offset_rec.off_debit > 0 THEN
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account_id', v_offset_rec.offset_account_id,
          'debit',  v_offset_rec.off_debit,
          'credit', 0,
          'description', 'Stock adjustment offset'
        ));
      END IF;
      IF v_offset_rec.off_credit > 0 THEN
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account_id', v_offset_rec.offset_account_id,
          'debit',  0,
          'credit', v_offset_rec.off_credit,
          'description', 'Stock adjustment offset'
        ));
      END IF;
    END LOOP;

    IF v_inv_debit > 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_inventory_account_id,
        'debit',  v_inv_debit,
        'credit', 0,
        'description', 'Inventory'
      ));
    END IF;
    IF v_inv_credit > 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_inventory_account_id,
        'debit',  0,
        'credit', v_inv_credit,
        'description', 'Inventory'
      ));
    END IF;

    v_entry_number := public.get_next_journal_entry_number(v_org_id);

    v_journal_id := public.post_journal_entry_atomic(
      _org_id          := v_org_id,
      _business_id     := v_biz_id,
      _entry_number    := v_entry_number,
      _entry_date      := CURRENT_DATE,
      _reference       := NULL,
      _description     := 'Stock adjustment ' || p_adjustment_id::text,
      _source_type     := 'stock_adjustment',
      _source_id       := p_adjustment_id,
      _created_by      := p_user_id,
      _is_closing      := false,
      _is_adjusting    := false,
      _lines           := v_lines,
      _branch_id       := v_branch_id
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'adjustment_id', p_adjustment_id,
    'gl_posted', v_journal_id IS NOT NULL,
    'journal_entry_id', v_journal_id,
    'total_value', v_total_value
  );
END;
$function$;

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

  -- Validate every positive opening line before inserting the product, so a
  -- bad warehouse produces a clean error without relying on rollback side effects.
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
      END IF;
    END LOOP;
  END IF;

  INSERT INTO public.products (
    organization_id, business_id,
    name, description, type, sku,
    unit_price, cost_price, tax_rate,
    image_url, track_inventory, reorder_level, reorder_quantity,
    min_order_quantity, order_quantity_increment, category_id,
    sales_account_id, purchase_account_id, cogs_account_id, inventory_account_id,
    tax_rate_id, etims_classification_code, etims_unit_code,
    etims_packaging_unit, etims_country_origin, is_active
  ) VALUES (
    v_org_id, v_biz_id,
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
    NULLIF(p_product->>'etims_country_origin',''),
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

GRANT EXECUTE ON FUNCTION public.approve_stock_adjustment_atomic(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_product_with_opening_stock_atomic(jsonb, jsonb, uuid) TO authenticated;