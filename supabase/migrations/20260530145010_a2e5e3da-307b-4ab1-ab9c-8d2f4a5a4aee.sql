
-- post_stock_adjustment_gl: fall back through compute_unit_cost before products.cost_price
CREATE OR REPLACE FUNCTION public.post_stock_adjustment_gl(p_adjustment_id uuid, p_mode text DEFAULT 'opening'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid; v_business uuid; v_date date; v_number text;
  v_inv_account uuid; v_counter_account uuid; v_existing uuid; v_je_id uuid;
  v_total_value numeric := 0; v_dr numeric := 0; v_cr numeric := 0;
BEGIN
  IF p_mode NOT IN ('opening','revaluation') THEN
    RAISE EXCEPTION 'Invalid mode %', p_mode;
  END IF;

  SELECT organization_id, business_id, adjustment_date, adjustment_number
    INTO v_org, v_business, v_date, v_number
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

  -- Use compute_unit_cost (cost-model aware) before falling back to products.cost_price.
  SELECT COALESCE(SUM(
           sai.quantity_adjustment *
           COALESCE(
             NULLIF(sai.unit_cost, 0),
             NULLIF(public.compute_unit_cost(v_business, sai.product_id, sai.warehouse_id), 0),
             p.cost_price,
             0
           )
         ), 0)
    INTO v_total_value
  FROM public.stock_adjustment_items sai
  JOIN public.products p ON p.id = sai.product_id
  WHERE sai.adjustment_id = p_adjustment_id;

  IF v_total_value = 0 THEN
    RAISE EXCEPTION 'Stock adjustment has zero value — refusing to post empty journal';
  END IF;

  IF v_total_value > 0 THEN
    v_dr := v_total_value; v_cr := v_total_value;
  ELSE
    v_dr := -v_total_value; v_cr := -v_total_value;
  END IF;

  INSERT INTO public.journal_entries (
    organization_id, business_id, entry_date, description, status,
    source_type, source_id, total_debit, total_credit, posted_at, posted_by, is_opening_entry
  ) VALUES (
    v_org, v_business, v_date,
    CASE WHEN p_mode='opening' THEN 'Opening Inventory — ' ELSE 'Inventory Revaluation — ' END || COALESCE(v_number,''),
    'posted', 'stock_adjustment', p_adjustment_id,
    v_dr, v_cr, now(), auth.uid(), p_mode = 'opening'
  ) RETURNING id INTO v_je_id;

  IF v_total_value > 0 THEN
    INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
    VALUES
      (v_je_id, v_inv_account, v_dr, 0, 'Inventory increase', 0),
      (v_je_id, v_counter_account, 0, v_cr,
       CASE WHEN p_mode='opening' THEN 'Opening Balance Equity' ELSE 'Inventory Adjustment' END, 1);
  ELSE
    INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
    VALUES
      (v_je_id, v_counter_account, v_dr, 0,
       CASE WHEN p_mode='opening' THEN 'Opening Balance Equity' ELSE 'Inventory Adjustment' END, 0),
      (v_je_id, v_inv_account, 0, v_cr, 'Inventory decrease', 1);
  END IF;

  RETURN v_je_id;
END;
$function$;

-- stamp_pos_item_cost_snapshot: use compute_unit_cost via shift→warehouse lookup
CREATE OR REPLACE FUNCTION public.stamp_pos_item_cost_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_business_id uuid;
  v_warehouse_id uuid;
  v_computed numeric;
BEGIN
  IF (NEW.cost_price IS NULL OR NEW.cost_price = 0) AND NEW.product_id IS NOT NULL THEN
    SELECT t.business_id, s.warehouse_id
      INTO v_business_id, v_warehouse_id
      FROM public.pos_transactions t
      LEFT JOIN public.pos_shifts s ON s.id = t.shift_id
      WHERE t.id = NEW.transaction_id;

    IF v_business_id IS NOT NULL THEN
      v_computed := public.compute_unit_cost(v_business_id, NEW.product_id, v_warehouse_id);
      IF v_computed IS NOT NULL AND v_computed > 0 THEN
        NEW.cost_price := v_computed;
      END IF;
    END IF;

    IF NEW.cost_price IS NULL OR NEW.cost_price = 0 THEN
      SELECT COALESCE(cost_price, 0) INTO NEW.cost_price
      FROM public.products WHERE id = NEW.product_id;
    END IF;
  END IF;

  NEW.cost_price := COALESCE(NEW.cost_price, 0);
  RETURN NEW;
END;
$function$;
