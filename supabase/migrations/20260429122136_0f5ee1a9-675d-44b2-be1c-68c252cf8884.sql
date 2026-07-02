
-- =====================================================================
-- Sales module hardening migration
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. confirm_credit_note_atomic
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_credit_note_atomic(
  p_cn_id uuid,
  p_user_id uuid,
  p_main_lines jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cn record;
  v_je_id uuid;
  v_je_no text;
  v_debits numeric := 0;
  v_credits numeric := 0;
  v_bad_accounts integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_cn FROM public.credit_notes WHERE id = p_cn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Credit note % not found', p_cn_id; END IF;
  IF v_cn.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft credit notes can be issued (current: %)', v_cn.status;
  END IF;
  IF v_cn.business_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_cn.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_cn.business_id USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_no_existing_source_posting(v_cn.organization_id, 'credit_note', p_cn_id, NULL);

  IF p_main_lines IS NULL OR jsonb_typeof(p_main_lines) <> 'array' OR jsonb_array_length(p_main_lines) < 2 THEN
    RAISE EXCEPTION 'Credit note JE requires at least 2 lines';
  END IF;

  -- Validate accounts belong to this org+business and are active
  WITH lines AS (
    SELECT * FROM jsonb_to_recordset(p_main_lines) AS l(account_id uuid, debit numeric, credit numeric)
  )
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0),
         COUNT(*) FILTER (WHERE a.id IS NULL
                            OR a.organization_id IS DISTINCT FROM v_cn.organization_id
                            OR a.business_id IS DISTINCT FROM v_cn.business_id
                            OR COALESCE(a.is_active, true) = false)
    INTO v_debits, v_credits, v_bad_accounts
  FROM lines l LEFT JOIN public.accounts a ON a.id = l.account_id;

  IF v_bad_accounts > 0 THEN
    RAISE EXCEPTION 'Credit note posting lines contain accounts outside the credit note company or inactive accounts';
  END IF;
  IF ABS(v_debits - v_credits) > 0.01 THEN
    RAISE EXCEPTION 'Credit note JE not balanced: debits=%, credits=%', v_debits, v_credits;
  END IF;
  IF ABS(v_debits - v_cn.total) > 0.01 THEN
    RAISE EXCEPTION 'Credit note JE total (%) must equal credit note total (%)', v_debits, v_cn.total;
  END IF;

  SELECT public.get_next_journal_entry_number(v_cn.organization_id) INTO v_je_no;

  v_je_id := public.post_journal_entry_atomic(
    _org_id := v_cn.organization_id,
    _business_id := v_cn.business_id,
    _entry_number := v_je_no,
    _entry_date := v_cn.issue_date,
    _reference := v_cn.credit_note_number,
    _description := 'Credit Note ' || v_cn.credit_note_number || ' issued',
    _source_type := 'credit_note',
    _source_id := p_cn_id,
    _created_by := p_user_id,
    _is_closing := false,
    _is_adjusting := false,
    _lines := p_main_lines,
    _currency := v_cn.currency,
    _exchange_rate := NULL,
    _source_subtype := NULL,
    _branch_id := v_cn.branch_id
  );

  UPDATE public.credit_notes
     SET status = 'issued'::credit_note_status,
         updated_at = now()
   WHERE id = p_cn_id;

  RETURN jsonb_build_object('success', true, 'journal_entry_id', v_je_id);
END;
$$;

-- ---------------------------------------------------------------------
-- 2. process_refund_atomic
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_refund_atomic(
  p_cn_id uuid,
  p_user_id uuid,
  p_amount numeric,
  p_method text,
  p_payment_account_id uuid,
  p_notes text,
  p_main_lines jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cn record;
  v_available numeric;
  v_je_id uuid;
  v_je_no text;
  v_debits numeric := 0;
  v_credits numeric := 0;
  v_bad_accounts integer := 0;
  v_new_refund numeric;
  v_total_used numeric;
  v_new_status text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Refund amount must be positive';
  END IF;

  SELECT * INTO v_cn FROM public.credit_notes WHERE id = p_cn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Credit note % not found', p_cn_id; END IF;
  IF v_cn.business_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_cn.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_cn.business_id USING ERRCODE = '42501';
  END IF;
  IF v_cn.status NOT IN ('issued','applied') THEN
    RAISE EXCEPTION 'Only issued or partially applied credit notes can be refunded (current: %)', v_cn.status;
  END IF;

  v_available := v_cn.total - COALESCE(v_cn.amount_applied, 0) - COALESCE(v_cn.refund_amount, 0);
  IF p_amount > v_available + 0.01 THEN
    RAISE EXCEPTION 'Refund amount (%) exceeds available residual (%)', p_amount, v_available;
  END IF;

  -- Validate JE
  IF p_main_lines IS NULL OR jsonb_typeof(p_main_lines) <> 'array' OR jsonb_array_length(p_main_lines) < 2 THEN
    RAISE EXCEPTION 'Refund JE requires at least 2 lines';
  END IF;
  WITH lines AS (
    SELECT * FROM jsonb_to_recordset(p_main_lines) AS l(account_id uuid, debit numeric, credit numeric)
  )
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0),
         COUNT(*) FILTER (WHERE a.id IS NULL
                            OR a.organization_id IS DISTINCT FROM v_cn.organization_id
                            OR a.business_id IS DISTINCT FROM v_cn.business_id
                            OR COALESCE(a.is_active, true) = false)
    INTO v_debits, v_credits, v_bad_accounts
  FROM lines l LEFT JOIN public.accounts a ON a.id = l.account_id;

  IF v_bad_accounts > 0 THEN
    RAISE EXCEPTION 'Refund posting lines contain accounts outside the credit note company or inactive accounts';
  END IF;
  IF ABS(v_debits - v_credits) > 0.01 THEN
    RAISE EXCEPTION 'Refund JE not balanced: debits=%, credits=%', v_debits, v_credits;
  END IF;
  IF ABS(v_debits - p_amount) > 0.01 THEN
    RAISE EXCEPTION 'Refund JE total (%) must equal refund amount (%)', v_debits, p_amount;
  END IF;

  SELECT public.get_next_journal_entry_number(v_cn.organization_id) INTO v_je_no;

  v_je_id := public.post_journal_entry_atomic(
    _org_id := v_cn.organization_id,
    _business_id := v_cn.business_id,
    _entry_number := v_je_no,
    _entry_date := CURRENT_DATE,
    _reference := 'REF-' || v_cn.credit_note_number,
    _description := 'Refund of credit note ' || v_cn.credit_note_number,
    _source_type := 'credit_note',
    _source_id := p_cn_id,
    _created_by := p_user_id,
    _is_closing := false,
    _is_adjusting := false,
    _lines := p_main_lines,
    _currency := v_cn.currency,
    _exchange_rate := NULL,
    _source_subtype := 'refund',
    _branch_id := v_cn.branch_id
  );

  v_new_refund := COALESCE(v_cn.refund_amount, 0) + p_amount;
  v_total_used := COALESCE(v_cn.amount_applied, 0) + v_new_refund;
  IF v_total_used >= v_cn.total - 0.01 THEN
    v_new_status := CASE WHEN v_new_refund > 0 THEN 'refunded' ELSE 'applied' END;
  ELSE
    v_new_status := v_cn.status::text;
  END IF;

  UPDATE public.credit_notes
     SET refund_amount = v_new_refund,
         refund_date = CURRENT_DATE,
         refund_method = p_method,
         status = v_new_status::credit_note_status,
         notes = CASE WHEN p_notes IS NOT NULL AND length(p_notes) > 0
                      THEN COALESCE(notes || E'\n', '') || 'Refund: ' || p_notes
                      ELSE notes END,
         updated_at = now()
   WHERE id = p_cn_id;

  RETURN jsonb_build_object(
    'success', true,
    'journal_entry_id', v_je_id,
    'new_status', v_new_status,
    'refund_amount', v_new_refund
  );
END;
$$;

-- ---------------------------------------------------------------------
-- 3. convert_proforma_to_invoice_atomic
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.convert_proforma_to_invoice_atomic(
  p_proforma_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pf RECORD;
  v_inv_number text;
  v_inv_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_pf FROM public.proforma_invoices WHERE id = p_proforma_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proforma % not found', p_proforma_id; END IF;
  IF v_pf.converted_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'Proforma % already converted to invoice %', v_pf.proforma_number, v_pf.converted_invoice_id;
  END IF;
  IF v_pf.status NOT IN ('draft','sent','viewed','accepted','approved') THEN
    RAISE EXCEPTION 'Cannot convert proforma in status %', v_pf.status;
  END IF;
  IF v_pf.business_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_pf.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_pf.business_id USING ERRCODE = '42501';
  END IF;

  SELECT public.get_next_invoice_number(v_pf.organization_id, v_pf.business_id) INTO v_inv_number;

  INSERT INTO public.invoices(
    organization_id, business_id, branch_id, contact_id,
    invoice_number, status, issue_date, due_date,
    subtotal, tax_amount, discount_amount, total, currency,
    notes, terms, created_by,
    source_proforma_invoice_id
  ) VALUES (
    v_pf.organization_id, v_pf.business_id, v_pf.branch_id, v_pf.contact_id,
    v_inv_number, 'draft', CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
    v_pf.subtotal, v_pf.tax_amount, COALESCE(v_pf.discount_amount, 0), v_pf.total, v_pf.currency,
    v_pf.notes, v_pf.terms, p_user_id,
    p_proforma_id
  )
  RETURNING id INTO v_inv_id;

  INSERT INTO public.invoice_items(
    invoice_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order
  )
  SELECT
    v_inv_id, pi.product_id, pi.description, pi.quantity, pi.unit_price,
    COALESCE(pi.tax_rate, 0), COALESCE(pi.tax_amount, 0),
    COALESCE(pi.discount_percent, 0), pi.line_total, pi.sort_order
  FROM public.proforma_invoice_items pi
  WHERE pi.proforma_invoice_id = p_proforma_id;

  UPDATE public.proforma_invoices
     SET status = 'converted',
         converted_invoice_id = v_inv_id,
         converted_at = now(),
         updated_at = now()
   WHERE id = p_proforma_id;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', v_inv_id,
    'invoice_number', v_inv_number
  );
END;
$$;

-- ---------------------------------------------------------------------
-- 4. approve_sales_return_atomic — branch-aware warehouse selection
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_sales_return_atomic(
  p_return_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_return RECORD;
  v_cn_number text;
  v_cn_id uuid;
  v_warehouse_id uuid;
  v_item RECORD;
  v_inventory_count integer := 0;
BEGIN
  SELECT * INTO v_return
  FROM public.sales_returns
  WHERE id = p_return_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales return % not found', p_return_id;
  END IF;
  IF v_return.status <> 'pending' THEN
    RAISE EXCEPTION 'Only pending sales returns can be approved (current: %)', v_return.status;
  END IF;

  IF NOT public.user_can_access_business(p_user_id, v_return.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_return.business_id;
  END IF;

  SELECT public.get_next_credit_note_number(v_return.organization_id) INTO v_cn_number;

  INSERT INTO public.credit_notes(
    organization_id, business_id, branch_id,
    credit_note_number, contact_id, invoice_id, issue_date, status,
    reason, subtotal, tax_amount, total, currency, notes,
    created_by, source_return_id
  ) VALUES (
    v_return.organization_id,
    v_return.business_id,
    v_return.branch_id,
    v_cn_number,
    v_return.contact_id,
    v_return.invoice_id,
    CURRENT_DATE,
    'draft',
    v_return.reason,
    v_return.subtotal,
    v_return.tax_amount,
    v_return.total,
    v_return.currency,
    'Auto-created from Sales Return ' || v_return.return_number,
    p_user_id,
    v_return.id
  )
  RETURNING id INTO v_cn_id;

  INSERT INTO public.credit_note_items(
    credit_note_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, line_total, sort_order
  )
  SELECT
    v_cn_id, sri.product_id, sri.description, sri.quantity, sri.unit_price,
    COALESCE(sri.tax_rate,0), COALESCE(sri.tax_amount,0), sri.line_total, sri.sort_order
  FROM public.sales_return_items sri
  WHERE sri.sales_return_id = p_return_id;

  -- Restore stock for inventory items (branch-aware warehouse selection)
  SELECT COUNT(*) INTO v_inventory_count
  FROM public.sales_return_items sri
  WHERE sri.sales_return_id = p_return_id AND sri.product_id IS NOT NULL;

  IF v_inventory_count > 0 THEN
    -- Pick a warehouse in the return's branch (matches complete_delivery_atomic)
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

    FOR v_item IN
      SELECT product_id, quantity
      FROM public.sales_return_items
      WHERE sales_return_id = p_return_id AND product_id IS NOT NULL
    LOOP
      INSERT INTO public.stock_movements(
        organization_id, business_id, branch_id, product_id, movement_type,
        quantity, reference_type, reference_id, warehouse_id, notes
      ) VALUES (
        v_return.organization_id,
        v_return.business_id,
        v_return.branch_id,
        v_item.product_id,
        'return_in',
        v_item.quantity,
        'sales_return',
        p_return_id,
        v_warehouse_id,
        'Sales return ' || v_return.return_number || ' approved - stock restored'
      );
    END LOOP;
  END IF;

  UPDATE public.sales_returns
  SET status = 'approved',
      credit_note_id = v_cn_id,
      updated_at = now()
  WHERE id = p_return_id;

  RETURN jsonb_build_object(
    'success', true,
    'credit_note_id', v_cn_id,
    'credit_note_number', v_cn_number
  );
END;
$$;

-- ---------------------------------------------------------------------
-- 5. recurring_invoices.auto_confirm
-- ---------------------------------------------------------------------
ALTER TABLE public.recurring_invoices
  ADD COLUMN IF NOT EXISTS auto_confirm boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.recurring_invoices.auto_confirm IS
  'When true, invoices generated from this template are automatically confirmed (GL posted) instead of staying in draft.';
