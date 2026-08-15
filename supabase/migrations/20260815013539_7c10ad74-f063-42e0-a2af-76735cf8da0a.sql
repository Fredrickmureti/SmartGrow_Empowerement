-- Phase 6.1: server-authoritative GL resolution for invoice confirmation.

CREATE OR REPLACE FUNCTION public.build_invoice_je_lines(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_inv record;
  v_ar_account uuid;
  v_tax_account uuid;
  v_discount_account uuid;
  v_default_revenue uuid;
  v_lines jsonb := '[]'::jsonb;
  v_rev record;
  v_unmapped integer := 0;
  v_discount numeric;
BEGIN
  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % not found', p_invoice_id;
  END IF;
  IF v_inv.business_id IS NULL THEN
    RAISE EXCEPTION 'Invoice % has no business scope', p_invoice_id USING ERRCODE = '42501';
  END IF;

  -- 1. Receivable: customer override wins over the canonical default.
  SELECT c.default_receivable_account_id INTO v_ar_account
    FROM public.contacts c WHERE c.id = v_inv.contact_id;

  IF v_ar_account IS NOT NULL
     AND NOT public._account_is_postable(v_inv.organization_id, v_inv.business_id, v_ar_account) THEN
    v_ar_account := NULL;
  END IF;

  IF v_ar_account IS NULL THEN
    v_ar_account := public._resolve_canonical_default_account(
      'accounts_receivable', v_inv.organization_id, v_inv.business_id, v_inv.branch_id);
  END IF;

  IF v_ar_account IS NULL THEN
    RAISE EXCEPTION 'No Accounts Receivable account is mapped for this business. Map it in Settings > Default Accounts.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_default_revenue := public._resolve_canonical_default_account(
    'sales_revenue', v_inv.organization_id, v_inv.business_id, v_inv.branch_id);

  -- 2. AR debit for the gross total.
  v_lines := v_lines || jsonb_build_object(
    'account_id', v_ar_account,
    'debit', ROUND(COALESCE(v_inv.total, 0), 2),
    'credit', 0,
    'description', 'Invoice ' || v_inv.invoice_number || ' - Accounts Receivable',
    'contact_id', v_inv.contact_id
  );

  -- 3. Revenue credits, grouped by the server-resolved account per line.
  FOR v_rev IN
    SELECT COALESCE(
             public.resolve_product_gl_account(
               v_inv.organization_id, v_inv.business_id, ii.product_id, 'sales_revenue'),
             v_default_revenue) AS account_id,
           ROUND(SUM(COALESCE(ii.line_total, 0)), 2) AS amount
      FROM public.invoice_items ii
     WHERE ii.invoice_id = p_invoice_id
     GROUP BY 1
    HAVING ROUND(SUM(COALESCE(ii.line_total, 0)), 2) <> 0
  LOOP
    IF v_rev.account_id IS NULL THEN
      v_unmapped := v_unmapped + 1;
      CONTINUE;
    END IF;
    v_lines := v_lines || jsonb_build_object(
      'account_id', v_rev.account_id,
      'debit', 0,
      'credit', v_rev.amount,
      'description', 'Invoice ' || v_inv.invoice_number || ' - Sales Revenue'
    );
  END LOOP;

  IF v_unmapped > 0 THEN
    RAISE EXCEPTION 'No Sales Revenue account is mapped for % invoice line group(s). Map product/category revenue accounts or the Sales Revenue default.', v_unmapped
      USING ERRCODE = 'check_violation';
  END IF;

  -- 4. Output tax liability.
  IF ROUND(COALESCE(v_inv.tax_amount, 0), 2) <> 0 THEN
    v_tax_account := public._resolve_canonical_default_account(
      'output_tax', v_inv.organization_id, v_inv.business_id, v_inv.branch_id);
    IF v_tax_account IS NULL THEN
      RAISE EXCEPTION 'Invoice carries tax but no Output Tax account is mapped. Map it in Settings > Default Accounts.'
        USING ERRCODE = 'check_violation';
    END IF;
    v_lines := v_lines || jsonb_build_object(
      'account_id', v_tax_account,
      'debit', 0,
      'credit', ROUND(v_inv.tax_amount, 2),
      'description', 'Invoice ' || v_inv.invoice_number || ' - Tax Liability'
    );
  END IF;

  -- 5. Header-level discount (total = subtotal + tax - discount).
  v_discount := ROUND(COALESCE(v_inv.discount_amount, 0), 2);
  IF v_discount <> 0 THEN
    v_discount_account := public._resolve_canonical_default_account(
      'discount_given', v_inv.organization_id, v_inv.business_id, v_inv.branch_id);
    IF v_discount_account IS NULL THEN
      RAISE EXCEPTION 'Invoice carries a discount but no Discount Given account is mapped. Map it in Settings > Default Accounts.'
        USING ERRCODE = 'check_violation';
    END IF;
    v_lines := v_lines || jsonb_build_object(
      'account_id', v_discount_account,
      'debit', v_discount,
      'credit', 0,
      'description', 'Invoice ' || v_inv.invoice_number || ' - Discount Given'
    );
  END IF;

  RETURN v_lines;
END;
$function$;

REVOKE ALL ON FUNCTION public.build_invoice_je_lines(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.build_invoice_je_lines(uuid) TO authenticated, service_role;

-- Core: ignore/reject client lines, always resolve server-side.
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

  -- Phase 6.1: GL account resolution is a server responsibility. A caller that
  -- still supplies its own journal lines is refused rather than trusted.
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

CREATE OR REPLACE FUNCTION public.confirm_invoice_atomic(p_invoice_id uuid, p_user_id uuid, p_main_lines jsonb DEFAULT NULL::jsonb, p_final_status text DEFAULT 'confirmed'::text)
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

CREATE OR REPLACE FUNCTION public.confirm_invoice_and_release_stock_atomic(p_invoice_id uuid, p_user_id uuid, p_main_lines jsonb DEFAULT NULL::jsonb, p_release_stock boolean DEFAULT true, p_warehouse_id uuid DEFAULT NULL::uuid, p_final_status text DEFAULT 'confirmed'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_confirm  jsonb;
  v_dn_id    uuid;
  v_delivery jsonb;
BEGIN
  v_confirm := public.confirm_invoice_atomic(
    p_invoice_id  := p_invoice_id,
    p_user_id     := p_user_id,
    p_main_lines  := p_main_lines,
    p_final_status := p_final_status
  );

  v_dn_id := NULLIF(v_confirm->>'delivery_note_id', '')::uuid;

  IF v_dn_id IS NULL THEN
    SELECT dn.id INTO v_dn_id
      FROM public.delivery_notes dn
      JOIN public.invoices i ON i.id = p_invoice_id
     WHERE dn.organization_id = i.organization_id
       AND dn.business_id     = i.business_id
       AND (
         dn.source_invoice_id = p_invoice_id
         OR (i.source_sales_order_id IS NOT NULL AND dn.sales_order_id = i.source_sales_order_id)
       )
       AND dn.status = 'pending'
     ORDER BY dn.created_at DESC
     LIMIT 1;
  END IF;

  IF p_release_stock AND v_dn_id IS NOT NULL THEN
    v_delivery := public.complete_delivery_atomic(
      p_dn_id               := v_dn_id,
      p_user_id             := p_user_id,
      p_received_by         := NULL,
      p_pod                 := NULL,
      p_received_by_user_id := p_user_id
    );
    IF NOT COALESCE((v_delivery->>'success')::boolean, false) THEN
      RAISE EXCEPTION 'Stock release failed: %', COALESCE(v_delivery->>'error', 'unknown error');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'journal_entry_id', v_confirm->>'journal_entry_id',
    'invoice_status', v_confirm->>'invoice_status',
    'delivery_note_id', v_dn_id,
    'auto_delivery_created', COALESCE((v_confirm->>'auto_delivery_created')::boolean, false),
    'stock_released', p_release_stock AND v_dn_id IS NOT NULL,
    'delivery_result', v_delivery
  );
END;
$function$;