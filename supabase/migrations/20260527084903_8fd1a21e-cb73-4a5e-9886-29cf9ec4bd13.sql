
-- F-5: get_invoice_delivery_status — use real FK link instead of fragile LIKE
CREATE OR REPLACE FUNCTION public.get_invoice_delivery_status(p_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inv record;
  v_stockable_count integer := 0;
  v_dn record;
BEGIN
  SELECT id, organization_id, business_id, branch_id, invoice_number, status, source_sales_order_id
    INTO v_inv
    FROM public.invoices
   WHERE id = p_invoice_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT COUNT(*) INTO v_stockable_count
    FROM public.invoice_items ii
    JOIN public.products p ON p.id = ii.product_id
   WHERE ii.invoice_id = p_invoice_id
     AND COALESCE(p.track_inventory, true) = true
     AND p.type = 'product'
     AND COALESCE(ii.quantity, 0) > 0;

  SELECT dn.id, dn.delivery_number, dn.status, dn.delivered_at
    INTO v_dn
    FROM public.delivery_notes dn
   WHERE dn.organization_id = v_inv.organization_id
     AND dn.business_id = v_inv.business_id
     AND (
       dn.source_invoice_id = p_invoice_id
       OR (v_inv.source_sales_order_id IS NOT NULL AND dn.sales_order_id = v_inv.source_sales_order_id)
       OR (dn.notes IS NOT NULL AND dn.notes LIKE '%[auto-from-invoice:' || p_invoice_id::text || ']%')
     )
   ORDER BY dn.created_at DESC
   LIMIT 1;

  RETURN jsonb_build_object(
    'found', true,
    'invoice_id', p_invoice_id,
    'invoice_status', v_inv.status,
    'has_stockable_lines', v_stockable_count > 0,
    'stockable_line_count', v_stockable_count,
    'sales_order_id', v_inv.source_sales_order_id,
    'delivery_note_id', v_dn.id,
    'delivery_number', v_dn.delivery_number,
    'delivery_status', v_dn.status,
    'delivered_at', v_dn.delivered_at
  );
END;
$function$;

-- F-6: confirm_sales_order_atomic — widen gate to draft|approved
CREATE OR REPLACE FUNCTION public.confirm_sales_order_atomic(p_so_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_so          RECORD;
  v_warehouse_id uuid;
  v_item        RECORD;
  v_res         jsonb;
  v_reservations_created int := 0;
  v_reservations_skipped int := 0;
  v_skip_reasons jsonb := '[]'::jsonb;
BEGIN
  SELECT id, organization_id, business_id, branch_id, status, so_number
    INTO v_so
    FROM sales_orders
   WHERE id = p_so_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sales order not found');
  END IF;

  IF v_so.status NOT IN ('draft','approved') THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Only draft or approved sales orders can be confirmed. Current status: ' || v_so.status);
  END IF;

  SELECT id INTO v_warehouse_id
    FROM warehouses
   WHERE organization_id = v_so.organization_id
     AND business_id = v_so.business_id
     AND COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = COALESCE(v_so.branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND is_active = true
     AND COALESCE(is_in_transit, false) = false
   ORDER BY is_default DESC NULLS LAST
   LIMIT 1;

  IF v_warehouse_id IS NOT NULL THEN
    FOR v_item IN
      SELECT soi.product_id, soi.quantity, soi.quantity_fulfilled,
             p.track_inventory
        FROM sales_order_items soi
        LEFT JOIN products p ON p.id = soi.product_id
       WHERE soi.sales_order_id = p_so_id
         AND soi.product_id IS NOT NULL
         AND COALESCE(p.track_inventory, false) = true
         AND (soi.quantity - COALESCE(soi.quantity_fulfilled, 0)) > 0
    LOOP
      v_res := public.create_stock_reservation(
        v_so.organization_id,
        v_item.product_id,
        v_warehouse_id,
        v_item.quantity - COALESCE(v_item.quantity_fulfilled, 0),
        'sales_order',
        p_so_id,
        NULL,
        NULL
      );

      IF COALESCE((v_res->>'success')::boolean, false) THEN
        v_reservations_created := v_reservations_created + 1;
      ELSE
        v_reservations_skipped := v_reservations_skipped + 1;
        v_skip_reasons := v_skip_reasons || jsonb_build_object(
          'product_id', v_item.product_id,
          'reason', COALESCE(v_res->>'error', 'unknown'),
          'available', v_res->'available'
        );
      END IF;
    END LOOP;
  END IF;

  UPDATE sales_orders
     SET status = 'confirmed',
         updated_at = now()
   WHERE id = p_so_id;

  RETURN jsonb_build_object(
    'success', true,
    'so_id', p_so_id,
    'reservations_created', v_reservations_created,
    'reservations_skipped', v_reservations_skipped,
    'skip_reasons', v_skip_reasons,
    'warehouse_resolved', v_warehouse_id IS NOT NULL
  );
END;
$function$;

-- F-4: trg_sales_order_to_revenue — stop posting once invoice trigger takes over
CREATE OR REPLACE FUNCTION public.trg_sales_order_to_revenue()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_has_line_proj boolean;
  v_active boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.project_revenue_entries
      WHERE source_type='sales_order' AND source_id = OLD.id;
    RETURN OLD;
  END IF;

  -- Forecast/commitment posting only. Once status reaches 'invoiced', the
  -- invoice-side trigger (trg_invoices_revenue) owns realized revenue and
  -- we MUST clear our forecast rows to avoid double-counting project P&L.
  v_active := NEW.status::text IN ('confirmed','partial','delivered','done');

  DELETE FROM public.project_revenue_entries
    WHERE source_type='sales_order' AND source_id = NEW.id;

  IF NOT v_active THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.sales_order_items WHERE sales_order_id = NEW.id AND project_id IS NOT NULL
  ) INTO v_has_line_proj;

  IF v_has_line_proj THEN
    INSERT INTO public.project_revenue_entries
      (project_id, organization_id, business_id, source_type, source_id,
       milestone_id, amount, currency, posted_at, description)
    SELECT
      soi.project_id,
      NEW.organization_id,
      NEW.business_id,
      'sales_order',
      NEW.id,
      NULL,
      SUM(COALESCE(soi.line_total,0)),
      NEW.currency,
      NEW.created_at,
      'Sales order (line-tagged, forecast)'
    FROM public.sales_order_items soi
    WHERE soi.sales_order_id = NEW.id
      AND soi.project_id IS NOT NULL
    GROUP BY soi.project_id;
    RETURN NEW;
  END IF;

  IF NEW.project_id IS NOT NULL THEN
    PERFORM public.upsert_project_revenue(
      NEW.project_id, NEW.organization_id, NEW.business_id,
      'sales_order', NEW.id, NULL,
      COALESCE(NEW.total, NEW.subtotal, 0), NEW.currency, NEW.created_at,
      'Sales order (commitment, forecast)'
    );
  END IF;
  RETURN NEW;
END;
$function$;

-- F-8: convert_estimate_to_so_atomic — honor estimate.valid_until for expected_date
CREATE OR REPLACE FUNCTION public.convert_estimate_to_so_atomic(p_estimate_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_est RECORD;
  v_so_number text;
  v_so_id uuid;
  v_expected date;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_est
  FROM public.estimates
  WHERE id = p_estimate_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Estimate % not found', p_estimate_id;
  END IF;

  IF v_est.status = 'converted' THEN
    RAISE EXCEPTION 'Estimate % already converted', v_est.estimate_number;
  END IF;
  IF v_est.status NOT IN ('draft','sent','viewed','accepted','approved') THEN
    RAISE EXCEPTION 'Cannot convert estimate in status %', v_est.status;
  END IF;

  IF v_est.business_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_est.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_est.business_id USING ERRCODE = '42501';
  END IF;

  SELECT public.get_next_so_number(v_est.organization_id) INTO v_so_number;

  -- Honor the customer-facing validity window when present; never schedule
  -- expected_date in the past.
  v_expected := GREATEST(
    CURRENT_DATE + INTERVAL '14 days',
    COALESCE(v_est.valid_until, CURRENT_DATE + INTERVAL '14 days')
  )::date;

  INSERT INTO public.sales_orders(
    organization_id, business_id, branch_id, contact_id,
    so_number, status, order_date, expected_date,
    subtotal, tax_amount, discount_amount, total, currency,
    notes, created_by, source_estimate_id
  ) VALUES (
    v_est.organization_id, v_est.business_id, v_est.branch_id, v_est.contact_id,
    v_so_number, 'draft', CURRENT_DATE, v_expected,
    v_est.subtotal, v_est.tax_amount, COALESCE(v_est.discount_amount,0), v_est.total, v_est.currency,
    v_est.notes, p_user_id, p_estimate_id
  )
  RETURNING id INTO v_so_id;

  INSERT INTO public.sales_order_items(
    sales_order_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order
  )
  SELECT
    v_so_id, ei.product_id, ei.description, ei.quantity, ei.unit_price,
    COALESCE(ei.tax_rate,0), COALESCE(ei.tax_amount,0),
    COALESCE(ei.discount_percent,0), ei.line_total, ei.sort_order
  FROM public.estimate_items ei
  WHERE ei.estimate_id = p_estimate_id;

  UPDATE public.estimates
  SET status = 'converted',
      updated_at = now()
  WHERE id = p_estimate_id;

  RETURN jsonb_build_object(
    'success', true,
    'sales_order_id', v_so_id,
    'so_number', v_so_number
  );
END;
$function$;

-- F-9: get_document_lineage — read-only RPC powering the lineage strip UI
CREATE OR REPLACE FUNCTION public.get_document_lineage(p_doc_type text, p_doc_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_estimate_id uuid;
  v_proforma_id uuid;
  v_so_id uuid;
  v_invoice_id uuid;
  v_delivery_id uuid;
  v_org uuid;
  v_business uuid;
  v_est jsonb;
  v_prof jsonb;
  v_so jsonb;
  v_inv jsonb;
  v_dn jsonb;
BEGIN
  IF p_doc_type = 'estimate' THEN
    v_estimate_id := p_doc_id;
    SELECT organization_id, business_id INTO v_org, v_business
      FROM public.estimates WHERE id = v_estimate_id;
  ELSIF p_doc_type = 'proforma_invoice' THEN
    v_proforma_id := p_doc_id;
    SELECT organization_id, business_id, source_estimate_id INTO v_org, v_business, v_estimate_id
      FROM public.proforma_invoices WHERE id = v_proforma_id;
  ELSIF p_doc_type = 'sales_order' THEN
    v_so_id := p_doc_id;
    SELECT organization_id, business_id, source_estimate_id, source_proforma_invoice_id
      INTO v_org, v_business, v_estimate_id, v_proforma_id
      FROM public.sales_orders WHERE id = v_so_id;
  ELSIF p_doc_type = 'invoice' THEN
    v_invoice_id := p_doc_id;
    SELECT organization_id, business_id, source_sales_order_id, source_proforma_invoice_id
      INTO v_org, v_business, v_so_id, v_proforma_id
      FROM public.invoices WHERE id = v_invoice_id;
    IF v_so_id IS NOT NULL THEN
      SELECT source_estimate_id INTO v_estimate_id FROM public.sales_orders WHERE id = v_so_id;
    END IF;
  ELSIF p_doc_type = 'delivery_note' THEN
    v_delivery_id := p_doc_id;
    SELECT organization_id, business_id, sales_order_id, source_invoice_id
      INTO v_org, v_business, v_so_id, v_invoice_id
      FROM public.delivery_notes WHERE id = v_delivery_id;
    IF v_so_id IS NOT NULL THEN
      SELECT source_estimate_id, source_proforma_invoice_id
        INTO v_estimate_id, v_proforma_id
        FROM public.sales_orders WHERE id = v_so_id;
    END IF;
  ELSE
    RETURN jsonb_build_object('error', 'unknown doc_type');
  END IF;

  -- Tenant guard
  IF v_business IS NULL OR NOT public.user_can_access_business(auth.uid(), v_business) THEN
    RETURN jsonb_build_object('error', 'access denied');
  END IF;

  -- Forward-resolve missing siblings from whichever anchor we have
  IF v_so_id IS NULL AND v_estimate_id IS NOT NULL THEN
    SELECT id INTO v_so_id FROM public.sales_orders
      WHERE source_estimate_id = v_estimate_id ORDER BY created_at LIMIT 1;
  END IF;
  IF v_proforma_id IS NULL AND v_estimate_id IS NOT NULL THEN
    SELECT id INTO v_proforma_id FROM public.proforma_invoices
      WHERE source_estimate_id = v_estimate_id ORDER BY created_at LIMIT 1;
  END IF;
  IF v_invoice_id IS NULL AND v_so_id IS NOT NULL THEN
    SELECT id INTO v_invoice_id FROM public.invoices
      WHERE source_sales_order_id = v_so_id ORDER BY created_at LIMIT 1;
  END IF;
  IF v_delivery_id IS NULL AND v_so_id IS NOT NULL THEN
    SELECT id INTO v_delivery_id FROM public.delivery_notes
      WHERE sales_order_id = v_so_id ORDER BY created_at LIMIT 1;
  END IF;

  IF v_estimate_id IS NOT NULL THEN
    SELECT jsonb_build_object('id', id, 'number', estimate_number, 'status', status, 'date', issue_date)
      INTO v_est FROM public.estimates WHERE id = v_estimate_id;
  END IF;
  IF v_proforma_id IS NOT NULL THEN
    SELECT jsonb_build_object('id', id, 'number', proforma_number, 'status', status, 'date', issue_date)
      INTO v_prof FROM public.proforma_invoices WHERE id = v_proforma_id;
  END IF;
  IF v_so_id IS NOT NULL THEN
    SELECT jsonb_build_object('id', id, 'number', so_number, 'status', status, 'date', order_date)
      INTO v_so FROM public.sales_orders WHERE id = v_so_id;
  END IF;
  IF v_invoice_id IS NOT NULL THEN
    SELECT jsonb_build_object('id', id, 'number', invoice_number, 'status', status, 'date', issue_date)
      INTO v_inv FROM public.invoices WHERE id = v_invoice_id;
  END IF;
  IF v_delivery_id IS NOT NULL THEN
    SELECT jsonb_build_object('id', id, 'number', delivery_number, 'status', status, 'date', delivery_date)
      INTO v_dn FROM public.delivery_notes WHERE id = v_delivery_id;
  END IF;

  RETURN jsonb_build_object(
    'estimate', v_est,
    'proforma_invoice', v_prof,
    'sales_order', v_so,
    'delivery_note', v_dn,
    'invoice', v_inv
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_document_lineage(text, uuid) TO authenticated;
