-- Stock Adjustment: widen the create seam so unit-of-measure provenance and
-- lot/serial identity survive from the operator to the ledger.
--
-- Before this migration `apply_or_request_stock_adjustment` inserted only
-- base quantity + cost, dropping packaging_id / display_uom_id /
-- display_quantity / lot_number / serial_number / lot_allocations. The
-- server-side conversion trigger `_uom_normalize_adj_line` was therefore
-- dead code, and any positive adjustment on a lot-tracked product was
-- guaranteed to fail in `approve_stock_adjustment_atomic` with 23514.
--
-- No downstream invariant is weakened: the lot requirement is pre-flighted
-- here (before any row is written) and the conversion is still performed by
-- the existing BEFORE trigger, never by the client.

CREATE OR REPLACE FUNCTION public.apply_or_request_stock_adjustment(p_input jsonb, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id uuid := (p_input->>'organization_id')::uuid;
  v_biz_id uuid := (p_input->>'business_id')::uuid;
  v_branch_id uuid := NULLIF(p_input->>'branch_id','')::uuid;
  v_warehouse_id uuid := (p_input->>'warehouse_id')::uuid;
  v_adjustment_number text := p_input->>'adjustment_number';
  v_reason text := p_input->>'reason';
  v_notes text := p_input->>'notes';
  v_items jsonb := COALESCE(p_input->'items','[]'::jsonb);
  v_client_request_id uuid := NULLIF(p_input->>'client_request_id','')::uuid;
  v_can_write boolean;
  v_user_role text;
  v_is_privileged boolean := false;
  v_total_value numeric := 0;
  v_total_abs_qty numeric := 0;
  v_item jsonb;
  v_before numeric;
  v_rule RECORD;
  v_triggered_rule RECORD;
  v_field_value numeric;
  v_threshold_match boolean;
  v_auto_approve boolean := true;
  v_adjustment_id uuid;
  v_status text;
  v_log_id uuid;
  v_apply_result jsonb;
  v_existing_id uuid;
  v_existing_status text;
  v_existing_gl_posted boolean;
  v_product_id uuid;
  v_pack_id uuid;
  v_pack_qty numeric;
  v_display_uom uuid;
  v_display_qty numeric;
  v_base_uom uuid;
  v_base_cat uuid;
  v_disp_cat uuid;
  v_lot text;
  v_serial text;
  v_expiry date;
  v_lot_alloc jsonb;
  v_signed_qty numeric;
  v_lot_tracked boolean;
  v_serial_tracked boolean;
  v_prod_name text;
  v_lot_id uuid;
BEGIN
  IF v_org_id IS NULL OR v_biz_id IS NULL OR v_warehouse_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'organization_id, business_id and warehouse_id are required');
  END IF;
  IF jsonb_array_length(v_items) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'At least one adjustment line is required');
  END IF;

  IF v_client_request_id IS NOT NULL THEN
    SELECT id, status INTO v_existing_id, v_existing_status
      FROM public.stock_adjustments
     WHERE organization_id = v_org_id
       AND business_id = v_biz_id
       AND client_request_id = v_client_request_id
     LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      v_existing_gl_posted := EXISTS (
        SELECT 1 FROM public.journal_entries
         WHERE source_type = 'stock_adjustment'
           AND source_id = v_existing_id
      );
      RETURN jsonb_build_object(
        'success', true,
        'adjustment_id', v_existing_id,
        'status', v_existing_status,
        'requires_approval', v_existing_status = 'pending_approval',
        'auto_applied', v_existing_status = 'approved',
        'gl_posted', v_existing_gl_posted,
        'idempotent', true
      );
    END IF;
  END IF;

  v_can_write := public.user_has_module_permission(p_user_id, v_org_id, 'inventory', 'write');
  IF NOT v_can_write THEN
    RETURN jsonb_build_object('success', false, 'error',
      'You do not have permission to create or apply stock adjustments');
  END IF;

  SELECT role::text INTO v_user_role
    FROM public.user_roles
   WHERE user_id = p_user_id
     AND organization_id = v_org_id
     AND is_active = true
   ORDER BY CASE role::text
              WHEN 'owner' THEN 1
              WHEN 'admin' THEN 2
              ELSE 3
            END
   LIMIT 1;

  v_is_privileged := v_user_role IN ('owner','admin');

  -- Pre-flight: resolve the base-unit magnitude the same way the BEFORE
  -- trigger will, then validate lot/serial identity before writing anything.
  FOR v_item IN SELECT jsonb_array_elements(v_items) LOOP
    v_product_id  := (v_item->>'product_id')::uuid;
    v_pack_id     := NULLIF(v_item->>'packaging_id','')::uuid;
    v_display_uom := NULLIF(v_item->>'display_uom_id','')::uuid;
    v_display_qty := NULLIF(v_item->>'display_quantity','')::numeric;
    v_lot         := NULLIF(btrim(COALESCE(v_item->>'lot_number','')),'');
    v_serial      := NULLIF(btrim(COALESCE(v_item->>'serial_number','')),'');
    v_lot_alloc   := v_item->'lot_allocations';
    v_signed_qty  := COALESCE((v_item->>'quantity_adjustment')::numeric, 0);

    SELECT name, base_uom_id, COALESCE(is_lot_tracked,false), COALESCE(is_serial_tracked,false)
      INTO v_prod_name, v_base_uom, v_lot_tracked, v_serial_tracked
      FROM public.products WHERE id = v_product_id;

    IF v_prod_name IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Adjustment line references an unknown product');
    END IF;

    IF v_pack_id IS NOT NULL THEN
      SELECT qty_in_base_uom INTO v_pack_qty
        FROM public.product_packaging
       WHERE id = v_pack_id AND product_id = v_product_id;
      IF v_pack_qty IS NULL OR v_pack_qty <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error',
          format('The selected pack does not belong to "%s" or has no valid conversion factor.', v_prod_name));
      END IF;
      IF v_display_qty IS NOT NULL THEN
        v_signed_qty := sign(CASE WHEN v_signed_qty <> 0 THEN v_signed_qty ELSE v_display_qty END)
                        * abs(v_display_qty) * v_pack_qty;
      END IF;
    ELSIF v_display_uom IS NOT NULL AND v_display_uom <> v_base_uom THEN
      SELECT category_id INTO v_base_cat FROM public.units_of_measure WHERE id = v_base_uom;
      SELECT category_id INTO v_disp_cat FROM public.units_of_measure WHERE id = v_display_uom;
      IF v_base_cat IS NULL OR v_disp_cat IS NULL OR v_base_cat <> v_disp_cat THEN
        RETURN jsonb_build_object('success', false, 'error',
          format('The chosen unit is not convertible to the stocking unit of "%s".', v_prod_name));
      END IF;
      IF v_display_qty IS NOT NULL THEN
        v_signed_qty := sign(CASE WHEN v_signed_qty <> 0 THEN v_signed_qty ELSE v_display_qty END)
                        * abs(public.convert_uom(v_display_qty, v_display_uom, v_base_uom));
      END IF;
    END IF;

    IF v_signed_qty > 0 AND v_lot_tracked AND v_lot IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error',
        format('"%s" is lot-tracked. Enter the lot / batch number for the stock you are adding.', v_prod_name));
    END IF;
    IF v_signed_qty > 0 AND v_serial_tracked AND v_serial IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error',
        format('"%s" is serial-tracked. Serial numbers must be captured through the serial workflow.', v_prod_name));
    END IF;
    IF v_signed_qty < 0 AND v_serial_tracked AND v_serial IS NULL
       AND (v_lot_alloc IS NULL OR jsonb_typeof(v_lot_alloc) <> 'array' OR jsonb_array_length(v_lot_alloc) = 0) THEN
      RETURN jsonb_build_object('success', false, 'error',
        format('"%s" is serial-tracked. Pick the serial being removed.', v_prod_name));
    END IF;

    v_total_abs_qty := v_total_abs_qty + ABS(v_signed_qty);
    v_total_value   := v_total_value + ABS(v_signed_qty) * COALESCE((v_item->>'unit_cost')::numeric, 0);
  END LOOP;

  FOR v_rule IN
    SELECT *
      FROM public.approval_rules
     WHERE organization_id = v_org_id
       AND business_id = v_biz_id
       AND entity_type = 'stock_adjustment'
       AND action_name = 'apply'
       AND is_active = true
  LOOP
    v_threshold_match := true;

    IF v_rule.threshold_field IS NOT NULL
       AND v_rule.threshold_operator IS NOT NULL
       AND v_rule.threshold_value IS NOT NULL THEN
      v_field_value := CASE v_rule.threshold_field
        WHEN 'total_value'   THEN v_total_value
        WHEN 'total_abs_qty' THEN v_total_abs_qty
        ELSE 0
      END;
      v_threshold_match := CASE v_rule.threshold_operator
        WHEN '>'  THEN v_field_value >  v_rule.threshold_value
        WHEN '>=' THEN v_field_value >= v_rule.threshold_value
        WHEN '<'  THEN v_field_value <  v_rule.threshold_value
        WHEN '<=' THEN v_field_value <= v_rule.threshold_value
        WHEN '='  THEN v_field_value =  v_rule.threshold_value
        WHEN '==' THEN v_field_value =  v_rule.threshold_value
        WHEN '!=' THEN v_field_value <> v_rule.threshold_value
        ELSE false
      END;
    END IF;

    IF v_threshold_match THEN
      IF v_is_privileged THEN
        CONTINUE;
      END IF;
      v_triggered_rule := v_rule;
      v_auto_approve := false;
      EXIT;
    END IF;
  END LOOP;

  v_status := CASE WHEN v_auto_approve THEN 'draft' ELSE 'pending_approval' END;

  INSERT INTO public.stock_adjustments (
    organization_id, business_id, branch_id, warehouse_id,
    adjustment_number, reason, notes, status, created_by, client_request_id
  ) VALUES (
    v_org_id, v_biz_id, v_branch_id, v_warehouse_id,
    v_adjustment_number, v_reason, v_notes, v_status, p_user_id, v_client_request_id
  )
  RETURNING id INTO v_adjustment_id;

  FOR v_item IN SELECT jsonb_array_elements(v_items) LOOP
    v_product_id  := (v_item->>'product_id')::uuid;
    v_pack_id     := NULLIF(v_item->>'packaging_id','')::uuid;
    v_display_uom := NULLIF(v_item->>'display_uom_id','')::uuid;
    v_display_qty := NULLIF(v_item->>'display_quantity','')::numeric;
    v_lot         := NULLIF(btrim(COALESCE(v_item->>'lot_number','')),'');
    v_serial      := NULLIF(btrim(COALESCE(v_item->>'serial_number','')),'');
    v_expiry      := NULLIF(v_item->>'expiry_date','')::date;
    v_lot_alloc   := CASE WHEN jsonb_typeof(v_item->'lot_allocations') = 'array'
                          THEN v_item->'lot_allocations' ELSE NULL END;

    SELECT COALESCE(quantity, 0) INTO v_before
      FROM public.warehouse_stock
     WHERE product_id = v_product_id
       AND warehouse_id = (v_item->>'warehouse_id')::uuid
     LIMIT 1;
    v_before := COALESCE(v_before, 0);

    -- Register the lot master up front so expiry policy and lot-balance
    -- maintenance downstream see a known lot (idempotent per business).
    IF v_lot IS NOT NULL THEN
      SELECT id INTO v_lot_id
        FROM public.stock_lots
       WHERE business_id = v_biz_id
         AND product_id = v_product_id
         AND lot_number = v_lot
         AND serial_number IS NOT DISTINCT FROM v_serial
       LIMIT 1;
      IF v_lot_id IS NULL THEN
        INSERT INTO public.stock_lots (
          organization_id, business_id, product_id, lot_number, serial_number, expiry_date
        ) VALUES (v_org_id, v_biz_id, v_product_id, v_lot, v_serial, v_expiry);
      ELSIF v_expiry IS NOT NULL THEN
        UPDATE public.stock_lots
           SET expiry_date = v_expiry, updated_at = now()
         WHERE id = v_lot_id AND expiry_date IS DISTINCT FROM v_expiry;
      END IF;
    END IF;

    INSERT INTO public.stock_adjustment_items (
      adjustment_id, product_id, warehouse_id, branch_id,
      quantity_before, quantity_adjustment, quantity_after,
      unit_cost, notes,
      packaging_id, display_uom_id, display_quantity,
      lot_number, serial_number, lot_allocations
    ) VALUES (
      v_adjustment_id,
      v_product_id,
      (v_item->>'warehouse_id')::uuid,
      v_branch_id,
      v_before,
      COALESCE((v_item->>'quantity_adjustment')::numeric, 0),
      v_before + COALESCE((v_item->>'quantity_adjustment')::numeric, 0),
      NULLIF(v_item->>'unit_cost','')::numeric,
      v_item->>'notes',
      v_pack_id,
      v_display_uom,
      v_display_qty,
      v_lot,
      v_serial,
      v_lot_alloc
    );
  END LOOP;

  IF v_auto_approve THEN
    v_apply_result := public.approve_stock_adjustment_atomic(v_adjustment_id, p_user_id);
    IF NOT (v_apply_result->>'success')::boolean THEN
      RAISE EXCEPTION 'Auto-apply failed: %', v_apply_result->>'error';
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'adjustment_id', v_adjustment_id,
      'status', 'approved',
      'requires_approval', false,
      'auto_applied', true,
      'gl_posted', COALESCE((v_apply_result->>'gl_posted')::boolean, false),
      'total_value', v_total_value
    );
  ELSE
    INSERT INTO public.approval_rule_logs (
      organization_id, business_id, rule_id,
      entity_type, entity_id, action_name,
      status, requested_by, notes
    ) VALUES (
      v_org_id, v_biz_id, v_triggered_rule.id,
      'stock_adjustment', v_adjustment_id::text, 'apply',
      'pending', p_user_id,
      COALESCE(v_triggered_rule.description,
        'Stock adjustment requires approval (rule triggered)')
    )
    RETURNING id INTO v_log_id;

    RETURN jsonb_build_object(
      'success', true,
      'adjustment_id', v_adjustment_id,
      'status', 'pending_approval',
      'requires_approval', true,
      'auto_applied', false,
      'rule_id', v_triggered_rule.id,
      'rule_name', COALESCE(v_triggered_rule.description, 'Approval rule'),
      'approval_log_id', v_log_id,
      'total_value', v_total_value
    );
  END IF;
END;
$function$;