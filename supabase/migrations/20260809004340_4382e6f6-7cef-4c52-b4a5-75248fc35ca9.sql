-- ============================================================
-- Phase 2 · Atomic creation, numbering, and conversion provenance
-- ============================================================

-- 1. FX provenance on the order itself.
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS exchange_rate numeric;

COMMENT ON COLUMN public.sales_orders.exchange_rate IS
  'Rate from the order currency to the business base currency, captured at order date. Carried forward to the invoice so revenue is not re-translated at a later rate.';

-- 2. Numbering must be org-scoped to match the (organization_id, so_number)
--    uniqueness rule. Filtering the MAX() by business/branch while locking on
--    org+branch let two businesses in one org mint the same number.
CREATE OR REPLACE FUNCTION public.get_next_so_number(_org_id uuid, _business_id uuid, _branch_id uuid DEFAULT NULL::uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  next_num integer;
  year_prefix text;
  prefix text := 'SO';
BEGIN
  year_prefix := to_char(CURRENT_DATE, 'YYYY');

  -- One lock per org: the sequence space is org-wide because the uniqueness
  -- constraint is org-wide.
  PERFORM pg_advisory_xact_lock(hashtext('sales_orders_' || _org_id::text));

  SELECT COALESCE(MAX(
    CAST(NULLIF(regexp_replace(split_part(so_number, '-', 3), '[^0-9]', '', 'g'), '') AS INTEGER)
  ), 0) + 1 INTO next_num
  FROM public.sales_orders
  WHERE organization_id = _org_id
    AND so_number LIKE prefix || '-' || year_prefix || '-%';

  RETURN prefix || '-' || year_prefix || '-' || LPAD(next_num::text, 4, '0');
END;
$function$;

-- 3. FX resolver: order currency -> business base currency at a given date.
CREATE OR REPLACE FUNCTION public.resolve_sales_exchange_rate(
  p_org_id uuid,
  p_business_id uuid,
  p_currency text,
  p_on_date date
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_base text;
  v_rate numeric;
BEGIN
  SELECT base_currency INTO v_base FROM public.businesses WHERE id = p_business_id;
  IF p_currency IS NULL OR v_base IS NULL OR upper(p_currency) = upper(v_base) THEN
    RETURN 1;
  END IF;

  SELECT rate INTO v_rate
    FROM public.exchange_rates
   WHERE organization_id = p_org_id
     AND upper(from_currency) = upper(p_currency)
     AND upper(to_currency) = upper(v_base)
     AND effective_date <= COALESCE(p_on_date, CURRENT_DATE)
     AND (business_id IS NULL OR business_id = p_business_id)
   ORDER BY effective_date DESC, business_id NULLS LAST
   LIMIT 1;

  RETURN v_rate; -- NULL when the org has no rate on file; caller must not invent one.
END;
$function$;

-- 4. Atomic creation. Header + lines + totals + numbering in one transaction.
CREATE OR REPLACE FUNCTION public.create_sales_order_atomic(
  p_header jsonb,
  p_items  jsonb,
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org        uuid := NULLIF(p_header->>'organization_id','')::uuid;
  v_business   uuid := NULLIF(p_header->>'business_id','')::uuid;
  v_branch     uuid := NULLIF(p_header->>'branch_id','')::uuid;
  v_user       uuid := COALESCE(p_user_id, auth.uid());
  v_status     text := COALESCE(NULLIF(p_header->>'status',''), 'draft');
  v_currency   text;
  v_order_date date := COALESCE(NULLIF(p_header->>'order_date','')::date, CURRENT_DATE);
  v_so_number  text;
  v_so_id      uuid;
  v_subtotal   numeric := 0;
  v_tax        numeric := 0;
  v_discount   numeric := COALESCE(NULLIF(p_header->>'discount_amount','')::numeric, 0);
  v_shipping   numeric := COALESCE(NULLIF(p_header->>'shipping_amount','')::numeric, 0);
  v_total      numeric;
  v_rate       numeric;
  v_item_count int;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR v_business IS NULL THEN
    RAISE EXCEPTION 'organization_id and business_id are required' USING ERRCODE = '22023';
  END IF;
  IF NOT public.user_can_access_business(v_user, v_business) THEN
    RAISE EXCEPTION 'Access denied for business %', v_business USING ERRCODE = '42501';
  END IF;
  IF v_status NOT IN ('draft','pending_approval') THEN
    RAISE EXCEPTION 'A new sales order may only be created as draft or pending_approval (got %)', v_status
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(NULLIF(p_header->>'currency',''), b.base_currency, 'USD')
    INTO v_currency
    FROM public.businesses b WHERE b.id = v_business;

  -- Totals are derived from the lines; never trusted from the caller.
  SELECT
    COALESCE(SUM(COALESCE((i->>'line_total')::numeric, 0)), 0),
    COALESCE(SUM(COALESCE((i->>'tax_amount')::numeric, 0)), 0),
    count(*)
  INTO v_subtotal, v_tax, v_item_count
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) i;

  v_total := round(v_subtotal + v_tax - v_discount + v_shipping, 2);
  v_rate  := public.resolve_sales_exchange_rate(v_org, v_business, v_currency, v_order_date);

  v_so_number := public.get_next_so_number(v_org, v_business, v_branch);

  INSERT INTO public.sales_orders (
    organization_id, business_id, branch_id, so_number, contact_id,
    order_date, expected_date, status, currency, exchange_rate,
    subtotal, tax_amount, discount_amount, shipping_amount, total,
    shipping_address, notes, created_by, salesperson_id, payment_term_id,
    project_id, source_estimate_id
  ) VALUES (
    v_org, v_business, v_branch, v_so_number,
    NULLIF(p_header->>'contact_id','')::uuid,
    v_order_date,
    NULLIF(p_header->>'expected_date','')::date,
    v_status, v_currency, v_rate,
    round(v_subtotal, 2), round(v_tax, 2), round(v_discount, 2), round(v_shipping, 2), v_total,
    NULLIF(p_header->>'shipping_address',''),
    NULLIF(p_header->>'notes',''),
    v_user,
    COALESCE(NULLIF(p_header->>'salesperson_id','')::uuid, v_user),
    NULLIF(p_header->>'payment_term_id','')::uuid,
    NULLIF(p_header->>'project_id','')::uuid,
    NULLIF(p_header->>'source_estimate_id','')::uuid
  )
  RETURNING id INTO v_so_id;

  INSERT INTO public.sales_order_items (
    sales_order_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order,
    project_id, task_id, packaging_id, display_uom_id, display_quantity, uom_snapshot
  )
  SELECT
    v_so_id,
    NULLIF(i->>'product_id','')::uuid,
    COALESCE(i->>'description',''),
    COALESCE((i->>'quantity')::numeric, 1),
    COALESCE((i->>'unit_price')::numeric, 0),
    COALESCE((i->>'tax_rate')::numeric, 0),
    COALESCE((i->>'tax_amount')::numeric, 0),
    COALESCE((i->>'discount_percent')::numeric, 0),
    COALESCE((i->>'line_total')::numeric, 0),
    COALESCE((i->>'sort_order')::int, (ord - 1)::int),
    NULLIF(i->>'project_id','')::uuid,
    NULLIF(i->>'task_id','')::uuid,
    NULLIF(i->>'packaging_id','')::uuid,
    NULLIF(i->>'display_uom_id','')::uuid,
    NULLIF(i->>'display_quantity','')::numeric,
    CASE WHEN i ? 'uom_snapshot' AND jsonb_typeof(i->'uom_snapshot') = 'object'
         THEN i->'uom_snapshot' ELSE NULL END
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) WITH ORDINALITY AS t(i, ord);

  RETURN jsonb_build_object(
    'success', true,
    'sales_order_id', v_so_id,
    'so_number', v_so_number,
    'subtotal', round(v_subtotal, 2),
    'tax_amount', round(v_tax, 2),
    'total', v_total,
    'exchange_rate', v_rate,
    'item_count', v_item_count
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.create_sales_order_atomic(jsonb, jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_sales_exchange_rate(uuid, uuid, text, date) TO authenticated;

-- 5. Lead -> SO conversion: stop dropping branch, salesperson and tax.
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

  -- A sales order with no business is invisible to every list in the app
  -- (all reads are business-scoped). Fail loudly instead.
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

  -- Branch provenance: the lead's own branch when it has one, else the
  -- business HQ, so branch-scoped lists can see the order.
  BEGIN
    EXECUTE 'SELECT ($1).branch_id' INTO v_branch USING v_lead;
  EXCEPTION WHEN undefined_column OR others THEN
    v_branch := NULL;
  END;
  IF v_branch IS NULL THEN
    SELECT br.id INTO v_branch
      FROM public.branches br
     WHERE br.business_id = v_lead.business_id
       AND COALESCE(br.is_active, true) = true
     ORDER BY (br.code = 'HQ') DESC NULLS LAST, br.created_at ASC
     LIMIT 1;
  END IF;

  -- Real line economics: tax was previously forced to zero.
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

-- 6. Estimate -> SO: carry terms and the captured FX rate.
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
  v_max_sort integer;
  v_costs numeric := 0;
  v_subtotal numeric;
  v_notes text;
  v_rate numeric;
BEGIN
  IF auth.uid() IS NULL AND p_user_id IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_est FROM public.estimates WHERE id = p_estimate_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Estimate % not found', p_estimate_id;
  END IF;

  IF v_est.status = 'converted' OR v_est.converted_sales_order_id IS NOT NULL THEN
    RAISE EXCEPTION 'Estimate % already converted', v_est.estimate_number;
  END IF;
  IF v_est.status NOT IN ('draft','sent','viewed','accepted') THEN
    RAISE EXCEPTION 'Cannot convert estimate in status %', v_est.status;
  END IF;
  IF v_est.business_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_est.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_est.business_id USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(SUM(amount),0) INTO v_costs
  FROM public.estimate_additional_costs WHERE estimate_id = p_estimate_id;
  v_subtotal := COALESCE(v_est.subtotal,0) + v_costs;

  IF round(v_subtotal + COALESCE(v_est.tax_amount,0) - COALESCE(v_est.discount_amount,0), 2)
     <> round(COALESCE(v_est.total,0), 2) THEN
    RAISE EXCEPTION 'Estimate % totals do not reconcile', v_est.estimate_number;
  END IF;

  SELECT public.get_next_so_number(v_est.organization_id, v_est.business_id, v_est.branch_id) INTO v_so_number;

  v_expected := GREATEST(
    CURRENT_DATE + INTERVAL '14 days',
    COALESCE(v_est.expiry_date, CURRENT_DATE + INTERVAL '14 days')
  )::date;

  -- The estimate's agreed terms are commercially binding; they were previously
  -- dropped on conversion. sales_orders has no terms column, so they are
  -- preserved in the order notes rather than lost.
  v_notes := NULLIF(concat_ws(E'\n\n', NULLIF(v_est.notes,''), NULLIF(v_est.terms,'')), '');

  v_rate := public.resolve_sales_exchange_rate(
    v_est.organization_id, v_est.business_id, v_est.currency, CURRENT_DATE);

  INSERT INTO public.sales_orders(
    organization_id, business_id, branch_id, contact_id,
    so_number, status, order_date, expected_date,
    subtotal, tax_amount, discount_amount, total, currency, exchange_rate,
    notes, created_by, salesperson_id, source_estimate_id
  ) VALUES (
    v_est.organization_id, v_est.business_id, v_est.branch_id, v_est.contact_id,
    v_so_number, 'draft', CURRENT_DATE, v_expected,
    v_subtotal, COALESCE(v_est.tax_amount,0), COALESCE(v_est.discount_amount,0),
    v_est.total, v_est.currency, v_rate,
    v_notes, p_user_id, COALESCE(v_est.created_by, p_user_id), p_estimate_id
  )
  RETURNING id INTO v_so_id;

  INSERT INTO public.sales_order_items(
    sales_order_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order,
    packaging_id, display_uom_id, display_quantity, uom_snapshot
  )
  SELECT
    v_so_id, ei.product_id, ei.description, ei.quantity, ei.unit_price,
    COALESCE(ei.tax_rate,0), COALESCE(ei.tax_amount,0),
    COALESCE(ei.discount_percent,0), ei.line_total, COALESCE(ei.sort_order,0),
    ei.packaging_id, ei.display_uom_id, ei.display_quantity, ei.uom_snapshot
  FROM public.estimate_items ei
  WHERE ei.estimate_id = p_estimate_id;

  SELECT COALESCE(MAX(sort_order), -1) INTO v_max_sort
  FROM public.sales_order_items WHERE sales_order_id = v_so_id;

  INSERT INTO public.sales_order_items(
    sales_order_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order
  )
  SELECT
    v_so_id, NULL, ac.name, 1, ac.amount,
    COALESCE(ac.tax_rate,0), COALESCE(ac.tax_amount,0), 0, ac.amount,
    v_max_sort + 1 + row_number() OVER (ORDER BY COALESCE(ac.sort_order,0), ac.created_at)
  FROM public.estimate_additional_costs ac
  WHERE ac.estimate_id = p_estimate_id;

  PERFORM set_config('app.estimate_status_writer', '1', true);
  UPDATE public.estimates
  SET status = 'converted',
      converted_sales_order_id = v_so_id,
      converted_at = COALESCE(converted_at, now()),
      updated_at = now()
  WHERE id = p_estimate_id;
  PERFORM set_config('app.estimate_status_writer', '0', true);

  INSERT INTO public.estimate_status_events(
    estimate_id, organization_id, business_id, from_status, to_status, reason, changed_by
  ) VALUES (p_estimate_id, v_est.organization_id, v_est.business_id, v_est.status, 'converted',
            'converted to sales order ' || v_so_number, p_user_id);

  RETURN jsonb_build_object('success', true, 'sales_order_id', v_so_id, 'so_number', v_so_number);
END;
$function$;
