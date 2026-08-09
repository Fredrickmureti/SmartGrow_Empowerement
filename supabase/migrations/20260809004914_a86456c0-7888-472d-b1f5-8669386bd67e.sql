-- Cancellation must close the quantity ledger, not just flip the status.
CREATE OR REPLACE FUNCTION public.cancel_sales_order_atomic(
  p_so_id uuid,
  p_user_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_so            RECORD;
  v_released      jsonb;
  v_dn            RECORD;
  v_dn_cancelled  int := 0;
  v_active_wave   text;
  v_invoiced_cnt  int;
  v_cancelled_qty numeric;
BEGIN
  IF auth.uid() IS NULL AND p_user_id IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_so FROM public.sales_orders WHERE id = p_so_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order % not found', p_so_id USING ERRCODE = 'P0002';
  END IF;

  IF v_so.business_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_so.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_so.business_id USING ERRCODE = '42501';
  END IF;

  IF v_so.status = 'cancelled' THEN
    RETURN jsonb_build_object('success', true, 'already_cancelled', true, 'sales_order_id', p_so_id);
  END IF;

  IF v_so.status NOT IN ('draft','pending_approval','approved','rejected','confirmed','processing','partial') THEN
    RAISE EXCEPTION 'Cannot cancel sales order % in status % — fulfilled or invoiced orders must be credited, not cancelled.',
      v_so.so_number, v_so.status USING ERRCODE = '22023';
  END IF;

  IF v_so.converted_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'Sales order % is already invoiced — raise a credit note instead of cancelling.', v_so.so_number
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_invoiced_cnt
    FROM public.delivery_notes
   WHERE sales_order_id = p_so_id AND spawned_invoice_id IS NOT NULL;
  IF v_invoiced_cnt > 0 THEN
    RAISE EXCEPTION 'Sales order % has % invoice(s) raised from its deliveries — raise a credit note instead of cancelling.',
      v_so.so_number, v_invoiced_cnt USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.sales_order_items
     WHERE sales_order_id = p_so_id AND COALESCE(quantity_fulfilled,0) > 0
  ) THEN
    RAISE EXCEPTION 'Sales order % has delivered quantities — process a return before cancelling.', v_so.so_number
      USING ERRCODE = '22023';
  END IF;

  SELECT w.wave_number INTO v_active_wave
    FROM public.wms_pick_wave_lines wl
    JOIN public.wms_pick_waves w ON w.id = wl.wave_id
   WHERE wl.sales_order_id = p_so_id
     AND w.state NOT IN ('completed','cancelled')
   LIMIT 1;
  IF v_active_wave IS NOT NULL THEN
    RAISE EXCEPTION 'Sales order % is on active pick wave % — cancel or complete that wave first.',
      v_so.so_number, v_active_wave USING ERRCODE = '22023';
  END IF;

  v_released := public.release_sales_order_reservations_atomic(p_so_id);

  PERFORM public._wms_crossdock_break_for_demand_doc(
    p_so_id, 'sales order ' || v_so.so_number || ' cancelled');

  FOR v_dn IN
    SELECT id FROM public.delivery_notes
     WHERE sales_order_id = p_so_id
       AND status IN ('pending','ready_to_dispatch')
  LOOP
    PERFORM public.cancel_delivery_atomic(
      v_dn.id, p_user_id,
      'Sales order ' || v_so.so_number || ' cancelled');
    v_dn_cancelled := v_dn_cancelled + 1;
  END LOOP;

  UPDATE public.backorders
     SET status = 'cancelled'
   WHERE sales_order_id = p_so_id
     AND status IN ('pending','allocated');

  -- Close the quantity ledger so the line stops reporting open balances.
  PERFORM public._so_write_cancelled_quantities(p_so_id);
  SELECT COALESCE(SUM(quantity_cancelled), 0) INTO v_cancelled_qty
    FROM public.sales_order_items WHERE sales_order_id = p_so_id;

  UPDATE public.sales_orders
     SET status = 'cancelled', updated_at = now()
   WHERE id = p_so_id;

  INSERT INTO public.audit_logs (
    organization_id, business_id, user_id, action,
    entity_type, entity_id, entity_name, changes_summary, new_values
  ) VALUES (
    v_so.organization_id, v_so.business_id, p_user_id, 'cancel',
    'sales_order', p_so_id, v_so.so_number,
    'Sales order cancelled' || COALESCE(' — ' || NULLIF(btrim(p_reason), ''), ''),
    jsonb_build_object(
      'from_status', v_so.status,
      'to_status', 'cancelled',
      'reason', NULLIF(btrim(p_reason), ''),
      'reservations_released', v_released->'released',
      'delivery_notes_cancelled', v_dn_cancelled,
      'quantity_cancelled', v_cancelled_qty
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'sales_order_id', p_so_id,
    'so_number', v_so.so_number,
    'reservations_released', COALESCE((v_released->>'released')::int, 0),
    'delivery_notes_cancelled', v_dn_cancelled,
    'quantity_cancelled', v_cancelled_qty
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.cancel_sales_order_atomic(uuid, uuid, text) TO authenticated;

-- Lead conversion: crm_leads has no branch_id column, so resolve the branch
-- from the business directly instead of probing the row type.
CREATE OR REPLACE FUNCTION public.convert_lead_to_sales_order(p_lead_id uuid, p_project_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(id uuid, so_number text, was_existing boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_lead     public.crm_leads%ROWTYPE;
  v_business public.businesses%ROWTYPE;
  v_existing_id uuid;
  v_existing_no text;
  v_new_id uuid;
  v_new_no  text;
  v_contact_id uuid;
  v_currency text;
  v_branch uuid;
  v_subtotal numeric := 0;
  v_tax numeric := 0;
  v_rate numeric;
BEGIN
  SELECT * INTO v_lead FROM public.crm_leads WHERE crm_leads.id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead % not found', p_lead_id USING ERRCODE = 'P0002';
  END IF;

  SELECT so.id, so.so_number INTO v_existing_id, v_existing_no
    FROM public.sales_orders so
   WHERE so.source_lead_id = p_lead_id
   ORDER BY so.created_at ASC
   LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    IF p_project_id IS NOT NULL THEN
      UPDATE public.sales_orders
         SET project_id = COALESCE(project_id, p_project_id)
       WHERE sales_orders.id = v_existing_id;
    END IF;
    RETURN QUERY SELECT v_existing_id, v_existing_no, true;
    RETURN;
  END IF;

  IF v_lead.business_id IS NULL THEN
    RAISE EXCEPTION 'Lead % has no business assigned; assign one before converting to a sales order', p_lead_id
      USING ERRCODE = '22023';
  END IF;

  v_contact_id := v_lead.contact_id;
  IF v_contact_id IS NULL THEN
    SELECT cc.id INTO v_contact_id FROM public.convert_lead_to_contact(p_lead_id) cc;
  END IF;

  SELECT * INTO v_business FROM public.businesses WHERE businesses.id = v_lead.business_id;
  v_currency := COALESCE(v_business.base_currency, 'USD');

  SELECT br.id INTO v_branch
    FROM public.branches br
   WHERE br.business_id = v_lead.business_id
     AND COALESCE(br.is_active, true) = true
   ORDER BY (br.code = 'HQ') DESC NULLS LAST, br.created_at ASC
   LIMIT 1;

  SELECT COALESCE(SUM(li.line_total), 0),
         COALESCE(SUM(COALESCE(li.tax_amount,
                      round(COALESCE(li.line_total,0) * COALESCE(li.tax_rate,0) / 100.0, 2))), 0)
    INTO v_subtotal, v_tax
    FROM public.crm_lead_items li WHERE li.lead_id = p_lead_id;

  IF v_subtotal = 0 THEN
    v_subtotal := COALESCE(v_lead.expected_revenue, 0);
    v_tax := 0;
  END IF;

  v_new_no := public.get_next_so_number(v_lead.organization_id, v_lead.business_id, v_branch);
  v_rate := public.resolve_sales_exchange_rate(
    v_lead.organization_id, v_lead.business_id, v_currency, CURRENT_DATE);

  INSERT INTO public.sales_orders (
    organization_id, business_id, branch_id, so_number, contact_id, status,
    order_date, expected_date, subtotal, tax_amount, discount_amount, total,
    notes, currency, exchange_rate, created_by, salesperson_id,
    source_lead_id, project_id
  ) VALUES (
    v_lead.organization_id, v_lead.business_id, v_branch,
    v_new_no, v_contact_id, 'draft',
    CURRENT_DATE,
    COALESCE(v_lead.expected_close_date, CURRENT_DATE + INTERVAL '14 days'),
    round(v_subtotal, 2), round(v_tax, 2), 0, round(v_subtotal + v_tax, 2),
    NULLIF(v_lead.description, ''),
    v_currency, v_rate, auth.uid(),
    COALESCE(v_lead.assigned_to, auth.uid()),
    p_lead_id, p_project_id
  ) RETURNING sales_orders.id, sales_orders.so_number INTO v_new_id, v_new_no;

  INSERT INTO public.sales_order_items (
    sales_order_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order, project_id
  )
  SELECT v_new_id, li.product_id, li.description, li.quantity, li.unit_price,
         COALESCE(li.tax_rate, 0),
         COALESCE(li.tax_amount,
                  round(COALESCE(li.line_total,0) * COALESCE(li.tax_rate,0) / 100.0, 2)),
         COALESCE(li.discount_percent, 0), li.line_total,
         COALESCE(li.sort_order, 0), p_project_id
    FROM public.crm_lead_items li
   WHERE li.lead_id = p_lead_id;

  INSERT INTO public.crm_activities (
    organization_id, lead_id, activity_type, summary, is_done, completed_at, created_by
  ) VALUES (
    v_lead.organization_id, p_lead_id, 'system',
    'Sales order created: ' || v_new_no, true, now(), auth.uid()
  );

  RETURN QUERY SELECT v_new_id, v_new_no, false;
END;
$function$;
