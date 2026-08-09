-- ============================================================
-- Phase 6 — Cost basis fidelity for sales returns
-- ============================================================

CREATE TABLE public.sales_return_cost_basis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  sales_return_id uuid NOT NULL REFERENCES public.sales_returns(id) ON DELETE CASCADE,
  sales_return_item_id uuid NOT NULL REFERENCES public.sales_return_items(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  quantity numeric NOT NULL,
  unit_cost numeric NOT NULL DEFAULT 0,
  total_value numeric NOT NULL DEFAULT 0,
  method text NOT NULL CHECK (method IN ('cost_layer','mixed','delivery_note','product_cost','none')),
  fallback_qty numeric NOT NULL DEFAULT 0,
  fallback_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_sales_return_cost_basis_item UNIQUE (sales_return_item_id)
);

CREATE INDEX idx_srcb_return ON public.sales_return_cost_basis(sales_return_id);
CREATE INDEX idx_srcb_business ON public.sales_return_cost_basis(business_id);

GRANT SELECT ON public.sales_return_cost_basis TO authenticated;
GRANT ALL ON public.sales_return_cost_basis TO service_role;
ALTER TABLE public.sales_return_cost_basis ENABLE ROW LEVEL SECURITY;

CREATE POLICY "srcb_select_business" ON public.sales_return_cost_basis
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE TABLE public.sales_return_cost_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  basis_id uuid NOT NULL REFERENCES public.sales_return_cost_basis(id) ON DELETE CASCADE,
  consumption_id uuid NOT NULL REFERENCES public.cost_layer_consumptions(id) ON DELETE RESTRICT,
  layer_id uuid NOT NULL,
  qty numeric NOT NULL CHECK (qty > 0),
  unit_cost numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_srca_basis ON public.sales_return_cost_allocations(basis_id);
CREATE INDEX idx_srca_consumption ON public.sales_return_cost_allocations(consumption_id);

GRANT SELECT ON public.sales_return_cost_allocations TO authenticated;
GRANT ALL ON public.sales_return_cost_allocations TO service_role;
ALTER TABLE public.sales_return_cost_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "srca_select_business" ON public.sales_return_cost_allocations
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE TRIGGER trg_srcb_updated_at
  BEFORE UPDATE ON public.sales_return_cost_basis
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ------------------------------------------------------------
-- Resolver: original outbound cost for a returned line.
-- Walks the cost_layer_consumptions produced by the delivery(ies)
-- that shipped the invoice, net of what earlier returns already
-- restored, and falls back to shipment cost then product cost.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_sales_return_line_cost(
  _business_id uuid,
  _invoice_id uuid,
  _product_id uuid,
  _qty numeric
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_need numeric := ABS(COALESCE(_qty, 0));
  v_take numeric;
  v_value numeric := 0;
  v_matched numeric := 0;
  v_allocs jsonb := '[]'::jsonb;
  v_c RECORD;
  v_fallback_cost numeric;
  v_method text;
  v_reason text;
BEGIN
  IF v_need <= 0 OR _product_id IS NULL THEN
    RETURN jsonb_build_object('unit_cost', 0, 'method', 'none', 'matched_qty', 0,
      'fallback_qty', 0, 'allocations', '[]'::jsonb, 'fallback_reason', 'no quantity');
  END IF;

  IF _invoice_id IS NOT NULL THEN
    FOR v_c IN
      SELECT clc.id, clc.layer_id, clc.unit_cost,
             clc.qty_consumed
               - COALESCE((SELECT SUM(a.qty) FROM public.sales_return_cost_allocations a
                            WHERE a.consumption_id = clc.id), 0) AS qty_available
        FROM public.cost_layer_consumptions clc
        JOIN public.stock_movements sm ON sm.id = clc.movement_id
       WHERE clc.business_id = _business_id
         AND clc.product_id = _product_id
         AND sm.reference_type = 'delivery_note'
         AND sm.reference_id IN (
           SELECT dn.id FROM public.delivery_notes dn
            WHERE COALESCE(dn.is_return, false) = false
              AND (dn.source_invoice_id = _invoice_id OR dn.spawned_invoice_id = _invoice_id))
       ORDER BY clc.consumed_at, clc.id
    LOOP
      EXIT WHEN v_need <= 0;
      IF COALESCE(v_c.qty_available, 0) <= 0 THEN CONTINUE; END IF;
      v_take := LEAST(v_c.qty_available, v_need);
      v_value := v_value + v_take * v_c.unit_cost;
      v_matched := v_matched + v_take;
      v_need := v_need - v_take;
      v_allocs := v_allocs || jsonb_build_array(jsonb_build_object(
        'consumption_id', v_c.id, 'layer_id', v_c.layer_id,
        'qty', v_take, 'unit_cost', v_c.unit_cost));
    END LOOP;
  END IF;

  IF v_need > 0.000001 THEN
    SELECT dni.cost_at_shipment INTO v_fallback_cost
      FROM public.delivery_note_items dni
      JOIN public.delivery_notes dn ON dn.id = dni.delivery_note_id
     WHERE dni.product_id = _product_id
       AND COALESCE(dn.is_return, false) = false
       AND (dn.source_invoice_id = _invoice_id OR dn.spawned_invoice_id = _invoice_id)
       AND dni.cost_at_shipment IS NOT NULL
     ORDER BY dn.delivery_date DESC
     LIMIT 1;

    IF v_fallback_cost IS NOT NULL THEN
      v_reason := 'outbound cost layers unavailable — used delivery cost_at_shipment';
      v_method := CASE WHEN v_matched > 0 THEN 'mixed' ELSE 'delivery_note' END;
    ELSE
      SELECT COALESCE(p.cost_price, 0) INTO v_fallback_cost
        FROM public.products p WHERE p.id = _product_id;
      v_fallback_cost := COALESCE(v_fallback_cost, 0);
      v_reason := 'no outbound cost history for this invoice line — used current product cost';
      v_method := CASE WHEN v_matched > 0 THEN 'mixed' ELSE 'product_cost' END;
    END IF;

    v_value := v_value + v_need * v_fallback_cost;
  ELSE
    v_method := 'cost_layer';
  END IF;

  RETURN jsonb_build_object(
    'unit_cost', CASE WHEN ABS(COALESCE(_qty,0)) > 0 THEN v_value / ABS(_qty) ELSE 0 END,
    'method', v_method,
    'matched_qty', v_matched,
    'fallback_qty', GREATEST(v_need, 0),
    'fallback_reason', v_reason,
    'allocations', v_allocs
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_sales_return_line_cost(uuid, uuid, uuid, numeric) FROM public;
GRANT EXECUTE ON FUNCTION public.resolve_sales_return_line_cost(uuid, uuid, uuid, numeric) TO authenticated, service_role;

-- ------------------------------------------------------------
-- Approval now values restored stock at the ORIGINAL outbound cost
-- and records the basis + allocations for every restored line.
-- ------------------------------------------------------------
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
  v_quarantine_loc uuid;
  v_stock_loc uuid;
  v_item RECORD;
  v_over RECORD;
  v_inventory_count integer := 0;
  v_unit_cost numeric;
  v_total_cogs numeric := 0;
  v_cogs_lines jsonb;
  v_cogs_je_id uuid;
  v_from_wms boolean := false;
  v_quarantined numeric := 0;
  v_basis jsonb;
  v_basis_id uuid;
  v_alloc jsonb;
BEGIN
  SELECT * INTO v_return FROM public.sales_returns WHERE id = p_return_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales return % not found', p_return_id; END IF;
  IF v_return.status <> 'pending' THEN
    RAISE EXCEPTION 'Only pending sales returns can be approved (current: %)', v_return.status;
  END IF;
  IF NOT public.user_can_access_business(p_user_id, v_return.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_return.business_id;
  END IF;

  v_from_wms := v_return.wms_return_order_id IS NOT NULL;

  IF NOT public.is_period_open(v_return.business_id, CURRENT_DATE) THEN
    RAISE EXCEPTION 'accounting period is closed for % — a sales return cannot be approved into a closed period',
      CURRENT_DATE USING ERRCODE = '22023';
  END IF;

  FOR v_over IN
    SELECT sri.invoice_item_id,
           SUM(ABS(COALESCE(sri.quantity, 0))) AS want,
           (SELECT COALESCE(ii.quantity, 0) FROM public.invoice_items ii
             WHERE ii.id = sri.invoice_item_id FOR UPDATE) AS invoiced,
           (SELECT COALESCE(SUM(ABS(COALESCE(o.quantity, 0))), 0)
              FROM public.sales_return_items o
              JOIN public.sales_returns osr ON osr.id = o.sales_return_id
             WHERE o.invoice_item_id = sri.invoice_item_id
               AND o.sales_return_id <> p_return_id
               AND osr.status <> 'rejected') AS already
      FROM public.sales_return_items sri
     WHERE sri.sales_return_id = p_return_id
       AND sri.invoice_item_id IS NOT NULL
     GROUP BY sri.invoice_item_id
  LOOP
    IF v_over.want + v_over.already > v_over.invoiced + 0.000001 THEN
      RAISE EXCEPTION
        'return exceeds the returnable quantity on invoice line % (invoiced %, already returned %, requested %)',
        v_over.invoice_item_id, v_over.invoiced, v_over.already, v_over.want
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

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

  -- WMS-sourced returns: the warehouse already moved and valued the goods.
  IF NOT v_from_wms THEN
    SELECT COUNT(*) INTO v_inventory_count
    FROM public.sales_return_items sri
    WHERE sri.sales_return_id = p_return_id AND sri.product_id IS NOT NULL;
  END IF;

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

    SELECT id INTO v_stock_loc FROM public.stock_locations
     WHERE warehouse_id = v_warehouse_id AND is_active AND location_type = 'internal'
     ORDER BY is_default DESC NULLS LAST, code LIMIT 1;

    SELECT id INTO v_quarantine_loc FROM public.stock_locations
     WHERE warehouse_id = v_warehouse_id AND is_active AND location_type = 'quarantine'
     ORDER BY is_default DESC NULLS LAST, code LIMIT 1;

    FOR v_item IN
      SELECT id, product_id, quantity, lot_number, serial_number,
             COALESCE(condition, 'good') AS condition
      FROM public.sales_return_items
      WHERE sales_return_id = p_return_id AND product_id IS NOT NULL
      ORDER BY sort_order NULLS LAST, id
    LOOP
      IF v_item.condition <> 'good' AND v_quarantine_loc IS NULL THEN
        RAISE EXCEPTION
          'returned line is marked % but warehouse has no active quarantine location — create one before approving',
          v_item.condition USING ERRCODE = '22023';
      END IF;

      -- Phase 6 — restore value at the ORIGINAL outbound cost layers.
      v_basis := public.resolve_sales_return_line_cost(
        v_return.business_id, v_return.invoice_id, v_item.product_id, v_item.quantity);
      v_unit_cost := COALESCE((v_basis->>'unit_cost')::numeric, 0);
      v_total_cogs := v_total_cogs + (ABS(v_item.quantity) * v_unit_cost);

      INSERT INTO public.sales_return_cost_basis(
        organization_id, business_id, sales_return_id, sales_return_item_id,
        product_id, quantity, unit_cost, total_value, method, fallback_qty, fallback_reason
      ) VALUES (
        v_return.organization_id, v_return.business_id, p_return_id, v_item.id,
        v_item.product_id, ABS(v_item.quantity), v_unit_cost,
        ABS(v_item.quantity) * v_unit_cost,
        COALESCE(v_basis->>'method', 'none'),
        COALESCE((v_basis->>'fallback_qty')::numeric, 0),
        NULLIF(v_basis->>'fallback_reason', '')
      )
      ON CONFLICT (sales_return_item_id) DO UPDATE
        SET unit_cost = EXCLUDED.unit_cost,
            total_value = EXCLUDED.total_value,
            method = EXCLUDED.method,
            fallback_qty = EXCLUDED.fallback_qty,
            fallback_reason = EXCLUDED.fallback_reason,
            updated_at = now()
      RETURNING id INTO v_basis_id;

      FOR v_alloc IN
        SELECT * FROM jsonb_array_elements(COALESCE(v_basis->'allocations', '[]'::jsonb))
      LOOP
        INSERT INTO public.sales_return_cost_allocations(
          organization_id, business_id, basis_id, consumption_id, layer_id, qty, unit_cost
        ) VALUES (
          v_return.organization_id, v_return.business_id, v_basis_id,
          (v_alloc->>'consumption_id')::uuid, (v_alloc->>'layer_id')::uuid,
          (v_alloc->>'qty')::numeric, (v_alloc->>'unit_cost')::numeric
        );
      END LOOP;

      IF v_item.condition <> 'good' THEN
        v_quarantined := v_quarantined + ABS(v_item.quantity);
      END IF;

      INSERT INTO public.stock_movements(
        organization_id, business_id, branch_id, product_id, movement_type,
        quantity, reference_type, reference_id, warehouse_id, notes,
        lot_number, serial_number, unit_cost, destination_location_id
      ) VALUES (
        v_return.organization_id, v_return.business_id, v_return.branch_id,
        v_item.product_id, 'return_in', v_item.quantity,
        'sales_return', p_return_id, v_warehouse_id,
        'Sales return ' || v_return.return_number || ' approved — ' ||
          CASE WHEN v_item.condition = 'good' THEN 'stock restored'
               ELSE 'received into quarantine (' || v_item.condition || ')' END ||
          ' at original cost basis (' || COALESCE(v_basis->>'method', 'none') || ')',
        v_item.lot_number, v_item.serial_number, v_unit_cost,
        CASE WHEN v_item.condition = 'good' THEN v_stock_loc ELSE v_quarantine_loc END
      );
    END LOOP;
  END IF;

  IF v_total_cogs > 0.005 THEN
    v_cogs_lines := public.resolve_sales_return_cogs_lines(
      p_return_id, v_return.organization_id, v_return.business_id,
      v_return.invoice_id, v_return.return_number);

    IF jsonb_array_length(COALESCE(v_cogs_lines, '[]'::jsonb)) > 0 THEN
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
        _lines := v_cogs_lines,
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
    'cogs_reversed', v_total_cogs,
    'from_wms', v_from_wms,
    'quarantined_qty', v_quarantined
  );
END;
$function$;