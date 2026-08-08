-- 1. Shared confirmation engine ------------------------------------------
CREATE OR REPLACE FUNCTION public._confirm_invoice_core(
  p_invoice_id uuid, p_user_id uuid, p_main_lines jsonb, p_final_status text DEFAULT 'confirmed')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_inv record; v_je_id uuid; v_main_entry_no text;
  v_line_count integer; v_items_subtotal numeric := 0; v_items_tax numeric := 0;
  v_main_debits numeric := 0; v_main_credits numeric := 0;
  v_bad_accounts integer := 0; v_revenue_line_count integer := 0;
  v_ar_line_count integer := 0;
  v_existing_dn_id uuid; v_stockable_count integer := 0;
  v_dn_id uuid; v_dn_number text;
  v_final text := COALESCE(NULLIF(p_final_status, ''), 'confirmed');
BEGIN
  IF v_final NOT IN ('confirmed', 'sent') THEN
    RAISE EXCEPTION 'Invalid post-confirmation status %; expected confirmed or sent', v_final;
  END IF;

  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice % not found', p_invoice_id; END IF;
  IF v_inv.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft invoices can be confirmed (current: %)', v_inv.status;
  END IF;
  IF v_inv.contact_id IS NULL THEN
    RAISE EXCEPTION 'A customer is required to confirm this invoice. Please select a customer and try again.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_inv.business_id IS NULL THEN
    RAISE EXCEPTION 'Invoice % has no business scope', p_invoice_id USING ERRCODE = '42501';
  END IF;
  IF v_inv.journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'Invoice % is already linked to a journal entry', v_inv.invoice_number;
  END IF;

  PERFORM public.assert_contact_in_business(v_inv.contact_id, v_inv.organization_id, v_inv.business_id, 'invoice customer');
  PERFORM public.assert_no_existing_source_posting(v_inv.organization_id, 'invoice', p_invoice_id, NULL);

  IF p_main_lines IS NULL OR jsonb_typeof(p_main_lines) <> 'array' OR jsonb_array_length(p_main_lines) < 2 THEN
    RAISE EXCEPTION 'Invoice JE requires at least 2 lines';
  END IF;

  SELECT COUNT(*), COALESCE(ROUND(SUM(line_total), 2), 0), COALESCE(ROUND(SUM(COALESCE(tax_amount, 0)), 2), 0)
    INTO v_line_count, v_items_subtotal, v_items_tax
  FROM public.invoice_items WHERE invoice_id = p_invoice_id;
  IF v_line_count = 0 THEN RAISE EXCEPTION 'Invoice % has no lines; cannot confirm', v_inv.invoice_number; END IF;
  IF ABS(v_items_subtotal - COALESCE(v_inv.subtotal, 0)) > 0.01
     OR ABS(v_items_tax - COALESCE(v_inv.tax_amount, 0)) > 0.01
     OR ABS(ROUND(v_items_subtotal + v_items_tax - COALESCE(v_inv.discount_amount, 0), 2) - COALESCE(v_inv.total, 0)) > 0.01 THEN
    RAISE EXCEPTION 'Invoice % totals do not match persisted line data', v_inv.invoice_number;
  END IF;

  SELECT
    COALESCE(SUM((l->>'debit')::numeric), 0),
    COALESCE(SUM((l->>'credit')::numeric), 0),
    COUNT(*) FILTER (WHERE a.id IS NULL),
    COUNT(*) FILTER (WHERE a.account_type = 'income' AND (l->>'credit')::numeric > 0),
    COUNT(*) FILTER (WHERE a.account_type = 'asset' AND a.detail_type = 'accounts_receivable' AND (l->>'debit')::numeric > 0)
  INTO v_main_debits, v_main_credits, v_bad_accounts, v_revenue_line_count, v_ar_line_count
  FROM jsonb_array_elements(p_main_lines) l
  LEFT JOIN public.accounts a ON a.id = (l->>'account_id')::uuid
                              AND a.organization_id = v_inv.organization_id
                              AND a.business_id = v_inv.business_id;

  IF v_bad_accounts > 0 THEN RAISE EXCEPTION 'Invoice JE references % accounts not in this business', v_bad_accounts; END IF;
  IF ABS(v_main_debits - v_main_credits) > 0.01 THEN RAISE EXCEPTION 'Invoice JE not balanced: debits % credits %', v_main_debits, v_main_credits; END IF;
  IF v_revenue_line_count = 0 OR v_ar_line_count = 0 THEN RAISE EXCEPTION 'Invoice JE missing required AR or Revenue line'; END IF;

  SELECT public.get_next_journal_entry_number(v_inv.organization_id) INTO v_main_entry_no;
  v_je_id := public.post_journal_entry_atomic(
    _org_id := v_inv.organization_id, _business_id := v_inv.business_id,
    _entry_number := v_main_entry_no, _entry_date := v_inv.issue_date,
    _reference := v_inv.invoice_number, _description := 'Invoice ' || v_inv.invoice_number,
    _source_type := 'invoice', _source_id := p_invoice_id,
    _created_by := p_user_id, _is_closing := false, _is_adjusting := false,
    _lines := p_main_lines, _currency := v_inv.currency,
    _exchange_rate := NULL, _source_subtype := NULL, _branch_id := v_inv.branch_id
  );

  UPDATE public.invoices
    SET status = v_final::invoice_status,
        journal_entry_id = v_je_id,
        confirmed_by = COALESCE(p_user_id, confirmed_by),
        updated_at = now()
   WHERE id = p_invoice_id;

  IF v_inv.source_sales_order_id IS NULL THEN
    SELECT id INTO v_existing_dn_id FROM public.delivery_notes
      WHERE source_invoice_id = p_invoice_id LIMIT 1;

    IF v_existing_dn_id IS NULL THEN
      SELECT COUNT(*) INTO v_stockable_count
        FROM public.invoice_items ii
        JOIN public.products p ON p.id = ii.product_id
       WHERE ii.invoice_id = p_invoice_id
         AND COALESCE(p.track_inventory, true) = true
         AND p.type = 'product'
         AND COALESCE(ii.quantity, 0) > 0;

      IF v_stockable_count > 0 THEN
        v_dn_number := public.get_next_delivery_number(v_inv.organization_id);
        INSERT INTO public.delivery_notes (
          organization_id, business_id, branch_id,
          contact_id, delivery_number, delivery_date, status,
          sales_order_id, source_invoice_id, received_by_contact_id,
          notes, created_by
        ) VALUES (
          v_inv.organization_id, v_inv.business_id, v_inv.branch_id,
          v_inv.contact_id, v_dn_number, v_inv.issue_date, 'pending',
          NULL, p_invoice_id, v_inv.contact_id, NULL, p_user_id
        ) RETURNING id INTO v_dn_id;

        INSERT INTO public.delivery_note_items (
          delivery_note_id, product_id, description,
          quantity_ordered, quantity_delivered, sort_order,
          lot_number, serial_number
        )
        SELECT
          v_dn_id, ii.product_id, ii.description,
          ii.quantity, ii.quantity, COALESCE(ii.sort_order, 0),
          ii.lot_number, ii.serial_number
        FROM public.invoice_items ii
        JOIN public.products p ON p.id = ii.product_id
       WHERE ii.invoice_id = p_invoice_id
         AND COALESCE(p.track_inventory, true) = true
         AND p.type = 'product'
         AND COALESCE(ii.quantity, 0) > 0;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'journal_entry_id', v_je_id,
    'invoice_status', v_final,
    'delivery_note_id', v_dn_id,
    'delivery_number', v_dn_number,
    'auto_delivery_created', v_dn_id IS NOT NULL
  );
END;
$function$;

REVOKE ALL ON FUNCTION public._confirm_invoice_core(uuid, uuid, jsonb, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._confirm_invoice_core(uuid, uuid, jsonb, text) TO service_role;

-- 2. Interactive wrapper: identity + access gate, then the shared engine ---
CREATE OR REPLACE FUNCTION public.confirm_invoice_atomic(
  p_invoice_id uuid, p_user_id uuid, p_main_lines jsonb, p_final_status text DEFAULT 'confirmed')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_business_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE = '42501'; END IF;

  SELECT business_id INTO v_business_id FROM public.invoices WHERE id = p_invoice_id;
  IF v_business_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_business_id USING ERRCODE = '42501';
  END IF;

  RETURN public._confirm_invoice_core(p_invoice_id, p_user_id, p_main_lines, p_final_status);
END;
$function$;

-- 3. Delivery retry gets its own counters, and a "blocked" outcome ---------
ALTER TABLE public.recurring_invoice_runs
  ADD COLUMN IF NOT EXISTS delivery_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;

ALTER TABLE public.recurring_invoice_runs
  DROP CONSTRAINT IF EXISTS recurring_invoice_runs_delivery_status_check;
ALTER TABLE public.recurring_invoice_runs
  ADD CONSTRAINT recurring_invoice_runs_delivery_status_check
  CHECK (delivery_status = ANY (ARRAY['pending','not_applicable','queued','sent','failed','blocked']));

CREATE INDEX IF NOT EXISTS recurring_invoice_runs_delivery_due_idx
  ON public.recurring_invoice_runs (delivery_status, next_retry_at)
  WHERE delivery_status = 'pending';

-- 4. Recurring engine: one posting writer, honest delivery outcome --------
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
    -- Due date is anchored on the invoice issue date, which for a recurring
    -- occurrence is the first day of the billing period.
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

      -- Single posting writer: the same engine a manual confirmation uses.
      v_confirm := public._confirm_invoice_core(v_invoice_id, _user_id, v_lines, 'sent');
      v_je_id := NULLIF(v_confirm->>'journal_entry_id','')::uuid;

      v_status := 'posted';
    END IF;

    UPDATE public.recurring_invoices
       SET last_run_date = _period_start,
           next_run_date = v_next_start,
           invoices_generated = COALESCE(invoices_generated, 0) + 1,
           is_active = CASE WHEN end_date IS NOT NULL AND v_next_start > end_date THEN false ELSE is_active END,
           completed_at = CASE WHEN end_date IS NOT NULL AND v_next_start > end_date THEN now() ELSE completed_at END,
           updated_at = now()
     WHERE id = _recurring_id;

    UPDATE public.recurring_invoice_runs
       SET period_end = v_period_end
     WHERE id = v_run_id;

    -- Auto-send is only meaningful once the invoice is a real, posted
    -- receivable. Asking for it without auto-confirm is a misconfiguration,
    -- and it is recorded as one instead of silently doing nothing.
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
           delivery_status = v_delivery, delivery_error = v_delivery_error,
           delivery_attempt_count = 0,
           next_retry_at = CASE WHEN v_delivery = 'pending' THEN now() ELSE NULL END
     WHERE id = v_run_id;

    RETURN jsonb_build_object(
      'status', v_status, 'duplicate', false, 'run_id', v_run_id,
      'invoice_id', v_invoice_id, 'invoice_number', v_invoice_number,
      'journal_entry_id', v_je_id, 'period_start', _period_start,
      'period_end', v_period_end, 'next_run_date', v_next_start,
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