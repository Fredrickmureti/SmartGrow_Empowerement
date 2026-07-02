-- Stage 1: confirm_invoice_atomic auto-creates draft Delivery Note
CREATE OR REPLACE FUNCTION public.confirm_invoice_atomic(
  p_invoice_id uuid,
  p_user_id uuid,
  p_main_lines jsonb,
  p_cogs_lines jsonb DEFAULT NULL::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_inv record;
  v_je_id uuid;
  v_cogs_je_id uuid;
  v_main_entry_no text;
  v_cogs_entry_no text;
  v_line_count integer;
  v_items_subtotal numeric := 0;
  v_items_tax numeric := 0;
  v_main_debits numeric := 0;
  v_main_credits numeric := 0;
  v_ar_debit numeric := 0;
  v_revenue_credit numeric := 0;
  v_tax_credit numeric := 0;
  v_cogs_debits numeric := 0;
  v_cogs_credits numeric := 0;
  v_bad_accounts integer := 0;
  v_bad_contacts integer := 0;
  v_revenue_line_count integer := 0;
  v_ar_line_count integer := 0;
  v_existing_dn_id uuid;
  v_stockable_count integer := 0;
  v_dn_id uuid;
  v_dn_number text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice % not found', p_invoice_id; END IF;
  IF v_inv.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft invoices can be confirmed (current: %)', v_inv.status;
  END IF;
  IF v_inv.business_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_inv.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_inv.business_id USING ERRCODE = '42501';
  END IF;
  IF v_inv.journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'Invoice % is already linked to a journal entry', v_inv.invoice_number;
  END IF;

  PERFORM public.assert_contact_in_business(v_inv.contact_id, v_inv.organization_id, v_inv.business_id, 'invoice customer');
  PERFORM public.assert_no_existing_source_posting(v_inv.organization_id, 'invoice', p_invoice_id, NULL);
  IF p_cogs_lines IS NOT NULL AND jsonb_array_length(p_cogs_lines) >= 2 THEN
    PERFORM public.assert_no_existing_source_posting(v_inv.organization_id, 'invoice', p_invoice_id, 'cogs');
  END IF;

  IF p_main_lines IS NULL OR jsonb_typeof(p_main_lines) <> 'array' OR jsonb_array_length(p_main_lines) < 2 THEN
    RAISE EXCEPTION 'Invoice JE requires at least 2 lines';
  END IF;

  SELECT COUNT(*), COALESCE(ROUND(SUM(line_total), 2), 0), COALESCE(ROUND(SUM(COALESCE(tax_amount, 0)), 2), 0)
    INTO v_line_count, v_items_subtotal, v_items_tax
  FROM public.invoice_items WHERE invoice_id = p_invoice_id;
  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'Invoice % has no lines; cannot confirm', v_inv.invoice_number;
  END IF;
  IF ABS(v_items_subtotal - COALESCE(v_inv.subtotal, 0)) > 0.01
     OR ABS(v_items_tax - COALESCE(v_inv.tax_amount, 0)) > 0.01
     OR ABS(ROUND(v_items_subtotal + v_items_tax - COALESCE(v_inv.discount_amount, 0), 2) - COALESCE(v_inv.total, 0)) > 0.01 THEN
    RAISE EXCEPTION 'Invoice % totals do not match persisted line data', v_inv.invoice_number;
  END IF;

  WITH lines AS (
    SELECT * FROM jsonb_to_recordset(p_main_lines) AS l(account_id uuid, debit numeric, credit numeric, contact_id uuid)
  ),
  classified AS (
    SELECT
      l.*,
      a.account_type, a.detail_type, a.name,
      a.organization_id AS a_org, a.business_id AS a_biz, a.is_active AS a_active,
      (a.account_type = 'asset'
        AND (a.detail_type = 'accounts_receivable' OR lower(a.name) ~ 'receivable|debtor')
      ) AS is_ar,
      (a.account_type = 'income'
        OR a.detail_type IN ('sales_income','service_income','revenue_general','sales_revenue','revenue','income','interest_income','rental_income','other_income')
      ) AS is_revenue,
      (a.detail_type IN ('sales_tax_payable','tax_payable','sales_tax','output_tax')
        OR (a.account_type = 'liability' AND lower(a.name) ~ 'tax|vat')
      ) AS is_tax,
      l.contact_id AS l_contact_id,
      c.id AS c_id, c.organization_id AS c_org, c.business_id AS c_biz
    FROM lines l
    LEFT JOIN public.accounts a ON a.id = l.account_id
    LEFT JOIN public.contacts c ON c.id = l.contact_id
  )
  SELECT
    COALESCE(SUM(debit), 0),
    COALESCE(SUM(credit), 0),
    COALESCE(SUM(CASE WHEN is_ar THEN debit ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN is_revenue THEN credit ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN is_tax THEN credit ELSE 0 END), 0),
    COUNT(*) FILTER (WHERE account_type IS NULL OR a_org IS DISTINCT FROM v_inv.organization_id OR a_biz IS DISTINCT FROM v_inv.business_id OR COALESCE(a_active, true) = false),
    COUNT(*) FILTER (WHERE l_contact_id IS NOT NULL AND (c_id IS NULL OR c_org IS DISTINCT FROM v_inv.organization_id OR (c_biz IS NOT NULL AND c_biz IS DISTINCT FROM v_inv.business_id))),
    COUNT(*) FILTER (WHERE is_revenue AND COALESCE(credit, 0) > 0),
    COUNT(*) FILTER (WHERE is_ar AND COALESCE(debit, 0) > 0)
  INTO v_main_debits, v_main_credits, v_ar_debit, v_revenue_credit, v_tax_credit,
       v_bad_accounts, v_bad_contacts, v_revenue_line_count, v_ar_line_count
  FROM classified;

  IF v_bad_accounts > 0 THEN
    RAISE EXCEPTION 'Invoice posting lines contain accounts outside the invoice company or inactive accounts';
  END IF;
  IF v_bad_contacts > 0 THEN
    RAISE EXCEPTION 'Invoice posting lines contain contacts outside the invoice company';
  END IF;
  IF ABS(v_main_debits - v_main_credits) > 0.01 THEN
    RAISE EXCEPTION 'Invoice journal entry is not balanced: debits=%, credits=%', v_main_debits, v_main_credits;
  END IF;
  IF v_ar_line_count = 0 THEN
    RAISE EXCEPTION 'Invoice JE must contain an Accounts Receivable debit line. The default AR mapping points to a non-receivable account — fix it in Settings > Default Accounts.';
  END IF;
  IF v_revenue_line_count = 0 THEN
    RAISE EXCEPTION 'Invoice JE must contain at least one income (revenue) credit line.';
  END IF;
  IF ABS(v_ar_debit - v_inv.total) > 0.01 THEN
    RAISE EXCEPTION 'Invoice AR debit must equal invoice total (got %, expected %)', v_ar_debit, v_inv.total;
  END IF;
  IF ABS(v_revenue_credit - v_inv.subtotal) > 0.01 THEN
    RAISE EXCEPTION 'Invoice revenue credits must equal invoice subtotal';
  END IF;
  IF COALESCE(v_inv.tax_amount, 0) > 0 AND ABS(v_tax_credit - v_inv.tax_amount) > 0.01 THEN
    RAISE EXCEPTION 'Invoice tax credits must equal invoice tax amount';
  END IF;

  IF p_cogs_lines IS NOT NULL AND jsonb_array_length(p_cogs_lines) >= 2 THEN
    WITH cogs AS (
      SELECT * FROM jsonb_to_recordset(p_cogs_lines) AS l(account_id uuid, debit numeric, credit numeric)
    )
    SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0),
           COUNT(*) FILTER (WHERE a.id IS NULL OR a.organization_id IS DISTINCT FROM v_inv.organization_id OR a.business_id IS DISTINCT FROM v_inv.business_id OR COALESCE(a.is_active, true) = false)
      INTO v_cogs_debits, v_cogs_credits, v_bad_accounts
    FROM cogs l LEFT JOIN public.accounts a ON a.id = l.account_id;
    IF v_bad_accounts > 0 THEN
      RAISE EXCEPTION 'Invoice COGS lines contain accounts outside the invoice company or inactive accounts';
    END IF;
    IF ABS(v_cogs_debits - v_cogs_credits) > 0.01 THEN
      RAISE EXCEPTION 'Invoice COGS journal entry is not balanced';
    END IF;
  END IF;

  SELECT public.get_next_journal_entry_number(v_inv.organization_id) INTO v_main_entry_no;

  v_je_id := public.post_journal_entry_atomic(
    _org_id := v_inv.organization_id, _business_id := v_inv.business_id,
    _entry_number := v_main_entry_no, _entry_date := v_inv.issue_date,
    _reference := v_inv.invoice_number,
    _description := 'Invoice ' || v_inv.invoice_number || ' confirmed',
    _source_type := 'invoice', _source_id := p_invoice_id,
    _created_by := p_user_id, _is_closing := false, _is_adjusting := false,
    _lines := p_main_lines, _currency := v_inv.currency,
    _exchange_rate := NULL, _source_subtype := NULL, _branch_id := v_inv.branch_id
  );

  IF p_cogs_lines IS NOT NULL AND jsonb_array_length(p_cogs_lines) >= 2 THEN
    SELECT public.get_next_journal_entry_number(v_inv.organization_id) INTO v_cogs_entry_no;
    v_cogs_je_id := public.post_journal_entry_atomic(
      _org_id := v_inv.organization_id, _business_id := v_inv.business_id,
      _entry_number := v_cogs_entry_no, _entry_date := v_inv.issue_date,
      _reference := 'COGS-' || v_inv.invoice_number,
      _description := 'COGS for Invoice ' || v_inv.invoice_number,
      _source_type := 'invoice', _source_id := p_invoice_id,
      _created_by := p_user_id, _is_closing := false, _is_adjusting := false,
      _lines := p_cogs_lines, _currency := v_inv.currency,
      _exchange_rate := NULL, _source_subtype := 'cogs', _branch_id := v_inv.branch_id
    );
  END IF;

  UPDATE public.invoices
  SET status = 'confirmed', journal_entry_id = v_je_id, updated_at = now()
  WHERE id = p_invoice_id;

  -- Auto-create draft Delivery Note for stockable invoice lines
  -- Skip if invoice originated from an SO (DN flow goes via SO already)
  IF v_inv.source_sales_order_id IS NULL THEN
    SELECT id INTO v_existing_dn_id
      FROM public.delivery_notes
     WHERE organization_id = v_inv.organization_id
       AND business_id = v_inv.business_id
       AND notes IS NOT NULL
       AND notes LIKE '%[auto-from-invoice:' || p_invoice_id::text || ']%'
     LIMIT 1;

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
          sales_order_id, notes, created_by
        ) VALUES (
          v_inv.organization_id, v_inv.business_id, v_inv.branch_id,
          v_inv.contact_id, v_dn_number, v_inv.issue_date, 'pending',
          NULL,
          'Auto-created from invoice ' || v_inv.invoice_number ||
          ' [auto-from-invoice:' || p_invoice_id::text || ']',
          p_user_id
        )
        RETURNING id INTO v_dn_id;

        INSERT INTO public.delivery_note_items (
          delivery_note_id, product_id, description,
          quantity_ordered, quantity_delivered, sort_order
        )
        SELECT
          v_dn_id, ii.product_id, ii.description,
          ii.quantity, ii.quantity, COALESCE(ii.sort_order, 0)
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
    'cogs_journal_entry_id', v_cogs_je_id,
    'delivery_note_id', v_dn_id,
    'delivery_number', v_dn_number,
    'auto_delivery_created', v_dn_id IS NOT NULL
  );
END;
$function$;

-- Helper: get_invoice_delivery_status
CREATE OR REPLACE FUNCTION public.get_invoice_delivery_status(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
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
       (dn.notes IS NOT NULL AND dn.notes LIKE '%[auto-from-invoice:' || p_invoice_id::text || ']%')
       OR (v_inv.source_sales_order_id IS NOT NULL AND dn.sales_order_id = v_inv.source_sales_order_id)
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

GRANT EXECUTE ON FUNCTION public.get_invoice_delivery_status(uuid) TO authenticated;

-- Backfill: create pending DNs for already-confirmed invoices with stockable
-- lines and no SO link / no existing DN.
DO $backfill$
DECLARE
  v_inv record;
  v_dn_id uuid;
  v_dn_number text;
  v_stockable_count integer;
  v_existing_dn uuid;
BEGIN
  FOR v_inv IN
    SELECT i.id, i.organization_id, i.business_id, i.branch_id,
           i.contact_id, i.invoice_number, i.issue_date, i.created_by,
           i.source_sales_order_id
      FROM public.invoices i
     WHERE i.status::text IN ('confirmed','partial','paid')
       AND i.source_sales_order_id IS NULL
  LOOP
    SELECT COUNT(*) INTO v_stockable_count
      FROM public.invoice_items ii
      JOIN public.products p ON p.id = ii.product_id
     WHERE ii.invoice_id = v_inv.id
       AND COALESCE(p.track_inventory, true) = true
       AND p.type = 'product'
       AND COALESCE(ii.quantity, 0) > 0;

    IF v_stockable_count = 0 THEN CONTINUE; END IF;

    SELECT id INTO v_existing_dn
      FROM public.delivery_notes
     WHERE organization_id = v_inv.organization_id
       AND business_id = v_inv.business_id
       AND notes IS NOT NULL
       AND notes LIKE '%[auto-from-invoice:' || v_inv.id::text || ']%'
     LIMIT 1;
    IF v_existing_dn IS NOT NULL THEN CONTINUE; END IF;

    v_dn_number := public.get_next_delivery_number(v_inv.organization_id);

    INSERT INTO public.delivery_notes (
      organization_id, business_id, branch_id,
      contact_id, delivery_number, delivery_date, status,
      sales_order_id, notes, created_by
    ) VALUES (
      v_inv.organization_id, v_inv.business_id, v_inv.branch_id,
      v_inv.contact_id, v_dn_number, v_inv.issue_date, 'pending',
      NULL,
      'Auto-created from invoice ' || v_inv.invoice_number ||
      ' (backfill) [auto-from-invoice:' || v_inv.id::text || ']',
      v_inv.created_by
    )
    RETURNING id INTO v_dn_id;

    INSERT INTO public.delivery_note_items (
      delivery_note_id, product_id, description,
      quantity_ordered, quantity_delivered, sort_order
    )
    SELECT
      v_dn_id, ii.product_id, ii.description,
      ii.quantity, ii.quantity, COALESCE(ii.sort_order, 0)
    FROM public.invoice_items ii
    JOIN public.products p ON p.id = ii.product_id
   WHERE ii.invoice_id = v_inv.id
     AND COALESCE(p.track_inventory, true) = true
     AND p.type = 'product'
     AND COALESCE(ii.quantity, 0) > 0;
  END LOOP;
END
$backfill$;