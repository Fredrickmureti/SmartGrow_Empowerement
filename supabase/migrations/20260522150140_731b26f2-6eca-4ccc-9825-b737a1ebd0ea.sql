-- Wave 8: fix approve_stock_adjustment_atomic — bare DELETE on the temp
-- accumulator table trips Supabase's "DELETE requires a WHERE clause"
-- safeguard, which surfaces to the client as a 400 from
-- apply_or_request_stock_adjustment and triggers the optimistic product
-- rollback (INSERT then DELETE) observed in the realtime stream.
--
-- TRUNCATE is the correct primitive: it ignores the safeguard, is faster,
-- and matches the intent of "reset the per-call accumulator".

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
  v_resolved_cost numeric;
  v_cost_value numeric;
  v_lines jsonb := '[]'::jsonb;
  v_total_value numeric := 0;
  v_locked_qty numeric;
  v_inv_debit  numeric := 0;
  v_inv_credit numeric := 0;
  v_offset_rec RECORD;
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
  -- Safeguard-safe reset (Supabase rejects unqualified DELETE).
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
      IF v_resolved_cost IS NULL OR v_resolved_cost <= 0 THEN
        RAISE EXCEPTION 'Cannot approve stock adjustment: no valuation cost is available for product %. Provide a unit cost on the adjustment line, or set the product cost first.', v_item.product_id;
      END IF;

      IF v_item.unit_cost IS DISTINCT FROM v_resolved_cost THEN
        UPDATE public.stock_adjustment_items
           SET unit_cost = v_resolved_cost
         WHERE id = v_item.id;
      END IF;
    END IF;

    INSERT INTO stock_movements (
      organization_id, business_id, product_id, movement_type,
      quantity, unit_cost, warehouse_id,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      v_org_id, v_biz_id, v_item.product_id, 'adjustment',
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
    INSERT INTO journal_entries (
      organization_id, business_id, branch_id,
      entry_date, description, source_type, source_id, status, created_by
    ) VALUES (
      v_org_id, v_biz_id, v_branch_id,
      CURRENT_DATE,
      'Stock adjustment ' || p_adjustment_id::text,
      'stock_adjustment', p_adjustment_id, 'posted', p_user_id
    )
    RETURNING id INTO v_journal_id;

    FOR v_offset_rec IN SELECT * FROM _adj_offset_acc LOOP
      v_inv_debit  := v_inv_debit  + v_offset_rec.inv_debit;
      v_inv_credit := v_inv_credit + v_offset_rec.inv_credit;

      IF v_offset_rec.off_debit > 0 THEN
        INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit)
        VALUES (v_journal_id, v_offset_rec.offset_account_id, v_offset_rec.off_debit, 0);
      END IF;
      IF v_offset_rec.off_credit > 0 THEN
        INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit)
        VALUES (v_journal_id, v_offset_rec.offset_account_id, 0, v_offset_rec.off_credit);
      END IF;
    END LOOP;

    IF v_inv_debit > 0 THEN
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit)
      VALUES (v_journal_id, v_inventory_account_id, v_inv_debit, 0);
    END IF;
    IF v_inv_credit > 0 THEN
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit)
      VALUES (v_journal_id, v_inventory_account_id, 0, v_inv_credit);
    END IF;
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