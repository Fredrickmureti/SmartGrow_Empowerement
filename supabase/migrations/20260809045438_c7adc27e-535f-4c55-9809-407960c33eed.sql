-- ============================================================
-- Returns convergence Phase 1 + 2
-- ============================================================

-- ---------- Phase 1.1: provenance from the WMS return engine ----------
ALTER TABLE public.sales_returns
  ADD COLUMN IF NOT EXISTS wms_return_order_id uuid REFERENCES public.wms_return_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sales_returns_wms_return_order
  ON public.sales_returns(wms_return_order_id) WHERE wms_return_order_id IS NOT NULL;

-- Backfill existing links.
UPDATE public.sales_returns sr
   SET wms_return_order_id = wro.id
  FROM public.wms_return_orders wro
 WHERE wro.finance_doc_type = 'sales_return'
   AND wro.finance_doc_id = sr.id
   AND sr.wms_return_order_id IS NULL;

-- Keep the link stamped for every future WMS-raised sales return, without
-- re-authoring wms_create_return_finance_doc / wms_link_return_finance.
CREATE OR REPLACE FUNCTION public._stamp_sales_return_wms_origin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.finance_doc_type = 'sales_return' AND NEW.finance_doc_id IS NOT NULL THEN
    UPDATE public.sales_returns
       SET wms_return_order_id = NEW.id
     WHERE id = NEW.finance_doc_id
       AND wms_return_order_id IS DISTINCT FROM NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_stamp_sales_return_wms_origin ON public.wms_return_orders;
CREATE TRIGGER trg_stamp_sales_return_wms_origin
AFTER INSERT OR UPDATE OF finance_doc_id ON public.wms_return_orders
FOR EACH ROW EXECUTE FUNCTION public._stamp_sales_return_wms_origin();

-- ---------- Phase 2.1: the returnable-quantity ledger ----------
CREATE OR REPLACE VIEW public.v_sales_returnable_qty
WITH (security_invoker = true) AS
SELECT
  ii.id                              AS invoice_item_id,
  ii.invoice_id,
  i.organization_id,
  i.business_id,
  i.contact_id,
  ii.product_id,
  COALESCE(ii.quantity, 0)           AS invoiced_qty,
  COALESCE(r.returned_qty, 0)        AS returned_qty,
  GREATEST(COALESCE(ii.quantity, 0) - COALESCE(r.returned_qty, 0), 0) AS returnable_qty
FROM public.invoice_items ii
JOIN public.invoices i ON i.id = ii.invoice_id
LEFT JOIN LATERAL (
  SELECT SUM(ABS(COALESCE(sri.quantity, 0))) AS returned_qty
    FROM public.sales_return_items sri
    JOIN public.sales_returns sr ON sr.id = sri.sales_return_id
   WHERE sri.invoice_item_id = ii.id
     AND sr.status <> 'rejected'
) r ON true;

GRANT SELECT ON public.v_sales_returnable_qty TO authenticated;
GRANT ALL    ON public.v_sales_returnable_qty TO service_role;

-- ---------- Phase 2.2: enforce it on every writer ----------
CREATE OR REPLACE FUNCTION public.enforce_sales_return_qty_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_invoiced numeric;
  v_already  numeric;
  v_status   text;
BEGIN
  IF NEW.invoice_item_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT status INTO v_status FROM public.sales_returns WHERE id = NEW.sales_return_id;
  IF v_status = 'rejected' THEN
    RETURN NEW;
  END IF;

  -- Lock the source line so two concurrent returns cannot jointly over-return.
  SELECT COALESCE(quantity, 0) INTO v_invoiced
    FROM public.invoice_items WHERE id = NEW.invoice_item_id FOR UPDATE;

  IF v_invoiced IS NULL THEN
    RAISE EXCEPTION 'invoice line % not found', NEW.invoice_item_id USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(SUM(ABS(COALESCE(sri.quantity, 0))), 0) INTO v_already
    FROM public.sales_return_items sri
    JOIN public.sales_returns sr ON sr.id = sri.sales_return_id
   WHERE sri.invoice_item_id = NEW.invoice_item_id
     AND sr.status <> 'rejected'
     AND sri.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

  IF v_already + ABS(COALESCE(NEW.quantity, 0)) > v_invoiced + 0.000001 THEN
    RAISE EXCEPTION
      'cannot return % unit(s): invoice line has % invoiced and % already returned (% returnable)',
      ABS(COALESCE(NEW.quantity, 0)), v_invoiced, v_already, GREATEST(v_invoiced - v_already, 0)
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_sales_return_qty_ledger ON public.sales_return_items;
CREATE TRIGGER trg_enforce_sales_return_qty_ledger
BEFORE INSERT OR UPDATE OF quantity, invoice_item_id ON public.sales_return_items
FOR EACH ROW EXECUTE FUNCTION public.enforce_sales_return_qty_ledger();

-- ---------- Phase 1.2 + 1.3 + 2.3: approval ----------
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

  -- Phase 1.3 — a closed period must refuse the approval outright. Previously the
  -- COGS entry was silently skipped while stock still moved, drifting the ledger.
  IF NOT public.is_period_open(v_return.business_id, CURRENT_DATE) THEN
    RAISE EXCEPTION 'accounting period is closed for % — a sales return cannot be approved into a closed period',
      CURRENT_DATE USING ERRCODE = '22023';
  END IF;

  -- Phase 2.3 — re-check the quantity ledger under lock at approval time.
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

  -- Phase 1.1 — the WMS return engine has already received, inspected,
  -- dispositioned and moved these goods. Moving them again here double-counts
  -- inventory and turns scrapped/quarantined units into sellable stock.
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
      SELECT product_id, quantity, lot_number, serial_number, COALESCE(condition, 'good') AS condition
      FROM public.sales_return_items
      WHERE sales_return_id = p_return_id AND product_id IS NOT NULL
    LOOP
      -- Phase 1.2 — damaged / defective goods must not re-enter sellable stock.
      IF v_item.condition <> 'good' AND v_quarantine_loc IS NULL THEN
        RAISE EXCEPTION
          'returned line is marked % but warehouse has no active quarantine location — create one before approving',
          v_item.condition USING ERRCODE = '22023';
      END IF;

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
               ELSE 'received into quarantine (' || v_item.condition || ')' END,
        v_item.lot_number, v_item.serial_number, v_unit_cost,
        CASE WHEN v_item.condition = 'good' THEN v_stock_loc ELSE v_quarantine_loc END
      );
    END LOOP;
  END IF;

  -- Inventory / COGS reversal on the ADR 0122 ladder: the accounts a return
  -- credits must be the accounts the delivery debited, per product.
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
    'stock_moved', (v_inventory_count > 0),
    'quarantined_qty', v_quarantined,
    'from_wms_return', v_from_wms
  );
END;
$function$;