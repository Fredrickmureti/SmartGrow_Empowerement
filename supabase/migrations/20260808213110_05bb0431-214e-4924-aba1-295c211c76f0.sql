-- ADR 0122 §reversal symmetry: a reversal must resolve accounts through the
-- same ladder as the posting it reverses.

-- 1. Sales-return inventory/COGS lines, resolved per product line.
CREATE OR REPLACE FUNCTION public.resolve_sales_return_cogs_lines(
  p_return_id uuid,
  p_org_id uuid,
  p_business_id uuid,
  p_invoice_id uuid,
  p_return_number text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_fallback_inv uuid;
  v_fallback_cogs uuid;
  v_lines jsonb := '[]'::jsonb;
  v_row record;
BEGIN
  SELECT id INTO v_fallback_inv FROM public.accounts
   WHERE organization_id = p_org_id AND business_id = p_business_id
     AND detail_type = 'inventory' AND is_active = true LIMIT 1;
  SELECT id INTO v_fallback_cogs FROM public.accounts
   WHERE organization_id = p_org_id AND business_id = p_business_id
     AND detail_type = 'cost_of_goods_sold' AND is_active = true LIMIT 1;

  FOR v_row IN
    SELECT inv_acct, cogs_acct, SUM(amount) AS amount
      FROM (
        SELECT COALESCE(
                 public.resolve_product_gl_account(p_org_id, p_business_id, sri.product_id, 'inventory'),
                 v_fallback_inv) AS inv_acct,
               COALESCE(
                 public.resolve_product_gl_account(p_org_id, p_business_id, sri.product_id, 'cogs'),
                 v_fallback_cogs) AS cogs_acct,
               ABS(sri.quantity) * COALESCE(
                 (SELECT dni.cost_at_shipment
                    FROM public.delivery_note_items dni
                    JOIN public.delivery_notes dn ON dn.id = dni.delivery_note_id
                   WHERE dni.product_id = sri.product_id
                     AND COALESCE(dn.is_return, false) = false
                     AND (dn.source_invoice_id = p_invoice_id OR dn.spawned_invoice_id = p_invoice_id)
                     AND dni.cost_at_shipment IS NOT NULL
                   ORDER BY dn.delivery_date DESC
                   LIMIT 1),
                 p.cost_price,
                 0) AS amount
          FROM public.sales_return_items sri
          LEFT JOIN public.products p ON p.id = sri.product_id
         WHERE sri.sales_return_id = p_return_id
           AND sri.product_id IS NOT NULL
      ) s
     WHERE s.amount > 0 AND s.inv_acct IS NOT NULL AND s.cogs_acct IS NOT NULL
     GROUP BY inv_acct, cogs_acct
     ORDER BY inv_acct, cogs_acct
  LOOP
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_row.inv_acct, 'debit', v_row.amount, 'credit', 0,
        'description', 'Inventory restore - ' || p_return_number),
      jsonb_build_object('account_id', v_row.cogs_acct, 'debit', 0, 'credit', v_row.amount,
        'description', 'COGS reversal - ' || p_return_number)
    );
  END LOOP;

  RETURN v_lines;
END $function$;

REVOKE ALL ON FUNCTION public.resolve_sales_return_cogs_lines(uuid, uuid, uuid, uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.resolve_sales_return_cogs_lines(uuid, uuid, uuid, uuid, text) TO authenticated, service_role;

-- 2. Credit-note revenue reversal, split across ladder-resolved revenue accounts.
CREATE OR REPLACE FUNCTION public.resolve_credit_note_revenue_lines(
  p_credit_note_id uuid,
  p_org_id uuid,
  p_business_id uuid,
  p_subtotal numeric,
  p_cn_number text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_fallback uuid;
  v_lines jsonb := '[]'::jsonb;
  v_row record;
  v_line_sum numeric := 0;
  v_alloc numeric := 0;
  v_amount numeric;
  v_count int := 0;
  v_idx int := 0;
BEGIN
  v_fallback := public.compensation_account(p_business_id, 'sales_revenue');
  IF COALESCE(p_subtotal, 0) <= 0 THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT COALESCE(SUM(COALESCE(line_total, 0)), 0)
    INTO v_line_sum
    FROM public.credit_note_items WHERE credit_note_id = p_credit_note_id;

  -- No usable line detail: keep the legacy single-account behaviour.
  IF v_line_sum <= 0 THEN
    IF v_fallback IS NULL THEN RETURN '[]'::jsonb; END IF;
    RETURN jsonb_build_array(
      jsonb_build_object('account_id', v_fallback, 'debit', p_subtotal, 'credit', 0,
        'description', 'Credit Note ' || p_cn_number || ' — revenue reversal'));
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _cn_rev_buckets(acct uuid, weight numeric) ON COMMIT DROP;
  DELETE FROM _cn_rev_buckets;

  INSERT INTO _cn_rev_buckets(acct, weight)
  SELECT acct, SUM(w) FROM (
    SELECT COALESCE(
             public.resolve_product_gl_account(p_org_id, p_business_id, cni.product_id, 'sales_revenue'),
             v_fallback) AS acct,
           COALESCE(cni.line_total, 0) AS w
      FROM public.credit_note_items cni
     WHERE cni.credit_note_id = p_credit_note_id
  ) s
  WHERE s.acct IS NOT NULL AND s.w > 0
  GROUP BY acct;

  SELECT COUNT(*) INTO v_count FROM _cn_rev_buckets;
  IF v_count = 0 THEN
    IF v_fallback IS NULL THEN RETURN '[]'::jsonb; END IF;
    RETURN jsonb_build_array(
      jsonb_build_object('account_id', v_fallback, 'debit', p_subtotal, 'credit', 0,
        'description', 'Credit Note ' || p_cn_number || ' — revenue reversal'));
  END IF;

  -- Header subtotal is authoritative; residual lands on the last bucket.
  FOR v_row IN SELECT acct, weight FROM _cn_rev_buckets ORDER BY acct LOOP
    v_idx := v_idx + 1;
    IF v_idx = v_count THEN
      v_amount := ROUND(p_subtotal - v_alloc, 2);
    ELSE
      v_amount := ROUND(p_subtotal * (v_row.weight / v_line_sum), 2);
      v_alloc := v_alloc + v_amount;
    END IF;
    IF v_amount <> 0 THEN
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object('account_id', v_row.acct, 'debit', v_amount, 'credit', 0,
          'description', 'Credit Note ' || p_cn_number || ' — revenue reversal'));
    END IF;
  END LOOP;

  RETURN v_lines;
END $function$;

REVOKE ALL ON FUNCTION public.resolve_credit_note_revenue_lines(uuid, uuid, uuid, numeric, text) FROM public;
GRANT EXECUTE ON FUNCTION public.resolve_credit_note_revenue_lines(uuid, uuid, uuid, numeric, text) TO authenticated, service_role;

-- 3. Sales return approval now uses the ladder-resolved lines.
CREATE OR REPLACE FUNCTION public.approve_sales_return_atomic(p_return_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_return RECORD;
  v_cn_number text;
  v_cn_id uuid;
  v_warehouse_id uuid;
  v_item RECORD;
  v_inventory_count integer := 0;
  v_unit_cost numeric;
  v_total_cogs numeric := 0;
  v_cogs_lines jsonb;
  v_cogs_je_id uuid;
BEGIN
  SELECT * INTO v_return FROM public.sales_returns WHERE id = p_return_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales return % not found', p_return_id; END IF;
  IF v_return.status <> 'pending' THEN
    RAISE EXCEPTION 'Only pending sales returns can be approved (current: %)', v_return.status;
  END IF;
  IF NOT public.user_can_access_business(p_user_id, v_return.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_return.business_id;
  END IF;

  v_cn_number := public.get_next_credit_note_number(
    v_return.organization_id, v_return.business_id, v_return.branch_id);

  INSERT INTO public.credit_notes(
    organization_id, business_id, branch_id,
    credit_note_number, contact_id, invoice_id, issue_date, status,
    reason, subtotal, tax_amount, total, currency, notes,
    created_by, source_return_id
  ) VALUES (
    v_return.organization_id, v_return.business_id, v_return.branch_id,
    v_cn_number, v_return.contact_id, v_return.invoice_id, CURRENT_DATE, 'draft',
    v_return.reason, v_return.subtotal, v_return.tax_amount, v_return.total, v_return.currency,
    'Auto-created from Sales Return ' || v_return.return_number, p_user_id, v_return.id
  ) RETURNING id INTO v_cn_id;

  INSERT INTO public.credit_note_items(
    credit_note_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, line_total, sort_order,
    lot_number, serial_number
  )
  SELECT
    v_cn_id, sri.product_id, sri.description, sri.quantity, sri.unit_price,
    COALESCE(sri.tax_rate,0), COALESCE(sri.tax_amount,0), sri.line_total, sri.sort_order,
    sri.lot_number, sri.serial_number
  FROM public.sales_return_items sri
  WHERE sri.sales_return_id = p_return_id;

  SELECT COUNT(*) INTO v_inventory_count
  FROM public.sales_return_items sri
  WHERE sri.sales_return_id = p_return_id AND sri.product_id IS NOT NULL;

  IF v_inventory_count > 0 THEN
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
      SELECT product_id, quantity, lot_number, serial_number
      FROM public.sales_return_items
      WHERE sales_return_id = p_return_id AND product_id IS NOT NULL
    LOOP
      SELECT dni.cost_at_shipment INTO v_unit_cost
        FROM public.delivery_note_items dni
        JOIN public.delivery_notes dn ON dn.id = dni.delivery_note_id
       WHERE dni.product_id = v_item.product_id
         AND COALESCE(dn.is_return, false) = false
         AND (dn.source_invoice_id = v_return.invoice_id OR dn.spawned_invoice_id = v_return.invoice_id)
         AND dni.cost_at_shipment IS NOT NULL
       ORDER BY dn.delivery_date DESC
       LIMIT 1;

      IF v_unit_cost IS NULL THEN
        SELECT COALESCE(p.cost_price, 0) INTO v_unit_cost
          FROM public.products p WHERE p.id = v_item.product_id;
      END IF;
      v_unit_cost := COALESCE(v_unit_cost, 0);
      v_total_cogs := v_total_cogs + (ABS(v_item.quantity) * v_unit_cost);

      INSERT INTO public.stock_movements(
        organization_id, business_id, branch_id, product_id, movement_type,
        quantity, reference_type, reference_id, warehouse_id, notes,
        lot_number, serial_number, unit_cost
      ) VALUES (
        v_return.organization_id, v_return.business_id, v_return.branch_id,
        v_item.product_id, 'return_in', v_item.quantity,
        'sales_return', p_return_id, v_warehouse_id,
        'Sales return ' || v_return.return_number || ' approved - stock restored',
        v_item.lot_number, v_item.serial_number, v_unit_cost
      );
    END LOOP;
  END IF;

  -- Inventory / COGS reversal on the ADR 0122 ladder: the accounts a return
  -- credits must be the accounts the delivery debited, per product.
  IF v_total_cogs > 0.005 AND public.is_period_open(v_return.business_id, CURRENT_DATE) THEN
    v_cogs_lines := public.resolve_sales_return_cogs_lines(
      p_return_id, v_return.organization_id, v_return.business_id,
      v_return.invoice_id, v_return.return_number);

    IF jsonb_array_length(COALESCE(v_cogs_lines, '[]'::jsonb)) > 0 THEN
      PERFORM public.assert_no_existing_source_posting(
        v_return.organization_id, 'sales_return', p_return_id, NULL);

      v_cogs_je_id := public.post_journal_entry_atomic(
        _org_id := v_return.organization_id,
        _business_id := v_return.business_id,
        _entry_number := public.generate_next_je_number(v_return.organization_id, v_return.business_id),
        _entry_date := CURRENT_DATE,
        _reference := v_return.return_number,
        _description := 'Sales return ' || v_return.return_number || ' — inventory restore / COGS reversal',
        _source_type := 'sales_return',
        _source_id := p_return_id,
        _created_by := p_user_id,
        _is_closing := false,
        _is_adjusting := false,
        _lines := v_cogs_lines,
        _currency := NULL,
        _exchange_rate := NULL,
        _source_subtype := NULL,
        _branch_id := v_return.branch_id
      );
    END IF;
  END IF;

  UPDATE public.sales_returns
     SET status = 'approved', credit_note_id = v_cn_id, updated_at = now()
   WHERE id = p_return_id;

  RETURN jsonb_build_object(
    'success', true,
    'credit_note_id', v_cn_id,
    'credit_note_number', v_cn_number,
    'cogs_journal_entry_id', v_cogs_je_id,
    'cogs_reversed', v_total_cogs
  );
END;
$function$;

-- 4. Credit note issuance splits the revenue reversal across the ladder.
CREATE OR REPLACE FUNCTION public.issue_credit_note_atomic(_credit_note_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cn public.credit_notes%ROWTYPE;
  v_inv public.invoices%ROWTYPE;
  v_open_balance numeric := 0;
  v_to_ar numeric := 0;
  v_to_credit numeric := 0;
  v_ar uuid; v_rev uuid; v_tax uuid; v_credit_liab uuid;
  v_lines jsonb;
  v_rev_lines jsonb;
  v_je_id uuid;
  v_balance_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_cn FROM public.credit_notes WHERE id = _credit_note_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Credit note % not found', _credit_note_id; END IF;
  IF v_cn.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft credit notes can be issued (current: %)', v_cn.status;
  END IF;
  IF v_cn.business_id IS NULL OR NOT public.user_can_access_business(auth.uid(), v_cn.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_cn.business_id USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_period_open(v_cn.business_id, v_cn.issue_date) THEN
    RAISE EXCEPTION 'accounting period is closed for %', v_cn.issue_date;
  END IF;

  PERFORM public.assert_no_existing_source_posting(v_cn.organization_id, 'credit_note', _credit_note_id, NULL);

  v_ar  := public.compensation_account(v_cn.business_id, 'accounts_receivable');
  v_rev := public.compensation_account(v_cn.business_id, 'sales_revenue');
  v_credit_liab := public.customer_credit_account(v_cn.business_id);
  IF COALESCE(v_cn.tax_amount, 0) > 0 THEN
    v_tax := public.compensation_account(v_cn.business_id, 'output_tax');
  END IF;

  IF v_cn.invoice_id IS NOT NULL THEN
    SELECT * INTO v_inv FROM public.invoices WHERE id = v_cn.invoice_id FOR UPDATE;
    IF FOUND THEN
      v_open_balance := GREATEST(COALESCE(v_inv.total, 0) - COALESCE(v_inv.amount_paid, 0), 0);
    END IF;
  END IF;

  v_to_ar := LEAST(v_cn.total, v_open_balance);
  v_to_credit := v_cn.total - v_to_ar;

  -- Revenue reversal follows the ADR 0122 ladder per line: a credit must land
  -- on the same revenue accounts the sale credited, not one company default.
  v_rev_lines := public.resolve_credit_note_revenue_lines(
    _credit_note_id, v_cn.organization_id, v_cn.business_id, v_cn.subtotal, v_cn.credit_note_number);

  IF jsonb_array_length(COALESCE(v_rev_lines, '[]'::jsonb)) = 0 AND COALESCE(v_cn.subtotal, 0) > 0 THEN
    v_rev_lines := jsonb_build_array(
      jsonb_build_object('account_id', v_rev, 'debit', v_cn.subtotal, 'credit', 0,
        'description', 'Credit Note ' || v_cn.credit_note_number || ' — revenue reversal'));
  END IF;

  v_lines := COALESCE(v_rev_lines, '[]'::jsonb);
  IF COALESCE(v_cn.tax_amount, 0) > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_tax, 'debit', v_cn.tax_amount, 'credit', 0,
        'description', 'Credit Note ' || v_cn.credit_note_number || ' — tax reversal'));
  END IF;
  IF v_to_ar > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_ar, 'debit', 0, 'credit', v_to_ar,
        'description', 'Credit Note ' || v_cn.credit_note_number || ' — receivable reduction',
        'contact_id', v_cn.contact_id));
  END IF;
  IF v_to_credit > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_credit_liab, 'debit', 0, 'credit', v_to_credit,
        'description', 'Credit Note ' || v_cn.credit_note_number || ' — customer credit',
        'contact_id', v_cn.contact_id));
  END IF;

  v_je_id := public.post_journal_entry_atomic(
    _org_id := v_cn.organization_id,
    _business_id := v_cn.business_id,
    _entry_number := public.generate_next_je_number(v_cn.organization_id, v_cn.business_id),
    _entry_date := v_cn.issue_date,
    _reference := v_cn.credit_note_number,
    _description := 'Credit Note ' || v_cn.credit_note_number || ' issued',
    _source_type := 'credit_note',
    _source_id := _credit_note_id,
    _created_by := auth.uid(),
    _is_closing := false,
    _is_adjusting := false,
    _lines := v_lines,
    _currency := v_cn.currency,
    _exchange_rate := NULL,
    _source_subtype := NULL,
    _branch_id := v_cn.branch_id
  );

  IF v_to_ar > 0 AND v_cn.invoice_id IS NOT NULL THEN
    UPDATE public.invoices
       SET amount_paid = COALESCE(amount_paid, 0) + v_to_ar,
           status = CASE
             WHEN COALESCE(amount_paid, 0) + v_to_ar >= COALESCE(total, 0) THEN 'paid'::invoice_status
             ELSE 'partial'::invoice_status END
     WHERE id = v_cn.invoice_id;
  END IF;

  IF v_to_credit > 0 THEN
    v_balance_id := public.customer_credit_balance_id(
      v_cn.organization_id, v_cn.business_id, v_cn.contact_id, v_cn.currency);
    INSERT INTO public.customer_credit_movements (
      organization_id, business_id, branch_id, contact_id, balance_id,
      kind, amount, currency, credit_note_id, journal_entry_id, created_by, notes
    ) VALUES (
      v_cn.organization_id, v_cn.business_id, v_cn.branch_id, v_cn.contact_id, v_balance_id,
      'issue', v_to_credit, v_cn.currency, _credit_note_id, v_je_id, auth.uid(),
      'Credit note issued'
    );
  END IF;

  UPDATE public.credit_notes
     SET status = 'issued'::credit_note_status,
         amount_applied = COALESCE(amount_applied, 0) + v_to_ar,
         updated_at = now()
   WHERE id = _credit_note_id;

  RETURN jsonb_build_object(
    'success', true,
    'journal_entry_id', v_je_id,
    'applied_to_invoice', v_to_ar,
    'customer_credit_created', v_to_credit
  );
END;
$function$;