-- RESTORE + FIX: _confirm_invoice_core
-- (a) restores the full body (the previous migration in this session replaced it
--     with a stub by mistake);
-- (b) carries the customer's selling unit onto the auto-created delivery note.
--     Previously only the BASE quantity was copied, so an invoice reading
--     "2 x 50 Kg Bag" produced a delivery note reading "100 KG".

CREATE OR REPLACE FUNCTION public._confirm_invoice_core(p_invoice_id uuid, p_user_id uuid, p_main_lines jsonb DEFAULT NULL::jsonb, p_final_status text DEFAULT 'confirmed'::text)
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
  v_lines jsonb;
BEGIN
  IF v_final NOT IN ('confirmed', 'sent') THEN
    RAISE EXCEPTION 'Invalid post-confirmation status %; expected confirmed or sent', v_final;
  END IF;

  IF p_main_lines IS NOT NULL AND jsonb_typeof(p_main_lines) = 'array'
     AND jsonb_array_length(p_main_lines) > 0 THEN
    RAISE EXCEPTION 'Client-supplied journal lines are no longer accepted; invoice GL accounts are resolved on the server'
      USING ERRCODE = '42501';
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

  SELECT COUNT(*), COALESCE(ROUND(SUM(line_total), 2), 0), COALESCE(ROUND(SUM(COALESCE(tax_amount, 0)), 2), 0)
    INTO v_line_count, v_items_subtotal, v_items_tax
  FROM public.invoice_items WHERE invoice_id = p_invoice_id;
  IF v_line_count = 0 THEN RAISE EXCEPTION 'Invoice % has no lines; cannot confirm', v_inv.invoice_number; END IF;
  IF ABS(v_items_subtotal - COALESCE(v_inv.subtotal, 0)) > 0.01
     OR ABS(v_items_tax - COALESCE(v_inv.tax_amount, 0)) > 0.01
     OR ABS(ROUND(v_items_subtotal + v_items_tax - COALESCE(v_inv.discount_amount, 0), 2) - COALESCE(v_inv.total, 0)) > 0.01 THEN
    RAISE EXCEPTION 'Invoice % totals do not match persisted line data', v_inv.invoice_number;
  END IF;

  v_lines := public.build_invoice_je_lines(p_invoice_id);

  IF v_lines IS NULL OR jsonb_array_length(v_lines) < 2 THEN
    RAISE EXCEPTION 'Invoice JE requires at least 2 lines';
  END IF;

  SELECT
    COALESCE(SUM((l->>'debit')::numeric), 0),
    COALESCE(SUM((l->>'credit')::numeric), 0),
    COUNT(*) FILTER (WHERE a.id IS NULL),
    COUNT(*) FILTER (WHERE a.account_type = 'income' AND (l->>'credit')::numeric > 0),
    COUNT(*) FILTER (WHERE a.account_type = 'asset' AND a.detail_type = 'accounts_receivable' AND (l->>'debit')::numeric > 0)
  INTO v_main_debits, v_main_credits, v_bad_accounts, v_revenue_line_count, v_ar_line_count
  FROM jsonb_array_elements(v_lines) l
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
    _lines := v_lines, _currency := v_inv.currency,
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

        -- Pack provenance travels with the line: the warehouse picks, and the
        -- customer signs for, the same unit the invoice quoted.
        INSERT INTO public.delivery_note_items (
          delivery_note_id, product_id, description,
          quantity_ordered, quantity_delivered, sort_order,
          lot_number, serial_number,
          packaging_id, display_uom_id, display_quantity, uom_snapshot
        )
        SELECT
          v_dn_id, ii.product_id, ii.description,
          ii.quantity, ii.quantity, COALESCE(ii.sort_order, 0),
          ii.lot_number, ii.serial_number,
          ii.packaging_id, ii.display_uom_id, ii.display_quantity, ii.uom_snapshot
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