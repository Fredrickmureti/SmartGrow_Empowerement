CREATE OR REPLACE FUNCTION public.generate_recurring_invoice_occurrence(
  _recurring_id uuid, _period_start date, _user_id uuid DEFAULT NULL::uuid,
  _trigger_source text DEFAULT 'schedule'::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ri record;
  v_run record;
  v_period_end date;
  v_next_start date;
  v_run_id uuid;
  v_invoice_id uuid;
  v_invoice_number text;
  v_due_date date;
  v_subtotal numeric := 0;
  v_tax numeric := 0;
  v_accounts jsonb;
  v_ar uuid;
  v_rev_default uuid;
  v_tax_account uuid;
  v_lines jsonb;
  v_confirm jsonb;
  v_je_id uuid;
  v_status text;
  v_delivery text;
  v_delivery_error text;
BEGIN
  SELECT * INTO v_ri FROM public.recurring_invoices WHERE id = _recurring_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recurring template % not found', _recurring_id;
  END IF;

  v_next_start := public.recurring_next_start(
    v_ri.frequency, _period_start,
    EXTRACT(day FROM COALESCE(v_ri.start_date, _period_start))::int);
  v_period_end := v_next_start - 1;

  SELECT * INTO v_run FROM public.recurring_invoice_runs
   WHERE recurring_invoice_id = _recurring_id AND period_start = _period_start
   FOR UPDATE;

  IF FOUND THEN
    IF v_run.status IN ('generated','posted','skipped') THEN
      RETURN jsonb_build_object(
        'status', v_run.status, 'duplicate', true, 'run_id', v_run.id,
        'invoice_id', v_run.invoice_id, 'invoice_number', v_run.invoice_number,
        'period_start', _period_start, 'period_end', v_run.period_end,
        'next_run_date', v_next_start);
    END IF;
    UPDATE public.recurring_invoice_runs
       SET status = 'claimed', attempt_count = attempt_count + 1,
           failure_reason = NULL, triggered_by = _user_id,
           trigger_source = _trigger_source
     WHERE id = v_run.id
    RETURNING id INTO v_run_id;
  ELSE
    INSERT INTO public.recurring_invoice_runs (
      recurring_invoice_id, organization_id, business_id, branch_id,
      period_start, period_end, status, triggered_by, trigger_source)
    VALUES (_recurring_id, v_ri.organization_id, v_ri.business_id, v_ri.branch_id,
            _period_start, v_period_end, 'claimed', _user_id, _trigger_source)
    RETURNING id INTO v_run_id;
  END IF;

  BEGIN
    IF v_ri.status <> 'active' THEN
      RAISE EXCEPTION 'Recurring template is % and cannot bill', v_ri.status;
    END IF;
    IF v_ri.contact_id IS NULL THEN
      RAISE EXCEPTION 'Recurring template has no customer';
    END IF;
    IF v_ri.business_id IS NULL THEN
      RAISE EXCEPTION 'Recurring template has no business scope';
    END IF;
    IF v_ri.end_date IS NOT NULL AND _period_start > v_ri.end_date THEN
      RAISE EXCEPTION 'Billing period % is past the schedule end date %', _period_start, v_ri.end_date;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.recurring_invoice_items WHERE recurring_invoice_id = _recurring_id) THEN
      RAISE EXCEPTION 'Recurring template has no line items';
    END IF;

    SELECT
      COALESCE(ROUND(SUM(quantity * unit_price * (1 - COALESCE(discount_percent,0)/100.0)), 2), 0),
      COALESCE(ROUND(SUM(quantity * unit_price * (1 - COALESCE(discount_percent,0)/100.0) * COALESCE(tax_rate,0)/100.0), 2), 0)
      INTO v_subtotal, v_tax
      FROM public.recurring_invoice_items WHERE recurring_invoice_id = _recurring_id;

    v_invoice_number := public.get_next_invoice_number(v_ri.organization_id, v_ri.business_id);
    v_due_date := _period_start + COALESCE(v_ri.days_before_due, 30);

    INSERT INTO public.invoices (
      organization_id, business_id, branch_id, contact_id, invoice_number,
      status, issue_date, due_date, billing_period_start, billing_period_end,
      subtotal, tax_amount, total, currency, notes, terms,
      created_by, source, source_recurring_id)
    VALUES (
      v_ri.organization_id, v_ri.business_id, v_ri.branch_id, v_ri.contact_id, v_invoice_number,
      'draft', _period_start, v_due_date, _period_start, v_period_end,
      v_subtotal, v_tax, v_subtotal + v_tax, v_ri.currency, v_ri.notes, v_ri.terms,
      COALESCE(_user_id, v_ri.created_by), 'recurring', _recurring_id)
    RETURNING id INTO v_invoice_id;

    INSERT INTO public.invoice_items (
      invoice_id, business_id, product_id, description, quantity, unit_price,
      tax_rate, tax_amount, discount_percent, line_total, sort_order)
    SELECT
      v_invoice_id, v_ri.business_id, i.product_id, i.description, i.quantity, i.unit_price,
      COALESCE(i.tax_rate,0),
      ROUND(i.quantity * i.unit_price * (1 - COALESCE(i.discount_percent,0)/100.0) * COALESCE(i.tax_rate,0)/100.0, 2),
      COALESCE(i.discount_percent,0),
      ROUND(i.quantity * i.unit_price * (1 - COALESCE(i.discount_percent,0)/100.0), 2),
      i.sort_order
    FROM public.recurring_invoice_items i
    WHERE i.recurring_invoice_id = _recurring_id;

    v_status := 'generated';

    IF COALESCE(v_ri.auto_confirm, false) THEN
      v_accounts := public._resolve_invoice_gl_accounts(
        v_ri.organization_id, v_ri.business_id, v_ri.contact_id,
        ARRAY(SELECT product_id FROM public.recurring_invoice_items
               WHERE recurring_invoice_id = _recurring_id AND product_id IS NOT NULL));

      v_ar := NULLIF(v_accounts->>'ar_account_id','')::uuid;
      v_rev_default := NULLIF(v_accounts->>'revenue_default_account_id','')::uuid;
      v_tax_account := public.get_default_account_id(v_ri.organization_id, v_ri.business_id, 'output_tax');

      IF v_ar IS NULL OR v_rev_default IS NULL THEN
        RAISE EXCEPTION 'Auto-posting requires Accounts Receivable and Sales Revenue default accounts';
      END IF;
      IF v_tax > 0 AND v_tax_account IS NULL THEN
        RAISE EXCEPTION 'Auto-posting a taxed invoice requires an Output Tax default account';
      END IF;

      SELECT jsonb_agg(l ORDER BY ord) INTO v_lines FROM (
        SELECT 0 AS ord, jsonb_build_object(
          'account_id', v_ar, 'debit', v_subtotal + v_tax, 'credit', 0,
          'description', 'Invoice ' || v_invoice_number || ' - Accounts Receivable',
          'contact_id', v_ri.contact_id) AS l
        UNION ALL
        SELECT 1, jsonb_build_object(
          'account_id', acct, 'debit', 0, 'credit', amt,
          'description', 'Invoice ' || v_invoice_number || ' - Sales Revenue')
        FROM (
          SELECT COALESCE(
                   public.resolve_product_gl_account(
                     v_ri.organization_id, v_ri.business_id, i.product_id, 'sales_revenue'),
                   v_rev_default) AS acct,
                 ROUND(SUM(i.quantity * i.unit_price * (1 - COALESCE(i.discount_percent,0)/100.0)), 2) AS amt
            FROM public.recurring_invoice_items i
           WHERE i.recurring_invoice_id = _recurring_id
           GROUP BY 1
        ) rev
        UNION ALL
        SELECT 2, jsonb_build_object(
          'account_id', v_tax_account, 'debit', 0, 'credit', v_tax,
          'description', 'Invoice ' || v_invoice_number || ' - Tax Liability')
        WHERE v_tax > 0 AND v_tax_account IS NOT NULL
      ) lines;

      v_confirm := public._confirm_invoice_core(v_invoice_id, _user_id, v_lines, 'sent');
      v_je_id := NULLIF(v_confirm->>'journal_entry_id','')::uuid;

      v_status := 'posted';
    END IF;

    UPDATE public.recurring_invoices
       SET last_run_date = _period_start,
           next_run_date = v_next_start,
           invoices_generated = COALESCE(invoices_generated, 0) + 1,
           updated_at = now()
     WHERE id = _recurring_id;

    -- End-of-schedule closes the template through the lifecycle writer, so the
    -- completion is auditable rather than an unattributed flag flip.
    PERFORM public._recurring_complete_if_finished(_recurring_id, v_next_start);

    IF COALESCE(v_ri.auto_send, false) AND v_status = 'posted' THEN
      v_delivery := 'pending';
      v_delivery_error := NULL;
    ELSIF COALESCE(v_ri.auto_send, false) THEN
      v_delivery := 'blocked';
      v_delivery_error := 'Auto-send is enabled but auto-confirm is off, so the invoice is still a draft and was not emailed. Confirm it manually, or enable auto-confirm on the template.';
    ELSE
      v_delivery := 'not_applicable';
      v_delivery_error := NULL;
    END IF;

    UPDATE public.recurring_invoice_runs
       SET status = v_status, invoice_id = v_invoice_id, invoice_number = v_invoice_number,
           journal_entry_id = v_je_id, failure_reason = NULL,
           definition_version = v_ri.definition_version,
           delivery_status = v_delivery, delivery_error = v_delivery_error,
           delivery_attempt_count = 0,
           next_retry_at = CASE WHEN v_delivery = 'pending' THEN now() ELSE NULL END
     WHERE id = v_run_id;

    RETURN jsonb_build_object(
      'status', v_status, 'duplicate', false, 'run_id', v_run_id,
      'invoice_id', v_invoice_id, 'invoice_number', v_invoice_number,
      'journal_entry_id', v_je_id, 'period_start', _period_start,
      'period_end', v_period_end, 'next_run_date', v_next_start,
      'definition_version', v_ri.definition_version,
      'delivery_status', v_delivery);

  EXCEPTION WHEN OTHERS THEN
    DECLARE v_msg text := SQLERRM;
    BEGIN
      UPDATE public.recurring_invoice_runs
         SET status = 'failed', failure_reason = v_msg, invoice_id = NULL,
             invoice_number = NULL, journal_entry_id = NULL
       WHERE id = v_run_id;
      RETURN jsonb_build_object(
        'status', 'failed', 'duplicate', false, 'run_id', v_run_id,
        'error', v_msg, 'period_start', _period_start, 'period_end', v_period_end);
    END;
  END;
END;
$function$;