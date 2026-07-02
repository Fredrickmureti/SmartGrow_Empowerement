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
  v_total_positive numeric := 0;
  v_total_negative numeric := 0;
  v_journal_id UUID;
  v_cost numeric;
  v_lines jsonb := '[]'::jsonb;
BEGIN
  SELECT id, organization_id, business_id, branch_id, status
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

  v_org_id    := v_adjustment.organization_id;
  v_biz_id    := v_adjustment.business_id;
  v_branch_id := v_adjustment.branch_id;

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

  UPDATE approval_rule_logs
     SET status = 'approved',
         approved_by = p_user_id,
         approved_at = now()
   WHERE entity_type = 'stock_adjustment'
     AND entity_id = p_adjustment_id::text
     AND action_name = 'apply'
     AND status = 'pending';

  IF (v_total_positive > 0 OR v_total_negative > 0) THEN
    SELECT inventory_account_id, adjustment_account_id
      INTO v_inventory_account_id, v_adjustment_account_id
      FROM public.ensure_inventory_gl_accounts(v_org_id, v_biz_id);

    IF v_inventory_account_id IS NULL OR v_adjustment_account_id IS NULL THEN
      RAISE EXCEPTION 'Cannot post stock adjustment to GL: failed to provision inventory or adjustment account for company %', v_biz_id;
    END IF;

    IF v_total_positive > 0 THEN
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object(
          'account_id', v_inventory_account_id,
          'debit',  v_total_positive,
          'credit', 0,
          'description', 'Stock Adjustment - Inventory Increase'
        ),
        jsonb_build_object(
          'account_id', v_adjustment_account_id,
          'debit',  0,
          'credit', v_total_positive,
          'description', 'Stock Adjustment - Inventory Increase Offset'
        )
      );
    END IF;

    IF v_total_negative > 0 THEN
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object(
          'account_id', v_adjustment_account_id,
          'debit',  v_total_negative,
          'credit', 0,
          'description', 'Stock Adjustment - Shrinkage/Loss'
        ),
        jsonb_build_object(
          'account_id', v_inventory_account_id,
          'debit',  0,
          'credit', v_total_negative,
          'description', 'Stock Adjustment - Inventory Reduction'
        )
      );
    END IF;

    v_journal_id := public.post_journal_entry_atomic(
      _org_id          := v_org_id,
      _business_id     := v_biz_id,
      _entry_number    := public.get_next_journal_entry_number(v_org_id),
      _entry_date      := CURRENT_DATE,
      _reference       := 'ADJ-' || LEFT(p_adjustment_id::text, 8),
      _description     := 'Stock adjustment approved',
      _source_type     := 'stock_adjustment',
      _source_id       := p_adjustment_id,
      _created_by      := p_user_id,
      _is_closing      := false,
      _is_adjusting    := false,
      _lines           := v_lines,
      _branch_id       := v_branch_id
    );
  END IF;

  RETURN jsonb_build_object('success', true, 'adjustment_id', p_adjustment_id,
                            'gl_posted', v_journal_id IS NOT NULL,
                            'journal_entry_id', v_journal_id,
                            'status', 'approved');
END;
$function$;