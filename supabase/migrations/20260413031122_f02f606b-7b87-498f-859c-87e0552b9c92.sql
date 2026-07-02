
-- =============================================
-- 1. apply_physical_count_atomic
-- =============================================
CREATE OR REPLACE FUNCTION public.apply_physical_count_atomic(
  p_organization_id UUID,
  p_business_id UUID,
  p_warehouse_id UUID,
  p_user_id UUID,
  p_lines JSONB -- array of { product_id, system_qty, counted_qty, variance, cost_price }
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_adj_id UUID;
  v_line JSONB;
  v_total_positive numeric := 0;
  v_total_negative numeric := 0;
  v_inventory_account_id UUID;
  v_adjustment_account_id UUID;
  v_journal_id UUID;
  v_entry_number TEXT;
  v_count INT := 0;
  v_cost numeric;
BEGIN
  -- Create stock_adjustment record
  INSERT INTO stock_adjustments (
    organization_id, business_id, adjustment_number, adjustment_date,
    reason, notes, status, approved_by, approved_at, created_by
  ) VALUES (
    p_organization_id, p_business_id,
    'COUNT-' || UPPER(TO_HEX(EXTRACT(EPOCH FROM now())::bigint)),
    CURRENT_DATE,
    'Physical Count',
    'Physical inventory count — atomic',
    'approved', p_user_id, now(), p_user_id
  ) RETURNING id INTO v_adj_id;

  -- Process each variance line
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_count := v_count + 1;

    -- Create adjustment item
    INSERT INTO stock_adjustment_items (
      adjustment_id, product_id, quantity_before, quantity_adjustment,
      quantity_after, unit_cost, warehouse_id, notes
    ) VALUES (
      v_adj_id,
      (v_line->>'product_id')::UUID,
      (v_line->>'system_qty')::numeric,
      (v_line->>'variance')::numeric,
      (v_line->>'system_qty')::numeric + (v_line->>'variance')::numeric,
      (v_line->>'cost_price')::numeric,
      p_warehouse_id,
      'System: ' || (v_line->>'system_qty') || ', Counted: ' || (v_line->>'counted_qty')
    );

    -- Create stock movement
    INSERT INTO stock_movements (
      organization_id, business_id, product_id, warehouse_id,
      movement_type, quantity, unit_cost,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      p_organization_id, p_business_id,
      (v_line->>'product_id')::UUID, p_warehouse_id,
      'count', (v_line->>'variance')::numeric, (v_line->>'cost_price')::numeric,
      'stock_adjustment', v_adj_id,
      'Physical count adjustment. System: ' || (v_line->>'system_qty') || ', Counted: ' || (v_line->>'counted_qty'),
      p_user_id
    );

    -- Accumulate GL costs
    v_cost := ABS((v_line->>'variance')::numeric) * COALESCE((v_line->>'cost_price')::numeric, 0);
    IF v_cost > 0 THEN
      IF (v_line->>'variance')::numeric > 0 THEN
        v_total_positive := v_total_positive + v_cost;
      ELSE
        v_total_negative := v_total_negative + v_cost;
      END IF;
    END IF;
  END LOOP;

  -- GL posting
  SELECT a.id INTO v_inventory_account_id
  FROM accounts a WHERE a.organization_id = p_organization_id
    AND a.detail_type = 'inventory' AND a.is_active = true LIMIT 1;

  SELECT a.id INTO v_adjustment_account_id
  FROM accounts a WHERE a.organization_id = p_organization_id
    AND a.detail_type = 'inventory_adjustment' AND a.is_active = true LIMIT 1;

  IF v_adjustment_account_id IS NULL THEN
    SELECT a.id INTO v_adjustment_account_id
    FROM accounts a WHERE a.organization_id = p_organization_id
      AND a.detail_type = 'operating_expenses' AND a.is_active = true LIMIT 1;
  END IF;

  IF v_inventory_account_id IS NOT NULL AND v_adjustment_account_id IS NOT NULL
     AND (v_total_positive > 0 OR v_total_negative > 0) THEN

    -- Generate entry number
    SELECT 'JE-' || LPAD((COALESCE(MAX(CAST(SUBSTRING(entry_number FROM 4) AS integer)), 0) + 1)::text, 5, '0')
    INTO v_entry_number
    FROM journal_entries WHERE organization_id = p_organization_id;

    INSERT INTO journal_entries (
      organization_id, business_id, entry_number, entry_date, description,
      reference, source_type, source_id, status, posted_at, posted_by, created_by
    ) VALUES (
      p_organization_id, p_business_id, v_entry_number, CURRENT_DATE,
      'Physical count — ' || v_count || ' adjustments',
      'COUNT-' || LEFT(v_adj_id::text, 8),
      'physical_count', v_adj_id,
      'posted', now(), p_user_id, p_user_id
    ) RETURNING id INTO v_journal_id;

    IF v_total_positive > 0 THEN
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
      VALUES
        (v_journal_id, v_inventory_account_id, v_total_positive, 0, 'Physical count — inventory surplus'),
        (v_journal_id, v_adjustment_account_id, 0, v_total_positive, 'Physical count — surplus offset');
    END IF;

    IF v_total_negative > 0 THEN
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
      VALUES
        (v_journal_id, v_adjustment_account_id, v_total_negative, 0, 'Physical count — inventory shrinkage'),
        (v_journal_id, v_inventory_account_id, 0, v_total_negative, 'Physical count — shrinkage reduction');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'adjustment_id', v_adj_id,
    'lines_processed', v_count,
    'gl_posted', v_journal_id IS NOT NULL
  );
END;
$$;

-- =============================================
-- 2. record_scrap_atomic
-- =============================================
CREATE OR REPLACE FUNCTION public.record_scrap_atomic(
  p_organization_id UUID,
  p_business_id UUID,
  p_product_id UUID,
  p_warehouse_id UUID,
  p_quantity numeric,
  p_unit_cost numeric,
  p_reason TEXT,
  p_notes TEXT,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_movement_id UUID;
  v_scrap_cost numeric;
  v_inventory_account_id UUID;
  v_adjustment_account_id UUID;
  v_journal_id UUID;
  v_entry_number TEXT;
  v_product_name TEXT;
BEGIN
  -- Get product name for references
  SELECT name INTO v_product_name FROM products WHERE id = p_product_id;

  -- Create stock movement (negative quantity)
  INSERT INTO stock_movements (
    organization_id, business_id, product_id, warehouse_id,
    movement_type, quantity, unit_cost, notes, created_by
  ) VALUES (
    p_organization_id, p_business_id, p_product_id, p_warehouse_id,
    'scrap', -ABS(p_quantity), p_unit_cost,
    'Scrap: ' || p_reason || CASE WHEN p_notes IS NOT NULL AND p_notes != '' THEN ' — ' || p_notes ELSE '' END,
    p_user_id
  ) RETURNING id INTO v_movement_id;

  -- GL posting
  v_scrap_cost := ABS(p_quantity) * COALESCE(p_unit_cost, 0);

  IF v_scrap_cost > 0 THEN
    -- Try product-specific inventory account first
    SELECT inventory_account_id INTO v_inventory_account_id
    FROM products WHERE id = p_product_id AND inventory_account_id IS NOT NULL;

    IF v_inventory_account_id IS NULL THEN
      SELECT a.id INTO v_inventory_account_id
      FROM accounts a WHERE a.organization_id = p_organization_id
        AND a.detail_type = 'inventory' AND a.is_active = true LIMIT 1;
    END IF;

    SELECT a.id INTO v_adjustment_account_id
    FROM accounts a WHERE a.organization_id = p_organization_id
      AND a.detail_type = 'inventory_adjustment' AND a.is_active = true LIMIT 1;

    IF v_adjustment_account_id IS NULL THEN
      SELECT a.id INTO v_adjustment_account_id
      FROM accounts a WHERE a.organization_id = p_organization_id
        AND a.detail_type = 'operating_expenses' AND a.is_active = true LIMIT 1;
    END IF;

    IF v_inventory_account_id IS NOT NULL AND v_adjustment_account_id IS NOT NULL THEN
      SELECT 'JE-' || LPAD((COALESCE(MAX(CAST(SUBSTRING(entry_number FROM 4) AS integer)), 0) + 1)::text, 5, '0')
      INTO v_entry_number
      FROM journal_entries WHERE organization_id = p_organization_id;

      INSERT INTO journal_entries (
        organization_id, business_id, entry_number, entry_date, description,
        reference, source_type, source_id, status, posted_at, posted_by, created_by
      ) VALUES (
        p_organization_id, p_business_id, v_entry_number, CURRENT_DATE,
        'Scrap: ' || COALESCE(v_product_name, '') || ' x' || ABS(p_quantity),
        'SCRAP-' || LEFT(v_movement_id::text, 8),
        'scrap', v_movement_id,
        'posted', now(), p_user_id, p_user_id
      ) RETURNING id INTO v_journal_id;

      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
      VALUES
        (v_journal_id, v_adjustment_account_id, v_scrap_cost, 0, 'Scrap loss — ' || COALESCE(v_product_name, '')),
        (v_journal_id, v_inventory_account_id, 0, v_scrap_cost, 'Inventory reduction — ' || COALESCE(v_product_name, ''));
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'movement_id', v_movement_id,
    'gl_posted', v_journal_id IS NOT NULL
  );
END;
$$;

-- =============================================
-- 3. COGS auto-posting trigger on sale/delivery movements
-- =============================================
CREATE OR REPLACE FUNCTION public.post_cogs_on_sale_movement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cost_price numeric;
  v_cogs_account_id UUID;
  v_inventory_account_id UUID;
  v_cogs_amount numeric;
  v_journal_id UUID;
  v_entry_number TEXT;
  v_product_name TEXT;
BEGIN
  -- Only fire on sale or delivery movements with negative quantity
  IF NEW.movement_type NOT IN ('sale', 'delivery') OR NEW.quantity >= 0 THEN
    RETURN NEW;
  END IF;

  -- Get product cost and account mappings
  SELECT p.cost_price, p.cogs_account_id, p.inventory_account_id, p.name
  INTO v_cost_price, v_cogs_account_id, v_inventory_account_id, v_product_name
  FROM products p WHERE p.id = NEW.product_id;

  v_cost_price := COALESCE(NULLIF(v_cost_price, 0), NEW.unit_cost, 0);
  IF v_cost_price <= 0 THEN
    RETURN NEW; -- No cost to post
  END IF;

  v_cogs_amount := ABS(NEW.quantity) * v_cost_price;

  -- Fallback to org-level accounts
  IF v_cogs_account_id IS NULL THEN
    SELECT a.id INTO v_cogs_account_id
    FROM accounts a WHERE a.organization_id = NEW.organization_id
      AND a.detail_type = 'cost_of_goods_sold' AND a.is_active = true LIMIT 1;
  END IF;

  IF v_inventory_account_id IS NULL THEN
    SELECT a.id INTO v_inventory_account_id
    FROM accounts a WHERE a.organization_id = NEW.organization_id
      AND a.detail_type = 'inventory' AND a.is_active = true LIMIT 1;
  END IF;

  -- Only post if both accounts exist
  IF v_cogs_account_id IS NOT NULL AND v_inventory_account_id IS NOT NULL THEN
    SELECT 'JE-' || LPAD((COALESCE(MAX(CAST(SUBSTRING(entry_number FROM 4) AS integer)), 0) + 1)::text, 5, '0')
    INTO v_entry_number
    FROM journal_entries WHERE organization_id = NEW.organization_id;

    INSERT INTO journal_entries (
      organization_id, business_id, entry_number, entry_date, description,
      reference, source_type, source_id, status, posted_at, created_by
    ) VALUES (
      NEW.organization_id, NEW.business_id, v_entry_number, CURRENT_DATE,
      'COGS — ' || COALESCE(v_product_name, '') || ' x' || ABS(NEW.quantity),
      COALESCE(NEW.reference_type, 'sale') || '-' || LEFT(COALESCE(NEW.reference_id::text, NEW.id::text), 8),
      'cogs', NEW.id,
      'posted', now(), NEW.created_by
    ) RETURNING id INTO v_journal_id;

    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
    VALUES
      (v_journal_id, v_cogs_account_id, v_cogs_amount, 0, 'Cost of goods sold — ' || COALESCE(v_product_name, '')),
      (v_journal_id, v_inventory_account_id, 0, v_cogs_amount, 'Inventory reduction — ' || COALESCE(v_product_name, ''));
  END IF;

  RETURN NEW;
END;
$$;

-- Create the trigger (AFTER INSERT so stock is already updated)
DROP TRIGGER IF EXISTS trg_post_cogs_on_sale ON public.stock_movements;
CREATE TRIGGER trg_post_cogs_on_sale
  AFTER INSERT ON public.stock_movements
  FOR EACH ROW
  WHEN (NEW.movement_type IN ('sale', 'delivery'))
  EXECUTE FUNCTION public.post_cogs_on_sale_movement();

-- =============================================
-- 4. Update create_invoice_stock_movements to accept warehouse_id
-- =============================================
CREATE OR REPLACE FUNCTION public.create_invoice_stock_movements(
  p_invoice_id UUID,
  p_organization_id UUID,
  p_created_by UUID,
  p_warehouse_id UUID DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item RECORD;
  v_inv RECORD;
BEGIN
  SELECT invoice_number INTO v_inv FROM invoices WHERE id = p_invoice_id;

  FOR v_item IN
    SELECT ii.product_id, ii.quantity, p.track_inventory
    FROM invoice_items ii
    JOIN products p ON p.id = ii.product_id
    WHERE ii.invoice_id = p_invoice_id
      AND ii.product_id IS NOT NULL
      AND p.track_inventory = true
  LOOP
    INSERT INTO stock_movements (
      organization_id, product_id, warehouse_id, movement_type, quantity,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      p_organization_id,
      v_item.product_id,
      p_warehouse_id,
      'sale',
      -v_item.quantity,
      'invoice',
      p_invoice_id,
      'Invoice ' || COALESCE(v_inv.invoice_number, ''),
      p_created_by
    );
  END LOOP;
END;
$$;
