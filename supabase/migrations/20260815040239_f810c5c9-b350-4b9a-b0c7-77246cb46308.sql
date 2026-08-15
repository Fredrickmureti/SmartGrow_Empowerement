-- ============================================================================
-- Phase 10 — server authority & concurrency for Sales documents
--   1. create_sales_order_atomic gains an idempotency key, claimed BEFORE the
--      order is written so a concurrent twin cannot slip through the gap
--      between "check" and "insert".
--   2. Estimate conversions become replay-safe: a repeated conversion returns
--      the document that already exists instead of raising.
-- ============================================================================

DROP FUNCTION IF EXISTS public.create_sales_order_atomic(jsonb, jsonb, uuid);

CREATE OR REPLACE FUNCTION public.create_sales_order_atomic(
  p_header jsonb,
  p_items jsonb,
  p_user_id uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text)
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
  v_warehouse  uuid;
  v_tracked    boolean;
  v_subtotal   numeric := 0;
  v_tax        numeric := 0;
  v_discount   numeric := COALESCE(NULLIF(p_header->>'discount_amount','')::numeric, 0);
  v_shipping   numeric := COALESCE(NULLIF(p_header->>'shipping_amount','')::numeric, 0);
  v_total      numeric;
  v_rate       numeric;
  v_item_count int;
  v_lines      jsonb := '[]'::jsonb;
  v_item       jsonb;
  v_ord        int := 0;
  v_display    numeric;
  v_res        jsonb;
  v_base       numeric;
  v_claimed    numeric;
  v_unit_price numeric;
  v_disc_pct   numeric;
  v_tax_rate   numeric;
  v_line_total numeric;
  v_tax_amount numeric;
  v_key        text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_claim_id   uuid;
  v_existing   jsonb;
  v_result     jsonb;
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

  -- Claim the key first: the unique index is the concurrency control, so two
  -- simultaneous submissions cannot both reach the INSERT below.
  IF v_key IS NOT NULL THEN
    INSERT INTO public.sales_document_idempotency(
      organization_id, business_id, document_type, idempotency_key, created_by)
    VALUES (v_org, v_business, 'sales_order', v_key, v_user)
    ON CONFLICT (organization_id, document_type, idempotency_key) DO NOTHING
    RETURNING id INTO v_claim_id;

    IF v_claim_id IS NULL THEN
      SELECT response INTO v_existing
        FROM public.sales_document_idempotency
       WHERE organization_id = v_org
         AND document_type = 'sales_order'
         AND idempotency_key = v_key;
      IF v_existing IS NOT NULL THEN
        RETURN v_existing || jsonb_build_object('idempotent_replay', true);
      END IF;
      RAISE EXCEPTION 'A sales order for this request is already being created'
        USING ERRCODE = '40001';
    END IF;
  END IF;

  SELECT COALESCE(NULLIF(p_header->>'currency',''), b.base_currency, 'USD')
    INTO v_currency
    FROM public.businesses b WHERE b.id = v_business;

  -- Phase 6b: the order records the stock location it will reserve against.
  SELECT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) AS t(i)
      JOIN public.products p ON p.id = NULLIF(i->>'product_id','')::uuid
     WHERE COALESCE(p.track_inventory, false) = true
  ) INTO v_tracked;

  IF NULLIF(p_header->>'warehouse_id','') IS NOT NULL OR v_tracked THEN
    v_warehouse := public.resolve_sales_warehouse(
      v_org, v_business, v_branch, NULLIF(p_header->>'warehouse_id','')::uuid);
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    v_ord := v_ord + 1;
    v_display := COALESCE(
      NULLIF(v_item->>'display_quantity','')::numeric,
      NULLIF(v_item->>'quantity','')::numeric,
      1);
    IF v_display <= 0 THEN
      RAISE EXCEPTION 'line %: quantity must be greater than zero', v_ord USING ERRCODE = '22023';
    END IF;

    v_res := public.resolve_line_base_quantity(
      v_business,
      NULLIF(v_item->>'product_id','')::uuid,
      v_display,
      NULLIF(v_item->>'display_uom_id','')::uuid,
      NULLIF(v_item->>'packaging_id','')::uuid);
    v_base := (v_res->>'base_quantity')::numeric;

    v_claimed := NULLIF(v_item->>'quantity','')::numeric;
    IF v_claimed IS NOT NULL AND abs(v_claimed - v_base) > 0.0001 THEN
      RAISE EXCEPTION
        'line %: client base quantity % disagrees with the resolved base quantity % (display % )',
        v_ord, v_claimed, v_base, v_display USING ERRCODE = '22023';
    END IF;

    v_unit_price := COALESCE(NULLIF(v_item->>'unit_price','')::numeric, 0);
    v_disc_pct   := COALESCE(NULLIF(v_item->>'discount_percent','')::numeric, 0);
    v_tax_rate   := COALESCE(NULLIF(v_item->>'tax_rate','')::numeric, 0);
    v_line_total := round(v_display * v_unit_price * (1 - v_disc_pct / 100.0), 2);
    v_tax_amount := round(v_line_total * v_tax_rate / 100.0, 2);

    v_subtotal := v_subtotal + v_line_total;
    v_tax      := v_tax + v_tax_amount;

    v_lines := v_lines || jsonb_build_object(
      'product_id', NULLIF(v_item->>'product_id',''),
      'description', COALESCE(v_item->>'description',''),
      'quantity', v_base,
      'display_quantity', v_display,
      'display_uom_id', v_res->>'display_uom_id',
      'packaging_id', v_res->>'packaging_id',
      'uom_snapshot', v_res->>'uom_snapshot',
      'unit_price', v_unit_price,
      'discount_percent', v_disc_pct,
      'tax_rate', v_tax_rate,
      'tax_amount', v_tax_amount,
      'line_total', v_line_total,
      'sort_order', COALESCE(NULLIF(v_item->>'sort_order','')::int, v_ord - 1),
      'project_id', NULLIF(v_item->>'project_id',''),
      'task_id', NULLIF(v_item->>'task_id','')
    );
  END LOOP;

  v_item_count := v_ord;
  v_total := round(v_subtotal + v_tax - v_discount + v_shipping, 2);
  v_rate  := public.resolve_sales_exchange_rate(v_org, v_business, v_currency, v_order_date);

  v_so_number := public.get_next_so_number(v_org, v_business, v_branch);

  INSERT INTO public.sales_orders (
    organization_id, business_id, branch_id, warehouse_id, so_number, contact_id,
    order_date, expected_date, status, currency, exchange_rate,
    subtotal, tax_amount, discount_amount, shipping_amount, total,
    shipping_address, notes, created_by, salesperson_id, payment_term_id,
    project_id, source_estimate_id
  ) VALUES (
    v_org, v_business, v_branch, v_warehouse, v_so_number,
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
    i->>'description',
    (i->>'quantity')::numeric,
    (i->>'unit_price')::numeric,
    (i->>'tax_rate')::numeric,
    (i->>'tax_amount')::numeric,
    (i->>'discount_percent')::numeric,
    (i->>'line_total')::numeric,
    (i->>'sort_order')::int,
    NULLIF(i->>'project_id','')::uuid,
    NULLIF(i->>'task_id','')::uuid,
    NULLIF(i->>'packaging_id','')::uuid,
    NULLIF(i->>'display_uom_id','')::uuid,
    (i->>'display_quantity')::numeric,
    NULLIF(i->>'uom_snapshot','')
  FROM jsonb_array_elements(v_lines) AS t(i);

  v_result := jsonb_build_object(
    'success', true,
    'sales_order_id', v_so_id,
    'so_number', v_so_number,
    'warehouse_id', v_warehouse,
    'subtotal', round(v_subtotal, 2),
    'tax_amount', round(v_tax, 2),
    'total', v_total,
    'exchange_rate', v_rate,
    'item_count', v_item_count
  );

  IF v_claim_id IS NOT NULL THEN
    UPDATE public.sales_document_idempotency
       SET document_id = v_so_id, response = v_result, updated_at = now()
     WHERE id = v_claim_id;
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_sales_order_atomic(jsonb, jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_sales_order_atomic(jsonb, jsonb, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Replay-safe estimate conversions
-- ---------------------------------------------------------------------------

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

  IF v_est.business_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_est.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_est.business_id USING ERRCODE = '42501';
  END IF;

  -- Phase 10: a repeated conversion (double-click, retry, refresh) returns the
  -- order that already exists instead of failing the caller.
  IF v_est.converted_sales_order_id IS NOT NULL THEN
    SELECT so_number INTO v_so_number
      FROM public.sales_orders WHERE id = v_est.converted_sales_order_id;
    RETURN jsonb_build_object(
      'success', true,
      'sales_order_id', v_est.converted_sales_order_id,
      'so_number', v_so_number,
      'idempotent_replay', true);
  END IF;

  IF v_est.status NOT IN ('draft','sent','viewed','accepted') THEN
    RAISE EXCEPTION 'Cannot convert estimate in status %', v_est.status;
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

CREATE OR REPLACE FUNCTION public.convert_estimate_to_invoice_atomic(p_estimate_id uuid, p_user_id uuid, p_auto_confirm boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_est RECORD;
  v_inv_number text;
  v_inv_id uuid;
  v_max_sort integer;
  v_costs numeric := 0;
  v_costs_tax numeric := 0;
  v_subtotal numeric;
  v_accounts jsonb;
  v_ar uuid;
  v_rev_default uuid;
  v_tax_account uuid;
  v_tax numeric;
  v_total numeric;
  v_lines jsonb;
  v_confirm jsonb;
  v_je_id uuid;
  v_inv_status text := 'draft';
  v_confirm_error text := NULL;
BEGIN
  SELECT * INTO v_est FROM public.estimates WHERE id = p_estimate_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Estimate % not found', p_estimate_id;
  END IF;
  IF NOT public.user_can_access_business(p_user_id, v_est.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_est.business_id USING ERRCODE = '42501';
  END IF;

  -- Phase 10: replay of the same conversion returns the existing invoice.
  IF v_est.converted_invoice_id IS NOT NULL THEN
    SELECT invoice_number, status INTO v_inv_number, v_inv_status
      FROM public.invoices WHERE id = v_est.converted_invoice_id;
    RETURN jsonb_build_object(
      'success', true,
      'invoice_id', v_est.converted_invoice_id,
      'invoice_number', v_inv_number,
      'invoice_status', v_inv_status,
      'confirmed', v_inv_status <> 'draft',
      'journal_entry_id', NULL,
      'confirm_error', NULL,
      'idempotent_replay', true);
  END IF;

  IF v_est.status NOT IN ('draft','sent','viewed','accepted') THEN
    RAISE EXCEPTION 'Cannot convert estimate in status %', v_est.status;
  END IF;

  SELECT COALESCE(SUM(amount),0), COALESCE(SUM(tax_amount),0)
    INTO v_costs, v_costs_tax
  FROM public.estimate_additional_costs WHERE estimate_id = p_estimate_id;

  v_subtotal := COALESCE(v_est.subtotal,0) + v_costs;
  v_tax := COALESCE(v_est.tax_amount,0);
  v_total := COALESCE(v_est.total,0);

  IF round(v_subtotal + v_tax - COALESCE(v_est.discount_amount,0), 2) <> round(v_total, 2) THEN
    RAISE EXCEPTION 'Estimate % totals do not reconcile (subtotal % + tax % - discount % <> total %)',
      v_est.estimate_number, v_subtotal, v_est.tax_amount, v_est.discount_amount, v_est.total;
  END IF;

  SELECT public.get_next_invoice_number(v_est.organization_id, v_est.business_id) INTO v_inv_number;

  INSERT INTO public.invoices(
    organization_id, business_id, branch_id, contact_id,
    invoice_number, status, issue_date, due_date,
    subtotal, tax_amount, discount_amount, total, currency,
    notes, terms, created_by, source_estimate_id
  ) VALUES (
    v_est.organization_id, v_est.business_id, v_est.branch_id, v_est.contact_id,
    v_inv_number, 'draft', CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
    v_subtotal, v_tax, COALESCE(v_est.discount_amount,0), v_total, v_est.currency,
    v_est.notes, v_est.terms, p_user_id, p_estimate_id
  )
  RETURNING id INTO v_inv_id;

  INSERT INTO public.invoice_items(
    invoice_id, business_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order,
    packaging_id, display_uom_id, display_quantity, uom_snapshot
  )
  SELECT
    v_inv_id, v_est.business_id, ei.product_id, ei.description, ei.quantity, ei.unit_price,
    COALESCE(ei.tax_rate,0), COALESCE(ei.tax_amount,0),
    COALESCE(ei.discount_percent,0), ei.line_total, COALESCE(ei.sort_order,0),
    ei.packaging_id, ei.display_uom_id, ei.display_quantity, ei.uom_snapshot
  FROM public.estimate_items ei
  WHERE ei.estimate_id = p_estimate_id;

  SELECT COALESCE(MAX(sort_order), -1) INTO v_max_sort
  FROM public.invoice_items WHERE invoice_id = v_inv_id;

  INSERT INTO public.invoice_items(
    invoice_id, business_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order
  )
  SELECT
    v_inv_id, v_est.business_id, NULL, ac.name, 1, ac.amount,
    COALESCE(ac.tax_rate,0), COALESCE(ac.tax_amount,0), 0, ac.amount,
    v_max_sort + 1 + row_number() OVER (ORDER BY COALESCE(ac.sort_order,0), ac.created_at)
  FROM public.estimate_additional_costs ac
  WHERE ac.estimate_id = p_estimate_id;

  PERFORM set_config('app.estimate_status_writer', '1', true);
  UPDATE public.estimates
  SET status = 'converted',
      converted_invoice_id = v_inv_id,
      converted_at = now(),
      updated_at = now()
  WHERE id = p_estimate_id;
  PERFORM set_config('app.estimate_status_writer', '0', true);

  INSERT INTO public.estimate_status_events(
    estimate_id, organization_id, business_id, from_status, to_status, reason, changed_by
  ) VALUES (p_estimate_id, v_est.organization_id, v_est.business_id, v_est.status, 'converted',
            'converted to invoice ' || v_inv_number, p_user_id);

  IF COALESCE(p_auto_confirm, true) THEN
    BEGIN
      v_accounts := public._resolve_invoice_gl_accounts(
        v_est.organization_id, v_est.business_id, v_est.contact_id,
        ARRAY(SELECT product_id FROM public.invoice_items
               WHERE invoice_id = v_inv_id AND product_id IS NOT NULL));

      v_ar := NULLIF(v_accounts->>'ar_account_id','')::uuid;
      v_rev_default := NULLIF(v_accounts->>'revenue_default_account_id','')::uuid;
      v_tax_account := public.get_default_account_id(v_est.organization_id, v_est.business_id, 'output_tax');

      IF v_ar IS NULL OR v_rev_default IS NULL THEN
        RAISE EXCEPTION 'Accounts Receivable and Sales Revenue default accounts are not configured';
      END IF;
      IF v_tax > 0 AND v_tax_account IS NULL THEN
        RAISE EXCEPTION 'An Output Tax default account is required to post a taxed invoice';
      END IF;

      SELECT jsonb_agg(l ORDER BY ord) INTO v_lines FROM (
        SELECT 0 AS ord, jsonb_build_object(
          'account_id', v_ar, 'debit', v_total, 'credit', 0,
          'description', 'Invoice ' || v_inv_number || ' - Accounts Receivable',
          'contact_id', v_est.contact_id) AS l
        UNION ALL
        SELECT 1, jsonb_build_object(
          'account_id', acct, 'debit', 0, 'credit', amt,
          'description', 'Invoice ' || v_inv_number || ' - Sales Revenue')
        FROM (
          SELECT COALESCE(
                   public.resolve_product_gl_account(
                     v_est.organization_id, v_est.business_id, ii.product_id, 'sales_revenue'),
                   v_rev_default) AS acct,
                 ROUND(SUM(ii.line_total), 2) AS amt
            FROM public.invoice_items ii
           WHERE ii.invoice_id = v_inv_id
           GROUP BY 1
        ) rev
        UNION ALL
        SELECT 2, jsonb_build_object(
          'account_id', v_tax_account, 'debit', 0, 'credit', v_tax,
          'description', 'Invoice ' || v_inv_number || ' - Tax Liability')
        WHERE v_tax > 0 AND v_tax_account IS NOT NULL
      ) lines;

      v_confirm := public._confirm_invoice_core(v_inv_id, p_user_id, v_lines, 'sent');
      v_je_id := NULLIF(v_confirm->>'journal_entry_id','')::uuid;
      v_inv_status := 'sent';
    EXCEPTION WHEN OTHERS THEN
      v_confirm_error := SQLERRM;
      v_inv_status := 'draft';
    END;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', v_inv_id,
    'invoice_number', v_inv_number,
    'invoice_status', v_inv_status,
    'confirmed', v_inv_status = 'sent',
    'journal_entry_id', v_je_id,
    'confirm_error', v_confirm_error);
END;
$function$;