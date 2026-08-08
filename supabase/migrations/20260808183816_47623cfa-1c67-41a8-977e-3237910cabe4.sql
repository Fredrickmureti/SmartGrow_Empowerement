-- P1 — stock adjustments + opening stock onto the product GL ladder (ADR 0122)

-- Guard: abort if the source functions are not the ones this patch was written against.
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'approve_stock_adjustment_atomic'
       AND position('_adj_offset_acc' in pg_get_functiondef(p.oid)) > 0
  ) THEN
    RAISE EXCEPTION 'approve_stock_adjustment_atomic drifted from the audited source; aborting';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'record_opening_stock'
       AND position('opening_equity' in pg_get_functiondef(p.oid)) > 0
  ) THEN
    RAISE EXCEPTION 'record_opening_stock drifted from the audited source; aborting';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'resolve_product_account_override'
  ) THEN
    RAISE EXCEPTION 'resolve_product_account_override missing; run the P0 migration first';
  END IF;
END $guard$;

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
  v_adj_number text;
  v_inventory_account_id UUID;
  v_adjustment_account_id UUID;
  v_offset_account UUID;
  v_line_inv_account UUID;
  v_reason text;
  v_journal_id UUID;
  v_entry_number text;
  v_resolved_cost numeric;
  v_cost_value numeric;
  v_total_value numeric := 0;
  v_locked_qty numeric;
  v_offset_rec RECORD;
  v_lines jsonb := '[]'::jsonb;
  v_is_lot_tracked boolean;
  v_allocs jsonb;
  v_qty_signed numeric;
  v_qty_abs numeric;
  v_alloc_sum numeric;
BEGIN
  SELECT id, organization_id, business_id, branch_id, status, reason, adjustment_number
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
    RETURN jsonb_build_object('success', false, 'error', 'Adjustment cannot be approved (current status: ' || v_adjustment.status || ')');
  END IF;

  v_org_id := v_adjustment.organization_id;
  v_biz_id := v_adjustment.business_id;
  v_branch_id := v_adjustment.branch_id;
  v_reason := v_adjustment.reason;
  v_adj_number := v_adjustment.adjustment_number;

  IF v_biz_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjustment has no business_id; cannot post to GL');
  END IF;

  SELECT inventory_account_id, adjustment_account_id
    INTO v_inventory_account_id, v_adjustment_account_id
    FROM public.ensure_inventory_gl_accounts(v_org_id, v_biz_id);

  IF v_inventory_account_id IS NULL OR v_adjustment_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot approve stock adjustment: inventory or adjustment GL account not provisioned for company %', v_biz_id;
  END IF;

  PERFORM public.ensure_inventory_reason_gl_accounts(v_org_id, v_biz_id);

  -- Keyed by (inventory account, offset account): the inventory side is now
  -- resolved per line through the product GL ladder (ADR 0122), so one
  -- adjustment may touch several inventory accounts.
  CREATE TEMP TABLE IF NOT EXISTS _adj_offset_acc (
    inv_account_id uuid NOT NULL,
    offset_account_id uuid NOT NULL,
    inv_debit numeric NOT NULL DEFAULT 0,
    inv_credit numeric NOT NULL DEFAULT 0,
    off_debit numeric NOT NULL DEFAULT 0,
    off_credit numeric NOT NULL DEFAULT 0,
    PRIMARY KEY (inv_account_id, offset_account_id)
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
      IF v_resolved_cost IS NULL OR v_resolved_cost <= 0 THEN
        RAISE EXCEPTION 'OPENING_STOCK_REQUIRES_COST: no valuation cost for product % (warehouse %). Provide a positive unit_cost on the adjustment line, or set the product cost first.', v_item.product_id, v_item.warehouse_id
          USING ERRCODE = 'check_violation';
      END IF;
      IF v_item.unit_cost IS DISTINCT FROM v_resolved_cost THEN
        UPDATE public.stock_adjustment_items SET unit_cost = v_resolved_cost WHERE id = v_item.id;
      END IF;
    END IF;

    SELECT COALESCE(is_lot_tracked, false) INTO v_is_lot_tracked
      FROM public.products WHERE id = v_item.product_id;

    v_qty_signed := COALESCE(v_item.quantity_adjustment, 0);
    v_qty_abs := abs(v_qty_signed);

    IF v_qty_signed = 0 THEN
      NULL;
    ELSIF v_is_lot_tracked AND v_qty_signed < 0 THEN
      IF v_item.lot_allocations IS NOT NULL
         AND jsonb_typeof(v_item.lot_allocations) = 'array'
         AND jsonb_array_length(v_item.lot_allocations) > 0 THEN
        v_allocs := v_item.lot_allocations;
        SELECT COALESCE(SUM((e->>'qty')::numeric), 0) INTO v_alloc_sum
          FROM jsonb_array_elements(v_allocs) AS e;
        IF v_alloc_sum <> v_qty_abs THEN
          RAISE EXCEPTION 'lot_allocations sum (%) must equal abs(quantity_adjustment) (%) for product %', v_alloc_sum, v_qty_abs, v_item.product_id
            USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        SELECT COALESCE(jsonb_agg(jsonb_build_object('lot_number', r.lot_number, 'serial_number', r.serial_number, 'qty', r.qty)), '[]'::jsonb)
          INTO v_allocs
          FROM public.resolve_fefo_lots(v_biz_id, v_item.warehouse_id, v_item.product_id, v_qty_abs) r;
        UPDATE public.stock_adjustment_items
           SET lot_allocations = v_allocs
         WHERE id = v_item.id;
      END IF;

      PERFORM public.consume_lots_atomic(
        v_org_id, v_biz_id, v_item.warehouse_id, v_branch_id,
        v_item.product_id, 'adjustment_out',
        'stock_adjustment', p_adjustment_id, p_user_id,
        COALESCE(v_item.notes, 'Stock adjustment ' || COALESCE(v_adj_number,'')),
        v_allocs, v_resolved_cost
      );
    ELSIF v_is_lot_tracked AND v_qty_signed > 0 THEN
      IF v_item.lot_number IS NULL OR length(trim(v_item.lot_number)) = 0 THEN
        RAISE EXCEPTION 'Product % is lot-tracked; positive adjustment requires lot_number on the line', v_item.product_id
          USING ERRCODE = 'check_violation';
      END IF;
      INSERT INTO stock_movements (
        organization_id, business_id, branch_id, product_id, movement_type,
        quantity, unit_cost, warehouse_id,
        reference_type, reference_id, notes, created_by,
        lot_number, serial_number
      ) VALUES (
        v_org_id, v_biz_id, v_branch_id, v_item.product_id, 'adjustment',
        v_qty_signed, v_resolved_cost, v_item.warehouse_id,
        'stock_adjustment', p_adjustment_id, v_item.notes, p_user_id,
        v_item.lot_number, v_item.serial_number
      );
    ELSE
      INSERT INTO stock_movements (
        organization_id, business_id, branch_id, product_id, movement_type,
        quantity, unit_cost, warehouse_id,
        reference_type, reference_id, notes, created_by
      ) VALUES (
        v_org_id, v_biz_id, v_branch_id, v_item.product_id, 'adjustment',
        v_qty_signed, v_resolved_cost, v_item.warehouse_id,
        'stock_adjustment', p_adjustment_id, v_item.notes, p_user_id
      );
    END IF;

    v_cost_value := v_qty_abs * COALESCE(v_resolved_cost, 0);
    IF v_cost_value > 0 THEN
      v_offset_account := public.resolve_adjustment_offset_account(
        v_org_id, v_biz_id, v_reason, v_qty_signed, v_branch_id
      );
      IF v_offset_account IS NULL THEN
        RAISE EXCEPTION 'Cannot approve stock adjustment: no offset GL account resolved for reason %', v_reason;
      END IF;

      -- ADR 0122 ladder: product -> nearest category -> company inventory account.
      v_line_inv_account := COALESCE(
        public.resolve_product_account_override(v_org_id, v_biz_id, v_item.product_id, 'inventory'),
        v_inventory_account_id
      );

      INSERT INTO _adj_offset_acc (inv_account_id, offset_account_id, inv_debit, inv_credit, off_debit, off_credit)
      VALUES (
        v_line_inv_account,
        v_offset_account,
        CASE WHEN v_qty_signed > 0 THEN v_cost_value ELSE 0 END,
        CASE WHEN v_qty_signed < 0 THEN v_cost_value ELSE 0 END,
        CASE WHEN v_qty_signed < 0 THEN v_cost_value ELSE 0 END,
        CASE WHEN v_qty_signed > 0 THEN v_cost_value ELSE 0 END
      )
      ON CONFLICT (inv_account_id, offset_account_id) DO UPDATE
        SET inv_debit = _adj_offset_acc.inv_debit + EXCLUDED.inv_debit,
            inv_credit = _adj_offset_acc.inv_credit + EXCLUDED.inv_credit,
            off_debit = _adj_offset_acc.off_debit + EXCLUDED.off_debit,
            off_credit = _adj_offset_acc.off_credit + EXCLUDED.off_credit;

      v_total_value := v_total_value + v_cost_value;
    END IF;
  END LOOP;

  UPDATE stock_adjustments
     SET status = 'approved', approved_by = p_user_id, approved_at = now()
   WHERE id = p_adjustment_id;

  IF v_total_value > 0 THEN
    -- Offset side aggregated per offset account.
    FOR v_offset_rec IN
      SELECT offset_account_id,
             SUM(off_debit)  AS off_debit,
             SUM(off_credit) AS off_credit
        FROM _adj_offset_acc
       GROUP BY offset_account_id
    LOOP
      IF v_offset_rec.off_debit > 0 THEN
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account_id', v_offset_rec.offset_account_id,
          'debit', v_offset_rec.off_debit,
          'credit', 0,
          'description', 'Stock adjustment offset'));
      END IF;
      IF v_offset_rec.off_credit > 0 THEN
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account_id', v_offset_rec.offset_account_id,
          'debit', 0,
          'credit', v_offset_rec.off_credit,
          'description', 'Stock adjustment offset'));
      END IF;
    END LOOP;

    -- Inventory side aggregated per resolved inventory account.
    FOR v_offset_rec IN
      SELECT inv_account_id,
             SUM(inv_debit)  AS inv_debit,
             SUM(inv_credit) AS inv_credit
        FROM _adj_offset_acc
       GROUP BY inv_account_id
    LOOP
      IF v_offset_rec.inv_debit > 0 THEN
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account_id', v_offset_rec.inv_account_id,
          'debit', v_offset_rec.inv_debit,
          'credit', 0,
          'description', 'Inventory'));
      END IF;
      IF v_offset_rec.inv_credit > 0 THEN
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account_id', v_offset_rec.inv_account_id,
          'debit', 0,
          'credit', v_offset_rec.inv_credit,
          'description', 'Inventory'));
      END IF;
    END LOOP;

    v_entry_number := public.get_next_journal_entry_number(v_org_id);

    v_journal_id := public.post_journal_entry_atomic(
      _org_id := v_org_id,
      _business_id := v_biz_id,
      _entry_number := v_entry_number,
      _entry_date := CURRENT_DATE,
      _reference := COALESCE(v_adj_number, 'ADJ-' || LEFT(p_adjustment_id::text, 8)),
      _description := 'Stock adjustment ' || COALESCE(v_adj_number, 'ADJ-' || LEFT(p_adjustment_id::text, 8)) || ' (' || COALESCE(v_reason, 'unspecified') || ')',
      _source_type := 'stock_adjustment',
      _source_id := p_adjustment_id,
      _created_by := p_user_id,
      _is_closing := false,
      _is_adjusting := false,
      _lines := v_lines,
      _branch_id := v_branch_id
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'adjustment_id', p_adjustment_id,
    'gl_posted', v_journal_id IS NOT NULL,
    'journal_entry_id', v_journal_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_opening_stock(p_business_id uuid, p_warehouse_id uuid, p_items jsonb, p_user_id uuid DEFAULT auth.uid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id uuid;
  v_branch_id uuid;
  v_adjustment_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_quantity numeric;
  v_unit_cost numeric;
  v_total_value numeric := 0;
  v_inventory_account_id uuid;
  v_line_inv_account uuid;
  v_opening_equity_account_id uuid;
  v_je_id uuid;
  v_adjustment_number text;
  v_count integer := 0;
  v_by_account jsonb := '{}'::jsonb;
  v_key text;
  v_lines jsonb := '[]'::jsonb;
BEGIN
  IF p_business_id IS NULL OR p_warehouse_id IS NULL OR p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'business_id, warehouse_id, and non-empty items are required';
  END IF;

  SELECT organization_id, branch_id
    INTO v_org_id, v_branch_id
    FROM warehouses
   WHERE id = p_warehouse_id AND business_id = p_business_id AND is_active = true;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Warehouse % not found in business %', p_warehouse_id, p_business_id;
  END IF;

  v_inventory_account_id      := public.resolve_default_account(p_business_id, 'inventory');
  v_opening_equity_account_id := public.resolve_default_account(p_business_id, 'opening_equity');

  IF v_inventory_account_id IS NULL THEN
    RAISE EXCEPTION 'Inventory asset account not found in chart of accounts for this company';
  END IF;
  IF v_opening_equity_account_id IS NULL THEN
    RAISE EXCEPTION 'Opening Balance / Equity account not found in chart of accounts for this company';
  END IF;

  v_adjustment_number := 'OPEN-' || to_char(now(), 'YYYYMMDD-HH24MISS');

  INSERT INTO stock_adjustments (
    organization_id, business_id, branch_id, warehouse_id,
    adjustment_number, reason, status, notes, created_by, adjustment_date,
    allow_negative
  ) VALUES (
    v_org_id, p_business_id, v_branch_id, p_warehouse_id,
    v_adjustment_number, 'opening_balance', 'approved',
    'Opening balance entry', p_user_id, now(),
    true
  ) RETURNING id INTO v_adjustment_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_product_id := (v_item->>'product_id')::uuid;
    v_quantity   := COALESCE((v_item->>'quantity')::numeric, 0);
    v_unit_cost  := COALESCE((v_item->>'unit_cost')::numeric, 0);

    IF v_quantity <= 0 THEN CONTINUE; END IF;

    INSERT INTO stock_adjustment_items (
      adjustment_id, product_id, system_quantity, counted_quantity,
      adjustment_quantity, unit_cost
    ) VALUES (
      v_adjustment_id, v_product_id, 0, v_quantity, v_quantity, v_unit_cost
    );

    INSERT INTO stock_movements (
      organization_id, business_id, branch_id, warehouse_id,
      product_id, movement_type, quantity, unit_cost, total_cost,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      v_org_id, p_business_id, v_branch_id, p_warehouse_id,
      v_product_id, 'opening', v_quantity, v_unit_cost, v_quantity * v_unit_cost,
      'stock_adjustment', v_adjustment_id, 'Opening balance', p_user_id
    );

    -- ADR 0122 ladder: product -> nearest category -> company inventory account.
    v_line_inv_account := COALESCE(
      public.resolve_product_account_override(v_org_id, p_business_id, v_product_id, 'inventory'),
      v_inventory_account_id
    );
    v_key := v_line_inv_account::text;
    v_by_account := jsonb_set(
      v_by_account,
      ARRAY[v_key],
      to_jsonb(COALESCE((v_by_account->>v_key)::numeric, 0) + (v_quantity * v_unit_cost))
    );

    v_total_value := v_total_value + (v_quantity * v_unit_cost);
    v_count := v_count + 1;
  END LOOP;

  IF v_total_value > 0 THEN
    FOR v_key IN SELECT jsonb_object_keys(v_by_account) LOOP
      IF (v_by_account->>v_key)::numeric > 0 THEN
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account_id', v_key::uuid,
          'debit', (v_by_account->>v_key)::numeric,
          'credit', 0,
          'description', 'Opening inventory'));
      END IF;
    END LOOP;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_opening_equity_account_id,
      'debit', 0,
      'credit', v_total_value,
      'description', 'Opening balance equity'));

    v_je_id := public.post_journal_entry_atomic(
      v_org_id, p_business_id,
      'JE-' || v_adjustment_number,
      CURRENT_DATE,
      v_adjustment_number,
      'Opening stock balance — ' || v_adjustment_number,
      'stock_adjustment', v_adjustment_id, p_user_id, false, false,
      v_lines,
      NULL, NULL, NULL, v_branch_id
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'adjustment_id', v_adjustment_id,
    'adjustment_number', v_adjustment_number,
    'item_count', v_count,
    'total_value', v_total_value,
    'journal_entry_id', v_je_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.post_stock_adjustment_gl(p_adjustment_id uuid, p_mode text DEFAULT 'opening'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid; v_business uuid; v_branch uuid; v_date date; v_number text;
  v_inv_account uuid; v_counter_account uuid; v_existing uuid; v_je_id uuid;
  v_total_value numeric := 0; v_amt numeric := 0; v_lines jsonb := '[]'::jsonb;
  v_rec RECORD;
BEGIN
  IF p_mode NOT IN ('opening','revaluation') THEN
    RAISE EXCEPTION 'Invalid mode %', p_mode;
  END IF;

  SELECT organization_id, business_id, branch_id, adjustment_date, adjustment_number
    INTO v_org, v_business, v_branch, v_date, v_number
  FROM public.stock_adjustments WHERE id = p_adjustment_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Adjustment % not found', p_adjustment_id; END IF;

  PERFORM public._assert_org_member(v_org);

  SELECT id INTO v_existing FROM public.journal_entries
    WHERE organization_id = v_org AND source_type = 'stock_adjustment' AND source_id = p_adjustment_id
    LIMIT 1;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  SELECT account_id INTO v_inv_account FROM public.default_account_settings
    WHERE organization_id = v_org AND setting_key = 'inventory' LIMIT 1;
  IF v_inv_account IS NULL THEN
    RAISE EXCEPTION 'Inventory default account is not configured';
  END IF;

  IF p_mode = 'opening' THEN
    SELECT account_id INTO v_counter_account FROM public.default_account_settings
      WHERE organization_id = v_org AND setting_key = 'opening_balance_equity' LIMIT 1;
    IF v_counter_account IS NULL THEN
      RAISE EXCEPTION 'Opening Balance Equity default account is not configured';
    END IF;
  ELSE
    SELECT account_id INTO v_counter_account FROM public.default_account_settings
      WHERE organization_id = v_org AND setting_key IN ('inventory_adjustment','cogs')
      ORDER BY CASE setting_key WHEN 'inventory_adjustment' THEN 0 ELSE 1 END LIMIT 1;
    IF v_counter_account IS NULL THEN
      RAISE EXCEPTION 'Inventory Adjustment / COGS default account is not configured';
    END IF;
  END IF;

  -- Per-line valuation, with the inventory account resolved through the
  -- ADR 0122 ladder (product -> nearest category -> company default).
  CREATE TEMP TABLE IF NOT EXISTS _psag_inv_acc (
    inv_account_id uuid PRIMARY KEY,
    value numeric NOT NULL DEFAULT 0
  ) ON COMMIT DROP;
  TRUNCATE TABLE _psag_inv_acc;

  FOR v_rec IN
    SELECT sai.product_id,
           sai.quantity_adjustment *
             COALESCE(
               NULLIF(sai.unit_cost, 0),
               NULLIF(public.compute_unit_cost(v_business, sai.product_id, sai.warehouse_id), 0),
               p.cost_price,
               0
             ) AS line_value
      FROM public.stock_adjustment_items sai
      JOIN public.products p ON p.id = sai.product_id
     WHERE sai.adjustment_id = p_adjustment_id
  LOOP
    IF COALESCE(v_rec.line_value, 0) = 0 THEN CONTINUE; END IF;

    INSERT INTO _psag_inv_acc (inv_account_id, value)
    VALUES (
      COALESCE(
        public.resolve_product_account_override(v_org, v_business, v_rec.product_id, 'inventory'),
        v_inv_account
      ),
      v_rec.line_value
    )
    ON CONFLICT (inv_account_id) DO UPDATE
      SET value = _psag_inv_acc.value + EXCLUDED.value;

    v_total_value := v_total_value + v_rec.line_value;
  END LOOP;

  IF v_total_value = 0 THEN
    RAISE EXCEPTION 'Stock adjustment has zero value — refusing to post empty journal';
  END IF;

  v_amt := abs(v_total_value);

  FOR v_rec IN SELECT inv_account_id, value FROM _psag_inv_acc WHERE value <> 0 LOOP
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_rec.inv_account_id,
      'debit',  CASE WHEN v_rec.value > 0 THEN v_rec.value ELSE 0 END,
      'credit', CASE WHEN v_rec.value < 0 THEN abs(v_rec.value) ELSE 0 END,
      'description', CASE WHEN v_rec.value > 0 THEN 'Inventory increase' ELSE 'Inventory decrease' END,
      'business_id', v_business, 'branch_id', v_branch));
  END LOOP;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', v_counter_account,
    'debit',  CASE WHEN v_total_value < 0 THEN v_amt ELSE 0 END,
    'credit', CASE WHEN v_total_value > 0 THEN v_amt ELSE 0 END,
    'description', CASE WHEN p_mode='opening' THEN 'Opening Balance Equity' ELSE 'Inventory Adjustment' END,
    'business_id', v_business, 'branch_id', v_branch));

  v_je_id := public.post_journal_entry_atomic(
    v_org, v_business,
    public.generate_next_je_number(v_org, v_business),
    v_date,
    v_number,
    CASE WHEN p_mode='opening' THEN 'Opening Inventory — ' ELSE 'Inventory Revaluation — ' END || COALESCE(v_number,''),
    'stock_adjustment', p_adjustment_id, auth.uid(), false, false,
    v_lines, NULL, NULL, p_mode, v_branch
  );

  IF p_mode = 'opening' THEN
    UPDATE public.journal_entries SET is_opening_entry = true WHERE id = v_je_id;
  END IF;

  RETURN v_je_id;
END;
$function$;