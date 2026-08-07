CREATE OR REPLACE FUNCTION public.approve_sales_return_atomic(p_return_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_return RECORD;
  v_cn_number text;
  v_cn_id uuid;
  v_warehouse_id uuid;
  v_item RECORD;
  v_inventory_count integer := 0;
  v_unit_cost numeric;
  v_total_cogs numeric := 0;
  v_inventory_acct uuid;
  v_cogs_acct uuid;
  v_cogs_je_id uuid;
BEGIN
  SELECT * INTO v_return FROM public.sales_returns WHERE id = p_return_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales return % not found', p_return_id; END IF;
  IF v_return.status <> 'pending' THEN
    RAISE EXCEPTION 'Only pending sales returns can be approved (current: %)', v_return.status;
  END IF;
  IF NOT public.user_can_access_business(p_user_id, v_return.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_return.business_id;
  END IF;

  -- Canonical, business-scoped numbering (ADR 0131 §6). The org-only
  -- overload was retired; calling it here previously broke approval.
  v_cn_number := public.get_next_credit_note_number(
    v_return.organization_id, v_return.business_id, v_return.branch_id);

  INSERT INTO public.credit_notes(
    organization_id, business_id, branch_id,
    credit_note_number, contact_id, invoice_id, issue_date, status,
    reason, subtotal, tax_amount, total, currency, notes,
    created_by, source_return_id
  ) VALUES (
    v_return.organization_id, v_return.business_id, v_return.branch_id,
    v_cn_number, v_return.contact_id, v_return.invoice_id, CURRENT_DATE, 'draft',
    v_return.reason, v_return.subtotal, v_return.tax_amount, v_return.total, v_return.currency,
    'Auto-created from Sales Return ' || v_return.return_number, p_user_id, v_return.id
  ) RETURNING id INTO v_cn_id;

  INSERT INTO public.credit_note_items(
    credit_note_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, line_total, sort_order,
    lot_number, serial_number
  )
  SELECT
    v_cn_id, sri.product_id, sri.description, sri.quantity, sri.unit_price,
    COALESCE(sri.tax_rate,0), COALESCE(sri.tax_amount,0), sri.line_total, sri.sort_order,
    sri.lot_number, sri.serial_number
  FROM public.sales_return_items sri
  WHERE sri.sales_return_id = p_return_id;

  SELECT COUNT(*) INTO v_inventory_count
  FROM public.sales_return_items sri
  WHERE sri.sales_return_id = p_return_id AND sri.product_id IS NOT NULL;

  IF v_inventory_count > 0 THEN
    SELECT id INTO v_warehouse_id
    FROM public.warehouses
    WHERE organization_id = v_return.organization_id
      AND business_id = v_return.business_id
      AND COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE(v_return.branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND is_active = true
      AND COALESCE(is_in_transit, false) = false
    ORDER BY is_default DESC NULLS LAST
    LIMIT 1;

    IF v_warehouse_id IS NULL THEN
      RAISE EXCEPTION 'No active warehouse found for the return''s branch — create one before approving the return.';
    END IF;

    FOR v_item IN
      SELECT product_id, quantity, lot_number, serial_number
      FROM public.sales_return_items
      WHERE sales_return_id = p_return_id AND product_id IS NOT NULL
    LOOP
      -- Value the return at the cost snapshotted when the goods shipped,
      -- falling back to the product's current cost.
      SELECT dni.cost_at_shipment INTO v_unit_cost
        FROM public.delivery_note_items dni
        JOIN public.delivery_notes dn ON dn.id = dni.delivery_note_id
       WHERE dni.product_id = v_item.product_id
         AND COALESCE(dn.is_return, false) = false
         AND (dn.source_invoice_id = v_return.invoice_id OR dn.spawned_invoice_id = v_return.invoice_id)
         AND dni.cost_at_shipment IS NOT NULL
       ORDER BY dn.delivery_date DESC
       LIMIT 1;

      IF v_unit_cost IS NULL THEN
        SELECT COALESCE(p.cost_price, 0) INTO v_unit_cost
          FROM public.products p WHERE p.id = v_item.product_id;
      END IF;
      v_unit_cost := COALESCE(v_unit_cost, 0);
      v_total_cogs := v_total_cogs + (ABS(v_item.quantity) * v_unit_cost);

      INSERT INTO public.stock_movements(
        organization_id, business_id, branch_id, product_id, movement_type,
        quantity, reference_type, reference_id, warehouse_id, notes,
        lot_number, serial_number, unit_cost
      ) VALUES (
        v_return.organization_id, v_return.business_id, v_return.branch_id,
        v_item.product_id, 'return_in', v_item.quantity,
        'sales_return', p_return_id, v_warehouse_id,
        'Sales return ' || v_return.return_number || ' approved - stock restored',
        v_item.lot_number, v_item.serial_number, v_unit_cost
      );
    END LOOP;
  END IF;

  -- Inventory / COGS reversal: stock coming back must have a GL counterpart,
  -- otherwise inventory value and COGS drift permanently (ADR 0131 §5).
  IF v_total_cogs > 0.005 THEN
    SELECT id INTO v_inventory_acct FROM public.accounts
     WHERE organization_id = v_return.organization_id AND business_id = v_return.business_id
       AND detail_type = 'inventory' AND is_active = true LIMIT 1;
    SELECT id INTO v_cogs_acct FROM public.accounts
     WHERE organization_id = v_return.organization_id AND business_id = v_return.business_id
       AND detail_type = 'cost_of_goods_sold' AND is_active = true LIMIT 1;

    IF v_inventory_acct IS NOT NULL AND v_cogs_acct IS NOT NULL
       AND public.is_period_open(v_return.business_id, CURRENT_DATE) THEN
      PERFORM public.assert_no_existing_source_posting(
        v_return.organization_id, 'sales_return', p_return_id, NULL);

      v_cogs_je_id := public.post_journal_entry_atomic(
        _org_id := v_return.organization_id,
        _business_id := v_return.business_id,
        _entry_number := public.generate_next_je_number(v_return.organization_id, v_return.business_id),
        _entry_date := CURRENT_DATE,
        _reference := v_return.return_number,
        _description := 'Sales return ' || v_return.return_number || ' — inventory restore / COGS reversal',
        _source_type := 'sales_return',
        _source_id := p_return_id,
        _created_by := p_user_id,
        _is_closing := false,
        _is_adjusting := false,
        _lines := jsonb_build_array(
          jsonb_build_object('account_id', v_inventory_acct, 'debit', v_total_cogs, 'credit', 0,
            'description', 'Inventory restore — ' || v_return.return_number),
          jsonb_build_object('account_id', v_cogs_acct, 'debit', 0, 'credit', v_total_cogs,
            'description', 'COGS reversal — ' || v_return.return_number)
        ),
        _currency := NULL,
        _exchange_rate := NULL,
        _source_subtype := NULL,
        _branch_id := v_return.branch_id
      );
    END IF;
  END IF;

  UPDATE public.sales_returns
     SET status = 'approved', credit_note_id = v_cn_id, updated_at = now()
   WHERE id = p_return_id;

  RETURN jsonb_build_object(
    'success', true,
    'credit_note_id', v_cn_id,
    'credit_note_number', v_cn_number,
    'cogs_journal_entry_id', v_cogs_je_id,
    'cogs_reversed', v_total_cogs
  );
END;
$function$;