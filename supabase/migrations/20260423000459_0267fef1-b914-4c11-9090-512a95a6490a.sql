-- Stage B — Branch-true availability for inventory decision functions.
-- Per ARCHITECTURE.md, products.stock_quantity is a *deprecated company aggregate*
-- and must not drive branch-level decisions. Replace stock-decision RPCs to read
-- from warehouse_stock filtered by (business, branch).

-- =====================================================================
-- B2 — auto_create_replenishment_po
-- =====================================================================
CREATE OR REPLACE FUNCTION public.auto_create_replenishment_po()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  rule RECORD;
  br RECORD;
  effective_branch_id uuid;
  on_hand numeric;
  vendor_id uuid;
  vendor_orders jsonb := '{}'::jsonb;
  vendor_key text;
  po_id uuid;
  po_number text;
  item_total numeric;
  result jsonb := '{"created": 0, "skipped": 0, "errors": 0}'::jsonb;
  v_entry jsonb;
  v_items jsonb;
  v_item jsonb;
BEGIN
  FOR rule IN
    SELECT
      r.id AS rule_id,
      r.organization_id,
      r.business_id,
      r.branch_id,
      r.product_id,
      r.min_quantity,
      r.reorder_quantity,
      r.preferred_supplier_id,
      p.name AS product_name,
      p.cost_price,
      p.unit_price AS product_unit_price
    FROM product_reorder_rules r
    JOIN products p ON p.id = r.product_id
    WHERE r.is_active = true
      AND r.auto_create_po = true
  LOOP
    FOR br IN
      SELECT b.id AS branch_id
      FROM branches b
      WHERE b.business_id = rule.business_id
        AND b.is_active = true
        AND (rule.branch_id IS NULL OR b.id = rule.branch_id)
    LOOP
      effective_branch_id := br.branch_id;

      SELECT COALESCE(SUM(ws.quantity), 0) INTO on_hand
        FROM warehouse_stock ws
        JOIN warehouses w ON w.id = ws.warehouse_id
       WHERE ws.product_id = rule.product_id
         AND w.branch_id = effective_branch_id
         AND w.business_id = rule.business_id
         AND COALESCE(w.is_in_transit, false) = false;

      IF on_hand > rule.min_quantity THEN
        result := jsonb_set(result, '{skipped}', to_jsonb((result->>'skipped')::int + 1));
        CONTINUE;
      END IF;

      SELECT vp.vendor_id INTO vendor_id
        FROM vendor_pricelists vp
       WHERE vp.product_id = rule.product_id
         AND vp.organization_id = rule.organization_id
         AND vp.is_preferred = true
         AND vp.is_active = true
       LIMIT 1;

      IF vendor_id IS NULL THEN
        vendor_id := rule.preferred_supplier_id;
      END IF;

      IF vendor_id IS NULL THEN
        INSERT INTO replenishment_logs (
          organization_id, business_id, product_id, reorder_rule_id,
          trigger_type, current_stock, reorder_quantity, status, error_message
        ) VALUES (
          rule.organization_id, rule.business_id, rule.product_id, rule.rule_id,
          'auto', on_hand, COALESCE(rule.reorder_quantity, 0), 'failed',
          'No preferred vendor found'
        );
        result := jsonb_set(result, '{errors}', to_jsonb((result->>'errors')::int + 1));
        CONTINUE;
      END IF;

      IF EXISTS (
        SELECT 1 FROM replenishment_logs rl
        LEFT JOIN purchase_orders po ON po.id = rl.purchase_order_id
         WHERE rl.reorder_rule_id = rule.rule_id
           AND COALESCE(po.branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
               = COALESCE(effective_branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
           AND rl.status IN ('pending','po_created')
           AND rl.triggered_at > now() - interval '24 hours'
      ) THEN
        result := jsonb_set(result, '{skipped}', to_jsonb((result->>'skipped')::int + 1));
        CONTINUE;
      END IF;

      vendor_key := vendor_id::text
                    || '|' || rule.organization_id::text
                    || '|' || rule.business_id::text
                    || '|' || effective_branch_id::text;

      SELECT COALESCE(vp.unit_price, rule.cost_price, rule.product_unit_price, 0) INTO item_total
        FROM (SELECT 1) dummy
        LEFT JOIN vendor_pricelists vp ON vp.vendor_id = vendor_id
          AND vp.product_id = rule.product_id
          AND vp.organization_id = rule.organization_id
          AND vp.is_active = true
       LIMIT 1;

      IF vendor_orders ? vendor_key THEN
        v_entry := vendor_orders->vendor_key;
        v_items := v_entry->'items';
      ELSE
        v_entry := jsonb_build_object(
          'vendor_id', vendor_id,
          'organization_id', rule.organization_id,
          'business_id', rule.business_id,
          'branch_id', effective_branch_id,
          'items', '[]'::jsonb
        );
        v_items := '[]'::jsonb;
      END IF;

      v_item := jsonb_build_object(
        'product_id', rule.product_id,
        'description', rule.product_name,
        'quantity', COALESCE(rule.reorder_quantity, rule.min_quantity * 2),
        'unit_price', item_total,
        'rule_id', rule.rule_id,
        'current_stock', on_hand
      );

      v_items := v_items || v_item;
      v_entry := jsonb_set(v_entry, '{items}', v_items);
      vendor_orders := jsonb_set(vendor_orders, ARRAY[vendor_key], v_entry);
    END LOOP;
  END LOOP;

  FOR vendor_key IN SELECT jsonb_object_keys(vendor_orders) LOOP
    v_entry := vendor_orders->vendor_key;

    SELECT get_next_po_number((v_entry->>'organization_id')::uuid) INTO po_number;

    INSERT INTO purchase_orders (
      organization_id, business_id, branch_id, vendor_id, po_number, status,
      order_date, subtotal, tax_amount, total, notes
    ) VALUES (
      (v_entry->>'organization_id')::uuid,
      (v_entry->>'business_id')::uuid,
      (v_entry->>'branch_id')::uuid,
      (v_entry->>'vendor_id')::uuid,
      po_number,
      'draft',
      CURRENT_DATE,
      0, 0, 0,
      'Auto-generated by replenishment engine'
    ) RETURNING id INTO po_id;

    DECLARE
      total_subtotal numeric := 0;
      qty integer;
      price numeric;
      idx integer := 0;
    BEGIN
      FOR v_item IN SELECT jsonb_array_elements(v_entry->'items') LOOP
        qty := (v_item->>'quantity')::integer;
        price := (v_item->>'unit_price')::numeric;

        INSERT INTO purchase_order_items (
          purchase_order_id, product_id, description, quantity, quantity_received,
          unit_price, tax_rate, tax_amount, line_total, sort_order
        ) VALUES (
          po_id,
          (v_item->>'product_id')::uuid,
          v_item->>'description',
          qty, 0,
          price, 0, 0,
          qty * price,
          idx
        );

        total_subtotal := total_subtotal + (qty * price);
        idx := idx + 1;

        INSERT INTO replenishment_logs (
          organization_id, business_id, product_id, reorder_rule_id, purchase_order_id,
          trigger_type, current_stock, reorder_quantity, status
        ) VALUES (
          (v_entry->>'organization_id')::uuid,
          (v_entry->>'business_id')::uuid,
          (v_item->>'product_id')::uuid,
          (v_item->>'rule_id')::uuid,
          po_id,
          'auto',
          (v_item->>'current_stock')::integer,
          qty,
          'po_created'
        );
      END LOOP;

      UPDATE purchase_orders SET subtotal = total_subtotal, total = total_subtotal WHERE id = po_id;
    END;

    result := jsonb_set(result, '{created}', to_jsonb((result->>'created')::int + 1));
  END LOOP;

  RETURN result;
END;
$function$;

-- =====================================================================
-- B3 — get_available_pos_stock(p_product_id, p_register_id)
-- DROP the old (uuid, uuid) overload (param was p_exclude_register_id) before
-- recreating with renamed param p_register_id (semantic change).
-- =====================================================================
DROP FUNCTION IF EXISTS public.get_available_pos_stock(uuid, uuid);

CREATE FUNCTION public.get_available_pos_stock(
  p_product_id uuid,
  p_register_id uuid
)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_branch_id uuid;
  v_business_id uuid;
  v_warehouse_id uuid;
  v_stock numeric;
  v_reserved numeric;
BEGIN
  SELECT pr.branch_id, pr.business_id
    INTO v_branch_id, v_business_id
    FROM pos_registers pr
   WHERE pr.id = p_register_id;

  IF v_branch_id IS NULL OR v_business_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT ps.warehouse_id INTO v_warehouse_id
    FROM pos_shifts ps
   WHERE ps.register_id = p_register_id
     AND ps.status = 'open'
   ORDER BY ps.opened_at DESC
   LIMIT 1;

  IF v_warehouse_id IS NOT NULL THEN
    SELECT COALESCE(SUM(quantity), 0) INTO v_stock
      FROM warehouse_stock
     WHERE product_id = p_product_id
       AND warehouse_id = v_warehouse_id
       AND business_id = v_business_id
       AND branch_id = v_branch_id;
  ELSE
    SELECT COALESCE(SUM(ws.quantity), 0) INTO v_stock
      FROM warehouse_stock ws
      JOIN warehouses w ON w.id = ws.warehouse_id
     WHERE ws.product_id = p_product_id
       AND ws.business_id = v_business_id
       AND ws.branch_id = v_branch_id
       AND COALESCE(w.is_in_transit, false) = false;
  END IF;

  SELECT COALESCE(SUM(psr.quantity), 0) INTO v_reserved
    FROM pos_stock_reservations psr
    JOIN pos_registers pr ON pr.id = psr.register_id
   WHERE psr.product_id = p_product_id
     AND psr.expires_at > now()
     AND pr.branch_id = v_branch_id
     AND pr.business_id = v_business_id
     AND psr.register_id != p_register_id;

  RETURN GREATEST(0, v_stock - v_reserved);
END;
$function$;

COMMENT ON FUNCTION public.get_available_pos_stock(uuid, uuid)
  IS 'Branch-true POS availability. Args: (p_product_id, p_register_id). Resolves register -> branch + active shift warehouse, sums on-hand within that branch only, subtracts other-register reservations.';

-- =====================================================================
-- B4 — reconcile_stock_quantities
-- Drop the dangerous org-only overload. Keep the (org, business) overload.
-- =====================================================================
DROP FUNCTION IF EXISTS public.reconcile_stock_quantities(uuid);

CREATE OR REPLACE FUNCTION public.reconcile_stock_quantities(
  p_organization_id uuid,
  p_business_id uuid
)
 RETURNS TABLE(
   product_id uuid,
   product_name text,
   sku text,
   stored_quantity numeric,
   calculated_quantity numeric,
   difference numeric
 )
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    p.id AS product_id,
    p.name AS product_name,
    p.sku,
    COALESCE(p.stock_quantity, 0) AS stored_quantity,
    COALESCE(sm.total, 0) AS calculated_quantity,
    COALESCE(p.stock_quantity, 0) - COALESCE(sm.total, 0) AS difference
  FROM products p
  LEFT JOIN (
    SELECT product_id, SUM(quantity) AS total
      FROM stock_movements
     WHERE organization_id = p_organization_id
       AND business_id = p_business_id
     GROUP BY product_id
  ) sm ON sm.product_id = p.id
  WHERE p.organization_id = p_organization_id
    AND p.business_id = p_business_id
    AND p.track_inventory = true
    AND COALESCE(p.stock_quantity, 0) != COALESCE(sm.total, 0)
  ORDER BY ABS(COALESCE(p.stock_quantity, 0) - COALESCE(sm.total, 0)) DESC;
$function$;

COMMENT ON FUNCTION public.reconcile_stock_quantities(uuid, uuid)
  IS 'Per-company reconciliation between products.stock_quantity (deprecated aggregate) and SUM(stock_movements). Always pass both org and business — the org-only overload was removed to prevent cross-company contamination.';
