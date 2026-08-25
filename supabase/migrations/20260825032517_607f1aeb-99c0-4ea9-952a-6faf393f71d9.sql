-- crm_lead_items stores a tax *rate* per line, never a stored tax_amount column.
-- Both the header roll-up and the line copy referenced li.tax_amount, so every
-- lead -> sales order conversion aborted with "column li.tax_amount does not
-- exist". Derive line tax from the rate instead.
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
  -- D2: authorize against the LEAD's business, not a browser-supplied id.
  v_lead := public._crm_assert_lead_access(p_lead_id, 'create');

  SELECT * INTO v_lead FROM public.crm_leads WHERE crm_leads.id = p_lead_id FOR UPDATE;

  IF v_lead.business_id IS NULL THEN
    RAISE EXCEPTION 'Lead % has no business assigned; assign one before converting to a sales order', p_lead_id
      USING ERRCODE = '22023';
  END IF;

  -- A project handed in by the caller must belong to the same business.
  IF p_project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.projects pr
     WHERE pr.id = p_project_id AND pr.business_id = v_lead.business_id
  ) THEN
    RAISE EXCEPTION 'CRM: project % does not belong to business %',
      p_project_id, v_lead.business_id USING ERRCODE = '23514';
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

  v_contact_id := v_lead.contact_id;
  IF v_contact_id IS NULL THEN
    SELECT cc.id INTO v_contact_id FROM public.convert_lead_to_contact(p_lead_id) cc;
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.contacts c
     WHERE c.id = v_contact_id AND c.business_id = v_lead.business_id
  ) THEN
    RAISE EXCEPTION 'CRM: lead contact % does not belong to business %',
      v_contact_id, v_lead.business_id USING ERRCODE = '23514';
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
         COALESCE(SUM(round(COALESCE(li.line_total,0) * COALESCE(li.tax_rate,0) / 100.0, 2)), 0)
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
         round(COALESCE(li.line_total,0) * COALESCE(li.tax_rate,0) / 100.0, 2),
         COALESCE(li.discount_percent, 0), li.line_total,
         COALESCE(li.sort_order, 0), p_project_id
    FROM public.crm_lead_items li
   WHERE li.lead_id = p_lead_id;

  -- D1: business_id is NOT NULL on crm_activities; omitting it aborted the
  -- whole conversion.
  INSERT INTO public.crm_activities (
    organization_id, business_id, lead_id, activity_type, summary,
    is_done, completed_at, created_by
  ) VALUES (
    v_lead.organization_id, v_lead.business_id, p_lead_id, 'system',
    'Sales order created: ' || v_new_no, true, now(), auth.uid()
  );

  RETURN QUERY SELECT v_new_id, v_new_no, false;
END;
$function$;