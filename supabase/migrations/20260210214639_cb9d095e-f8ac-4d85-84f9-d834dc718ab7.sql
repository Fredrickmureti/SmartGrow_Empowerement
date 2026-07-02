
-- Phase 2: Replenishment Logs table
CREATE TABLE public.replenishment_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  reorder_rule_id uuid NOT NULL REFERENCES public.product_reorder_rules(id) ON DELETE CASCADE,
  purchase_order_id uuid REFERENCES public.purchase_orders(id) ON DELETE SET NULL,
  triggered_at timestamptz NOT NULL DEFAULT now(),
  trigger_type text NOT NULL DEFAULT 'auto',
  current_stock integer NOT NULL DEFAULT 0,
  reorder_quantity integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.replenishment_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "replenishment_logs_select" ON public.replenishment_logs
  FOR SELECT USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  );

CREATE POLICY "replenishment_logs_insert" ON public.replenishment_logs
  FOR INSERT WITH CHECK (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  );

CREATE INDEX idx_replenishment_logs_org ON public.replenishment_logs(organization_id);
CREATE INDEX idx_replenishment_logs_product ON public.replenishment_logs(product_id);
CREATE INDEX idx_replenishment_logs_po ON public.replenishment_logs(purchase_order_id);

-- Auto-replenishment function
-- Scans reorder rules with auto_create_po=true, checks stock, creates draft POs grouped by vendor
CREATE OR REPLACE FUNCTION public.auto_create_replenishment_po()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rule RECORD;
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
  -- Find all active reorder rules with auto_create_po enabled where stock is below min_quantity
  FOR rule IN
    SELECT
      r.id AS rule_id,
      r.organization_id,
      r.business_id,
      r.product_id,
      r.min_quantity,
      r.reorder_quantity,
      r.preferred_supplier_id,
      p.stock_quantity,
      p.name AS product_name,
      p.cost_price,
      p.unit_price AS product_unit_price
    FROM product_reorder_rules r
    JOIN products p ON p.id = r.product_id
    WHERE r.is_active = true
      AND r.auto_create_po = true
      AND COALESCE(p.stock_quantity, 0) <= r.min_quantity
  LOOP
    -- Determine vendor: prefer vendor_pricelists preferred, fallback to rule's preferred_supplier_id
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

    -- Skip if no vendor found
    IF vendor_id IS NULL THEN
      INSERT INTO replenishment_logs (organization_id, business_id, product_id, reorder_rule_id, trigger_type, current_stock, reorder_quantity, status, error_message)
      VALUES (rule.organization_id, rule.business_id, rule.product_id, rule.rule_id, 'auto', COALESCE(rule.stock_quantity, 0), COALESCE(rule.reorder_quantity, 0), 'failed', 'No preferred vendor found');
      result := jsonb_set(result, '{errors}', to_jsonb((result->>'errors')::int + 1));
      CONTINUE;
    END IF;

    -- Check if there's already a pending replenishment log for this rule (avoid duplicates)
    IF EXISTS (
      SELECT 1 FROM replenishment_logs rl
      WHERE rl.reorder_rule_id = rule.rule_id
        AND rl.status IN ('pending', 'po_created')
        AND rl.triggered_at > now() - interval '24 hours'
    ) THEN
      result := jsonb_set(result, '{skipped}', to_jsonb((result->>'skipped')::int + 1));
      CONTINUE;
    END IF;

    -- Group by vendor+org+business key
    vendor_key := vendor_id::text || '|' || rule.organization_id::text || '|' || COALESCE(rule.business_id::text, 'null');

    -- Get vendor unit price from pricelist, fallback to product cost_price
    SELECT COALESCE(vp.unit_price, rule.cost_price, rule.product_unit_price, 0) INTO item_total
    FROM (SELECT 1) dummy
    LEFT JOIN vendor_pricelists vp ON vp.vendor_id = vendor_id
      AND vp.product_id = rule.product_id
      AND vp.organization_id = rule.organization_id
      AND vp.is_active = true
    LIMIT 1;

    -- Accumulate items per vendor
    IF vendor_orders ? vendor_key THEN
      v_entry := vendor_orders->vendor_key;
      v_items := v_entry->'items';
    ELSE
      v_entry := jsonb_build_object(
        'vendor_id', vendor_id,
        'organization_id', rule.organization_id,
        'business_id', rule.business_id,
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
      'current_stock', COALESCE(rule.stock_quantity, 0)
    );

    v_items := v_items || v_item;
    v_entry := jsonb_set(v_entry, '{items}', v_items);
    vendor_orders := jsonb_set(vendor_orders, ARRAY[vendor_key], v_entry);
  END LOOP;

  -- Now create POs for each vendor group
  FOR vendor_key IN SELECT jsonb_object_keys(vendor_orders) LOOP
    v_entry := vendor_orders->vendor_key;

    -- Get next PO number
    SELECT get_next_po_number((v_entry->>'organization_id')::uuid) INTO po_number;

    -- Create PO
    INSERT INTO purchase_orders (
      organization_id, business_id, vendor_id, po_number, status,
      order_date, subtotal, tax_amount, total, notes
    ) VALUES (
      (v_entry->>'organization_id')::uuid,
      CASE WHEN v_entry->>'business_id' = 'null' THEN NULL ELSE (v_entry->>'business_id')::uuid END,
      (v_entry->>'vendor_id')::uuid,
      po_number,
      'draft',
      CURRENT_DATE,
      0, 0, 0,
      'Auto-generated by replenishment engine'
    ) RETURNING id INTO po_id;

    -- Insert line items and calculate totals
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

        -- Log the replenishment
        INSERT INTO replenishment_logs (
          organization_id, business_id, product_id, reorder_rule_id, purchase_order_id,
          trigger_type, current_stock, reorder_quantity, status
        ) VALUES (
          (v_entry->>'organization_id')::uuid,
          CASE WHEN v_entry->>'business_id' = 'null' THEN NULL ELSE (v_entry->>'business_id')::uuid END,
          (v_item->>'product_id')::uuid,
          (v_item->>'rule_id')::uuid,
          po_id,
          'auto',
          (v_item->>'current_stock')::integer,
          qty,
          'po_created'
        );
      END LOOP;

      -- Update PO totals
      UPDATE purchase_orders SET subtotal = total_subtotal, total = total_subtotal WHERE id = po_id;
    END;

    result := jsonb_set(result, '{created}', to_jsonb((result->>'created')::int + 1));
  END LOOP;

  RETURN result;
END;
$$;
