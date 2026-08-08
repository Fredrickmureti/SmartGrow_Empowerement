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
  IF v_est.converted_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'Estimate % already converted to invoice %', v_est.estimate_number, v_est.converted_invoice_id;
  END IF;
  IF v_est.status NOT IN ('draft','sent','viewed','accepted') THEN
    RAISE EXCEPTION 'Cannot convert estimate in status %', v_est.status;
  END IF;
  IF NOT public.user_can_access_business(p_user_id, v_est.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_est.business_id USING ERRCODE = '42501';
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

  -- A converted estimate is a customer commitment, so the resulting invoice is
  -- posted and issued immediately (Odoo "confirm on conversion") rather than
  -- landing as an unexplained draft. Uses the canonical posting engine so GL,
  -- delivery-note creation and status writing stay single-sourced.
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
      -- Posting problems (missing account mappings, closed period) must not
      -- destroy the conversion; the invoice stays a draft and the caller is
      -- told exactly why so it can be confirmed manually.
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