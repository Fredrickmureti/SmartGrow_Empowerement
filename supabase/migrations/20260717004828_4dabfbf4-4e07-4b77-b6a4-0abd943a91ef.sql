-- Phase G+ · Product-recall RPC.
-- Quarantines remaining on-hand for a lot across every warehouse that still
-- holds it, records the recall header, and returns a downstream-customer
-- manifest so operators can execute a physical recall.
--
-- Depends on tables that already exist:
--   product_recalls, product_recall_items, lot_quarantine, stock_lots,
--   stock_movements, invoice_items, invoices, contacts.

CREATE OR REPLACE FUNCTION public.recall_lot(
  p_business_id  uuid,
  p_product_id   uuid,
  p_lot_number   text,
  p_reason       text,
  p_severity     text DEFAULT 'medium',
  p_reference    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id       uuid;
  v_lot          public.stock_lots%ROWTYPE;
  v_recall_id    uuid;
  v_recall_ref   text;
  v_user_id      uuid := auth.uid();
  v_wh_row       record;
  v_total        numeric := 0;
  v_wh_count     int := 0;
  v_customers    jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  IF NOT public.user_can_access_business(v_user_id, p_business_id) THEN
    RAISE EXCEPTION 'Forbidden: no access to business %', p_business_id
      USING ERRCODE = '42501';
  END IF;

  IF p_lot_number IS NULL OR btrim(p_lot_number) = '' THEN
    RAISE EXCEPTION 'lot_number is required' USING ERRCODE = '22004';
  END IF;

  -- Anchor the lot master (also verifies caller-visible existence).
  SELECT * INTO v_lot
  FROM public.stock_lots
  WHERE business_id = p_business_id
    AND product_id  = p_product_id
    AND lot_number  = p_lot_number
  LIMIT 1;

  IF v_lot.id IS NULL THEN
    RAISE EXCEPTION 'Lot % not found for product % in business %',
      p_lot_number, p_product_id, p_business_id
      USING ERRCODE = 'P0002';
  END IF;

  v_org_id := v_lot.organization_id;
  v_recall_ref := COALESCE(
    p_reference,
    'RCL-' || to_char(now(), 'YYYYMMDD-HH24MISS') || '-' ||
      substr(replace(v_lot.id::text, '-', ''), 1, 6)
  );

  INSERT INTO public.product_recalls (
    organization_id, business_id, product_id,
    recall_reference, reason, severity, status,
    recall_date, initiated_by, notes
  ) VALUES (
    v_org_id, p_business_id, p_product_id,
    v_recall_ref, p_reason, COALESCE(p_severity, 'medium'), 'open',
    CURRENT_DATE, v_user_id, 'Lot ' || v_lot.lot_number
  )
  RETURNING id INTO v_recall_id;

  -- Quarantine remaining on-hand per warehouse. Net inbound − outbound
  -- for this (business, product, lot) partitioned by warehouse.
  FOR v_wh_row IN
    SELECT
      sm.warehouse_id,
      SUM(
        CASE
          WHEN sm.movement_type IN (
            'purchase_in','transfer_in','adjustment_in','return_in','opening_balance'
          ) THEN sm.quantity
          ELSE -sm.quantity
        END
      ) AS net_qty
    FROM public.stock_movements sm
    WHERE sm.business_id = p_business_id
      AND sm.product_id  = p_product_id
      AND sm.lot_number  = p_lot_number
      AND sm.warehouse_id IS NOT NULL
    GROUP BY sm.warehouse_id
    HAVING SUM(
      CASE
        WHEN sm.movement_type IN (
          'purchase_in','transfer_in','adjustment_in','return_in','opening_balance'
        ) THEN sm.quantity
        ELSE -sm.quantity
      END
    ) > 0
  LOOP
    INSERT INTO public.lot_quarantine (
      organization_id, business_id, lot_id, warehouse_id,
      status, reason, quarantine_date, authorised_by, recall_id, notes
    ) VALUES (
      v_org_id, p_business_id, v_lot.id, v_wh_row.warehouse_id,
      'quarantined', p_reason, now(), v_user_id, v_recall_id,
      'Auto-quarantined by recall_lot'
    );

    INSERT INTO public.product_recall_items (
      recall_id, lot_id, warehouse_id,
      quantity_quarantined, quantity_returned, quantity_destroyed
    ) VALUES (
      v_recall_id, v_lot.id, v_wh_row.warehouse_id,
      v_wh_row.net_qty, 0, 0
    );

    v_total := v_total + v_wh_row.net_qty;
    v_wh_count := v_wh_count + 1;
  END LOOP;

  -- Downstream customer manifest: outbound movements → invoice_items →
  -- invoices → contacts. Groups by customer with per-invoice detail.
  SELECT COALESCE(
    jsonb_agg(row_to_json(t.*) ORDER BY t.customer_name),
    '[]'::jsonb
  )
  INTO v_customers
  FROM (
    SELECT
      inv.contact_id                              AS customer_id,
      COALESCE(c.name, '(unknown)')               AS customer_name,
      c.email                                     AS customer_email,
      c.phone                                     AS customer_phone,
      COUNT(DISTINCT inv.id)                      AS invoice_count,
      SUM(sm.quantity)                            AS units_sold,
      jsonb_agg(DISTINCT jsonb_build_object(
        'invoice_id',     inv.id,
        'invoice_number', inv.invoice_number,
        'invoice_date',   inv.issue_date
      ))                                          AS invoices
    FROM public.stock_movements sm
    JOIN public.invoice_items ii
      ON ii.id = sm.reference_id
     AND sm.reference_type = 'invoice_item'
    JOIN public.invoices inv ON inv.id = ii.invoice_id
    LEFT JOIN public.contacts c ON c.id = inv.contact_id
    WHERE sm.business_id = p_business_id
      AND sm.product_id  = p_product_id
      AND sm.lot_number  = p_lot_number
      AND sm.movement_type IN ('sale_out','delivery_out')
    GROUP BY inv.contact_id, c.name, c.email, c.phone
  ) t;

  RETURN jsonb_build_object(
    'success',            true,
    'recall_id',          v_recall_id,
    'recall_reference',   v_recall_ref,
    'quarantined_units',  v_total,
    'warehouses_affected',v_wh_count,
    'downstream_customers', v_customers
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.recall_lot(uuid, uuid, text, text, text, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.recall_lot(uuid, uuid, text, text, text, text) FROM anon;
