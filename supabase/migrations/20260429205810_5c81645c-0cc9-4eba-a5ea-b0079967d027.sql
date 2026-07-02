-- =====================================================================
-- Fix: stock adjustment RPCs were writing wrong types into typed columns
-- - journal_entries.source_id is uuid; old code wrote 'stock-adj-' || uuid::text
-- - approval_rule_logs.entity_id is text; old code wrote raw uuid
-- This restores Inventory > Stock Adjustment for both admin auto-apply and
-- the lower-permission "request approval" path.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.approve_stock_adjustment_atomic(
  p_adjustment_id uuid,
  p_user_id uuid
)
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
  v_inventory_account_id UUID;
  v_adjustment_account_id UUID;
  v_total_positive numeric := 0;
  v_total_negative numeric := 0;
  v_journal_id UUID;
  v_cost numeric;
BEGIN
  SELECT id, organization_id, business_id, status
    INTO v_adjustment
    FROM stock_adjustments
   WHERE id = p_adjustment_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjustment not found');
  END IF;

  IF v_adjustment.status = 'approved' THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Adjustment is already approved');
  END IF;

  IF v_adjustment.status NOT IN ('draft', 'pending_approval') THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Adjustment cannot be approved (current status: ' || v_adjustment.status || ')');
  END IF;

  v_org_id := v_adjustment.organization_id;
  v_biz_id := v_adjustment.business_id;

  IF v_biz_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Adjustment has no business_id; cannot post to GL');
  END IF;

  FOR v_item IN
    SELECT * FROM stock_adjustment_items WHERE adjustment_id = p_adjustment_id
  LOOP
    INSERT INTO stock_movements (
      organization_id, business_id, product_id, movement_type,
      quantity, unit_cost, warehouse_id,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      v_org_id, v_biz_id, v_item.product_id, 'adjustment',
      v_item.quantity_adjustment, v_item.unit_cost, v_item.warehouse_id,
      'stock_adjustment', p_adjustment_id, v_item.notes, p_user_id
    );

    v_cost := ABS(v_item.quantity_adjustment) * COALESCE(v_item.unit_cost, 0);
    IF v_cost > 0 THEN
      IF v_item.quantity_adjustment > 0 THEN
        v_total_positive := v_total_positive + v_cost;
      ELSE
        v_total_negative := v_total_negative + v_cost;
      END IF;
    END IF;
  END LOOP;

  UPDATE stock_adjustments
     SET status = 'approved',
         approved_by = p_user_id,
         approved_at = now()
   WHERE id = p_adjustment_id;

  -- Mark the matching pending approval log (if any) as approved.
  -- entity_id is text, so cast the uuid.
  UPDATE approval_rule_logs
     SET status = 'approved',
         approved_by = p_user_id,
         approved_at = now()
   WHERE entity_type = 'stock_adjustment'
     AND entity_id = p_adjustment_id::text
     AND action_name = 'apply'
     AND status = 'pending';

  SELECT a.id INTO v_inventory_account_id
    FROM accounts a
   WHERE a.organization_id = v_org_id
     AND a.business_id     = v_biz_id
     AND a.detail_type     = 'inventory'
     AND a.is_active       = true
   LIMIT 1;

  SELECT a.id INTO v_adjustment_account_id
    FROM accounts a
   WHERE a.organization_id = v_org_id
     AND a.business_id     = v_biz_id
     AND a.detail_type     = 'inventory_adjustment'
     AND a.is_active       = true
   LIMIT 1;

  IF v_adjustment_account_id IS NULL THEN
    SELECT a.id INTO v_adjustment_account_id
      FROM accounts a
     WHERE a.organization_id = v_org_id
       AND a.business_id     = v_biz_id
       AND a.detail_type     = 'operating_expenses'
       AND a.is_active       = true
     LIMIT 1;
  END IF;

  IF (v_total_positive > 0 OR v_total_negative > 0) THEN
    IF v_inventory_account_id IS NULL OR v_adjustment_account_id IS NULL THEN
      RAISE EXCEPTION 'Cannot post stock adjustment to GL: missing inventory or adjustment account for company %', v_biz_id;
    END IF;

    -- source_id is uuid: write the real adjustment uuid (preserves drill-down
    -- and idempotency contract used elsewhere in the GL pipeline).
    INSERT INTO journal_entries (
      organization_id, business_id, entry_date, reference, description,
      source_type, source_id, status, created_by
    ) VALUES (
      v_org_id, v_biz_id, CURRENT_DATE,
      'ADJ-' || LEFT(p_adjustment_id::text, 8),
      'Stock adjustment approved',
      'stock_adjustment', p_adjustment_id,
      'posted', p_user_id
    ) RETURNING id INTO v_journal_id;

    IF v_total_positive > 0 THEN
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit_amount, credit_amount, description)
      VALUES
        (v_journal_id, v_inventory_account_id,  v_total_positive, 0, 'Stock Adjustment - Inventory Increase'),
        (v_journal_id, v_adjustment_account_id, 0, v_total_positive, 'Stock Adjustment - Inventory Increase Offset');
    END IF;

    IF v_total_negative > 0 THEN
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit_amount, credit_amount, description)
      VALUES
        (v_journal_id, v_adjustment_account_id, v_total_negative, 0, 'Stock Adjustment - Shrinkage/Loss'),
        (v_journal_id, v_inventory_account_id, 0, v_total_negative, 'Stock Adjustment - Inventory Reduction');
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'adjustment_id', p_adjustment_id,
                            'gl_posted', v_journal_id IS NOT NULL,
                            'status', 'approved');
END;
$function$;


CREATE OR REPLACE FUNCTION public.apply_or_request_stock_adjustment(
  p_input jsonb,
  p_user_id uuid
)
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
BEGIN
  IF v_org_id IS NULL OR v_biz_id IS NULL OR v_warehouse_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'organization_id, business_id and warehouse_id are required');
  END IF;
  IF jsonb_array_length(v_items) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'At least one adjustment line is required');
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

  FOR v_item IN SELECT jsonb_array_elements(v_items) LOOP
    v_total_abs_qty := v_total_abs_qty + ABS(COALESCE((v_item->>'quantity_adjustment')::numeric, 0));
    v_total_value   := v_total_value
      + ABS(COALESCE((v_item->>'quantity_adjustment')::numeric, 0))
        * COALESCE((v_item->>'unit_cost')::numeric, 0);
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
    adjustment_number, reason, notes, status, created_by
  ) VALUES (
    v_org_id, v_biz_id, v_branch_id, v_warehouse_id,
    v_adjustment_number, v_reason, v_notes, v_status, p_user_id
  )
  RETURNING id INTO v_adjustment_id;

  FOR v_item IN SELECT jsonb_array_elements(v_items) LOOP
    SELECT COALESCE(quantity, 0) INTO v_before
      FROM public.warehouse_stock
     WHERE product_id = (v_item->>'product_id')::uuid
       AND warehouse_id = (v_item->>'warehouse_id')::uuid
     LIMIT 1;
    v_before := COALESCE(v_before, 0);

    INSERT INTO public.stock_adjustment_items (
      adjustment_id, product_id, warehouse_id, branch_id,
      quantity_before, quantity_adjustment, quantity_after,
      unit_cost, notes
    ) VALUES (
      v_adjustment_id,
      (v_item->>'product_id')::uuid,
      (v_item->>'warehouse_id')::uuid,
      v_branch_id,
      v_before,
      COALESCE((v_item->>'quantity_adjustment')::numeric, 0),
      v_before + COALESCE((v_item->>'quantity_adjustment')::numeric, 0),
      NULLIF(v_item->>'unit_cost','')::numeric,
      v_item->>'notes'
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
    -- entity_id is text in approval_rule_logs; cast the uuid.
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