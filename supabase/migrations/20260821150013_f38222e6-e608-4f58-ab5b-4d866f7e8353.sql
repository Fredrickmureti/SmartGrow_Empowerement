-- Phase F fix: confirm_bill_atomic referenced v_bill.currency / v_bill.currency_rate
-- when posting, but the SELECT INTO never loaded those columns, so EVERY bill
-- confirmation aborted with "record v_bill has no field currency".
-- Only the SELECT list changes; posting semantics are untouched.
CREATE OR REPLACE FUNCTION public.confirm_bill_atomic(_bill_id uuid, _user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_bill record;
  v_vendor_ap uuid;
  v_default_ap uuid;
  v_default_exp uuid;
  v_default_inv uuid;
  v_default_tax uuid;
  v_grni_acct uuid;
  v_effective_ap uuid;
  v_je_id uuid;
  v_je_number text;
  v_total_debits numeric := 0;
  v_diff numeric := 0;
  v_line_count integer := 0;
  v_items_subtotal numeric := 0;
  v_items_tax numeric := 0;
  v_bad_products integer := 0;
  v_bad_line_accounts integer := 0;
  v_lines jsonb;
  v_line jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT id, organization_id, business_id, branch_id, vendor_id, bill_number,
         bill_date, status, subtotal, tax_amount, discount_amount, total, journal_entry_id,
         currency, currency_rate
    INTO v_bill
  FROM public.bills
  WHERE id = _bill_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bill not found';
  END IF;
  IF v_bill.status NOT IN ('draft', 'approved') THEN
    RAISE EXCEPTION 'Only draft or approved bills can be confirmed (current: %)', v_bill.status;
  END IF;
  IF v_bill.business_id IS NULL OR NOT public.user_can_access_business(_user_id, v_bill.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_bill.business_id USING ERRCODE = '42501';
  END IF;
  IF v_bill.journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'Bill % is already linked to a journal entry', v_bill.bill_number;
  END IF;
  IF v_bill.total IS NULL OR v_bill.total <= 0 THEN
    RAISE EXCEPTION 'Bill % has non-positive total (%); cannot confirm', v_bill.bill_number, v_bill.total;
  END IF;
  IF v_bill.currency IS NULL OR COALESCE(v_bill.currency_rate, 0) <= 0 THEN
    RAISE EXCEPTION 'Bill % carries no currency/exchange rate stamp; it cannot be posted.', v_bill.bill_number
      USING ERRCODE = '23514';
  END IF;

  PERFORM public.assert_contact_in_business(v_bill.vendor_id, v_bill.organization_id, v_bill.business_id, 'bill vendor');
  PERFORM public.assert_no_existing_source_posting(v_bill.organization_id, 'bill', v_bill.id, NULL);

  SELECT COUNT(*), COALESCE(ROUND(SUM(line_total), 2), 0), COALESCE(ROUND(SUM(COALESCE(tax_amount, 0)), 2), 0)
    INTO v_line_count, v_items_subtotal, v_items_tax
  FROM public.bill_items
  WHERE bill_id = v_bill.id;

  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'Bill % has no lines; cannot confirm', v_bill.bill_number;
  END IF;

  IF ABS(v_items_subtotal - COALESCE(v_bill.subtotal, 0)) > 0.01
     OR ABS(v_items_tax - COALESCE(v_bill.tax_amount, 0)) > 0.01
     OR ABS(ROUND(v_items_subtotal + v_items_tax - COALESCE(v_bill.discount_amount, 0), 2) - COALESCE(v_bill.total, 0)) > 0.01 THEN
    RAISE EXCEPTION 'Bill % totals do not match persisted line data', v_bill.bill_number;
  END IF;

  SELECT COUNT(*) FILTER (WHERE p.id IS NOT NULL AND (p.organization_id IS DISTINCT FROM v_bill.organization_id OR p.business_id IS DISTINCT FROM v_bill.business_id)),
         COUNT(*) FILTER (WHERE bi.account_id IS NOT NULL AND (a.id IS NULL OR a.organization_id IS DISTINCT FROM v_bill.organization_id OR a.business_id IS DISTINCT FROM v_bill.business_id OR COALESCE(a.is_active, true) = false))
    INTO v_bad_products, v_bad_line_accounts
  FROM public.bill_items bi
  LEFT JOIN public.products p ON p.id = bi.product_id
  LEFT JOIN public.accounts a ON a.id = bi.account_id
  WHERE bi.bill_id = v_bill.id;

  IF v_bad_products > 0 THEN
    RAISE EXCEPTION 'Bill contains products outside the bill company';
  END IF;
  IF v_bad_line_accounts > 0 THEN
    RAISE EXCEPTION 'Bill contains line accounts outside the bill company or inactive accounts';
  END IF;

  SELECT account_id INTO v_default_ap FROM public.default_account_settings
   WHERE organization_id = v_bill.organization_id AND business_id = v_bill.business_id
     AND setting_key='accounts_payable' LIMIT 1;
  SELECT account_id INTO v_default_exp FROM public.default_account_settings
   WHERE organization_id = v_bill.organization_id AND business_id = v_bill.business_id
     AND setting_key IN ('operating_expenses','cogs')
   ORDER BY CASE setting_key WHEN 'operating_expenses' THEN 0 ELSE 1 END LIMIT 1;
  SELECT account_id INTO v_default_inv FROM public.default_account_settings
   WHERE organization_id = v_bill.organization_id AND business_id = v_bill.business_id
     AND setting_key='inventory' LIMIT 1;
  SELECT account_id INTO v_default_tax FROM public.default_account_settings
   WHERE organization_id = v_bill.organization_id AND business_id = v_bill.business_id
     AND setting_key='input_tax' LIMIT 1;
  SELECT account_id INTO v_grni_acct FROM public.default_account_settings
   WHERE organization_id = v_bill.organization_id AND business_id = v_bill.business_id
     AND setting_key='goods_received_not_invoiced' LIMIT 1;

  IF v_grni_acct IS NULL THEN
    SELECT id INTO v_grni_acct FROM public.accounts
     WHERE organization_id = v_bill.organization_id AND business_id = v_bill.business_id
       AND (detail_type = 'grni' OR code = '21100')
     ORDER BY CASE WHEN detail_type='grni' THEN 0 ELSE 1 END LIMIT 1;
  END IF;

  IF v_default_ap IS NULL OR v_default_exp IS NULL THEN
    RAISE EXCEPTION 'Cannot confirm bill: AP and Expense accounts must be mapped (AP=%, Expense=%).', v_default_ap, v_default_exp;
  END IF;

  PERFORM public.assert_account_in_business(v_default_ap, v_bill.organization_id, v_bill.business_id, NULL, 'default accounts payable account');
  PERFORM public.assert_account_in_business(v_default_exp, v_bill.organization_id, v_bill.business_id, NULL, 'default expense account');
  IF v_default_inv IS NOT NULL THEN
    PERFORM public.assert_account_in_business(v_default_inv, v_bill.organization_id, v_bill.business_id, NULL, 'default inventory account');
  END IF;
  IF v_default_tax IS NOT NULL THEN
    PERFORM public.assert_account_in_business(v_default_tax, v_bill.organization_id, v_bill.business_id, NULL, 'default input tax account');
  END IF;
  IF v_grni_acct IS NOT NULL THEN
    PERFORM public.assert_account_in_business(v_grni_acct, v_bill.organization_id, v_bill.business_id, NULL, 'GRNI account');
  END IF;

  IF v_bill.vendor_id IS NOT NULL THEN
    SELECT default_payable_account_id INTO v_vendor_ap FROM public.contacts WHERE id = v_bill.vendor_id;
  END IF;
  v_effective_ap := COALESCE(v_vendor_ap, v_default_ap);
  PERFORM public.assert_account_in_business(v_effective_ap, v_bill.organization_id, v_bill.business_id, NULL, 'effective payable account');

  -- Build the debit side in memory; the canonical engine owns all writes.
  WITH resolved AS (
    SELECT COALESCE(
      bi.account_id,
      CASE WHEN bi.purchase_order_item_id IS NOT NULL
            AND p.track_inventory IS TRUE
            AND COALESCE(poi.quantity_received, 0) > 0
            AND v_grni_acct IS NOT NULL
           THEN v_grni_acct END,
      CASE WHEN p.track_inventory IS TRUE THEN COALESCE(
        public.resolve_product_account_override(
          v_bill.organization_id, v_bill.business_id, bi.product_id, 'inventory'),
        v_default_inv) END,
      public.resolve_product_account_override(
        v_bill.organization_id, v_bill.business_id, bi.product_id, 'purchase_expense'),
      c.default_expense_account_id, v_default_exp
    ) AS acct_id, ROUND(SUM(bi.line_total), 2) AS amt
    FROM public.bill_items bi
    LEFT JOIN public.products p ON p.id = bi.product_id
    LEFT JOIN public.purchase_order_items poi ON poi.id = bi.purchase_order_item_id
    LEFT JOIN public.contacts c ON c.id = v_bill.vendor_id
    WHERE bi.bill_id = v_bill.id
    GROUP BY 1
  )
  SELECT jsonb_agg(
           jsonb_build_object(
             'account_id', acct_id,
             'debit', amt,
             'credit', 0,
             'description', 'Bill ' || v_bill.bill_number || ' — line group'
           ) ORDER BY amt DESC
         )
    INTO v_lines
  FROM resolved
  WHERE acct_id IS NOT NULL;

  IF v_lines IS NULL OR jsonb_array_length(v_lines) = 0 THEN
    RAISE EXCEPTION 'Bill % produced no debit lines; cannot confirm', v_bill.bill_number;
  END IF;

  IF v_bill.tax_amount IS NOT NULL AND v_bill.tax_amount > 0 THEN
    IF v_default_tax IS NULL THEN
      RAISE EXCEPTION 'Cannot confirm bill %: input tax account is required for taxable bill', v_bill.bill_number;
    END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_default_tax,
      'debit', ROUND(v_bill.tax_amount, 2),
      'credit', 0,
      'description', 'Bill ' || v_bill.bill_number || ' — input tax'
    ));
  END IF;

  SELECT COALESCE(SUM((l->>'debit')::numeric), 0) INTO v_total_debits
    FROM jsonb_array_elements(v_lines) AS l;

  v_diff := ROUND(v_bill.total - v_total_debits, 2);
  IF ABS(v_diff) >= 0.05 THEN
    RAISE EXCEPTION 'Bill % cannot be balanced: debits=%, total=%', v_bill.bill_number, v_total_debits, v_bill.total;
  ELSIF ABS(v_diff) > 0.001 THEN
    -- Absorb sub-cent rounding into the largest debit line.
    v_line := v_lines->0;
    v_lines := jsonb_set(v_lines, '{0,debit}',
      to_jsonb(ROUND(((v_line->>'debit')::numeric) + v_diff, 2)));
  END IF;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', v_effective_ap,
    'debit', 0,
    'credit', ROUND(v_bill.total, 2),
    'description', 'Bill ' || v_bill.bill_number || ' — Accounts Payable',
    'contact_id', v_bill.vendor_id
  ));

  v_je_number := public.generate_next_je_number(v_bill.organization_id, v_bill.business_id);

  v_je_id := public.post_journal_entry_atomic(
    v_bill.organization_id, v_bill.business_id,
    v_je_number, v_bill.bill_date,
    v_bill.bill_number, 'Bill ' || v_bill.bill_number || ' confirmed',
    'bill', v_bill.id, _user_id, false, false,
    v_lines,
    v_bill.currency, v_bill.currency_rate, NULL, v_bill.branch_id,
    false, true
  );

  UPDATE public.bills
  SET status = 'received'::bill_status,
      journal_entry_id = v_je_id,
      updated_at = now()
  WHERE id = v_bill.id;

  RETURN jsonb_build_object('success', true, 'journal_entry_id', v_je_id,
    'journal_entry_number', v_je_number, 'status', 'received');
END;
$function$;