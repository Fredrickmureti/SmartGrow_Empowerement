-- ============================================================================
-- Purchases Module — Odoo-Grade Refinements (Phase 10 of Zero-Trust Audit)
-- ============================================================================

-- 1. confirm_bill_atomic — GRNI clearing for received-stockable lines (F1)
CREATE OR REPLACE FUNCTION public.confirm_bill_atomic(_bill_id uuid, _user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bill RECORD; v_vendor_ap uuid; v_default_ap uuid; v_default_exp uuid;
  v_default_inv uuid; v_default_tax uuid; v_grni_acct uuid; v_effective_ap uuid;
  v_je_id uuid; v_je_number text; v_attempts int := 0; v_max_attempts int := 20;
  v_total_debits numeric := 0; v_sort int := 0;
BEGIN
  SELECT id, organization_id, business_id, branch_id, vendor_id, bill_number,
         bill_date, status, subtotal, tax_amount, total, journal_entry_id
    INTO v_bill FROM bills WHERE id = _bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found'; END IF;
  IF v_bill.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft bills can be confirmed (current: %)', v_bill.status;
  END IF;
  IF v_bill.business_id IS NULL THEN
    RAISE EXCEPTION 'Bill % has no business_id', v_bill.bill_number;
  END IF;
  IF v_bill.total IS NULL OR v_bill.total <= 0 THEN
    RAISE EXCEPTION 'Bill % has non-positive total (%); cannot confirm', v_bill.bill_number, v_bill.total;
  END IF;

  SELECT account_id INTO v_default_ap FROM default_account_settings
   WHERE organization_id = v_bill.organization_id AND business_id = v_bill.business_id
     AND setting_key='accounts_payable' LIMIT 1;
  SELECT account_id INTO v_default_exp FROM default_account_settings
   WHERE organization_id = v_bill.organization_id AND business_id = v_bill.business_id
     AND setting_key IN ('operating_expenses','cogs')
   ORDER BY CASE setting_key WHEN 'operating_expenses' THEN 0 ELSE 1 END LIMIT 1;
  SELECT account_id INTO v_default_inv FROM default_account_settings
   WHERE organization_id = v_bill.organization_id AND business_id = v_bill.business_id
     AND setting_key='inventory' LIMIT 1;
  SELECT account_id INTO v_default_tax FROM default_account_settings
   WHERE organization_id = v_bill.organization_id AND business_id = v_bill.business_id
     AND setting_key='input_tax' LIMIT 1;

  SELECT account_id INTO v_grni_acct FROM default_account_settings
   WHERE organization_id = v_bill.organization_id AND business_id = v_bill.business_id
     AND setting_key='goods_received_not_invoiced' LIMIT 1;
  IF v_grni_acct IS NULL THEN
    SELECT id INTO v_grni_acct FROM accounts
     WHERE organization_id = v_bill.organization_id AND business_id = v_bill.business_id
       AND (detail_type = 'grni' OR code = '21100')
     ORDER BY CASE WHEN detail_type='grni' THEN 0 ELSE 1 END LIMIT 1;
  END IF;

  IF v_default_ap IS NULL OR v_default_exp IS NULL THEN
    RAISE EXCEPTION 'Cannot confirm bill: AP and Expense accounts must be mapped (AP=%, Expense=%).', v_default_ap, v_default_exp;
  END IF;

  IF v_bill.vendor_id IS NOT NULL THEN
    SELECT default_payable_account_id INTO v_vendor_ap FROM contacts WHERE id = v_bill.vendor_id;
  END IF;
  v_effective_ap := COALESCE(v_vendor_ap, v_default_ap);

  LOOP
    v_attempts := v_attempts + 1;
    IF v_attempts > v_max_attempts THEN
      RAISE EXCEPTION 'Unable to allocate JE number after % attempts', v_max_attempts;
    END IF;
    v_je_number := generate_next_je_number(v_bill.organization_id, v_bill.business_id);
    BEGIN
      INSERT INTO journal_entries (organization_id, business_id, branch_id, entry_number,
        entry_date, reference, description, source_type, source_id, status, created_by)
      VALUES (v_bill.organization_id, v_bill.business_id, v_bill.branch_id, v_je_number,
        v_bill.bill_date, v_bill.bill_number, 'Bill ' || v_bill.bill_number || ' confirmed',
        'bill', v_bill.id, 'posted', _user_id)
      RETURNING id INTO v_je_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF POSITION('journal_entries_organization_id_entry_number_key' IN SQLERRM) > 0 THEN CONTINUE; ELSE RAISE; END IF;
    END;
  END LOOP;

  WITH resolved AS (
    SELECT COALESCE(
      bi.account_id,
      CASE WHEN bi.purchase_order_item_id IS NOT NULL
            AND p.track_inventory IS TRUE
            AND COALESCE(poi.quantity_received, 0) > 0
            AND v_grni_acct IS NOT NULL
           THEN v_grni_acct END,
      CASE WHEN p.track_inventory IS TRUE THEN COALESCE(p.inventory_account_id, v_default_inv) END,
      p.purchase_account_id, c.default_expense_account_id, v_default_exp
    ) AS acct_id, SUM(bi.line_total) AS amt
    FROM bill_items bi
    LEFT JOIN products p ON p.id = bi.product_id
    LEFT JOIN purchase_order_items poi ON poi.id = bi.purchase_order_item_id
    LEFT JOIN contacts c ON c.id = v_bill.vendor_id
    WHERE bi.bill_id = v_bill.id GROUP BY 1
  )
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit,
    description, business_id, branch_id, sort_order)
  SELECT v_je_id, r.acct_id, ROUND(r.amt, 2), 0,
    'Bill ' || v_bill.bill_number || ' — line group',
    v_bill.business_id, v_bill.branch_id,
    ROW_NUMBER() OVER (ORDER BY r.acct_id) - 1
  FROM resolved r WHERE r.acct_id IS NOT NULL;

  GET DIAGNOSTICS v_sort = ROW_COUNT;

  IF v_sort = 0 AND v_bill.subtotal IS NOT NULL AND v_bill.subtotal > 0 THEN
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit,
      description, business_id, branch_id, sort_order)
    VALUES (v_je_id, v_default_exp, ROUND(v_bill.subtotal, 2), 0,
      'Bill ' || v_bill.bill_number || ' — expense (no lines)',
      v_bill.business_id, v_bill.branch_id, 0);
    v_sort := 1;
  END IF;

  IF v_bill.tax_amount IS NOT NULL AND v_bill.tax_amount > 0 AND v_default_tax IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit,
      description, business_id, branch_id, sort_order)
    VALUES (v_je_id, v_default_tax, ROUND(v_bill.tax_amount, 2), 0,
      'Bill ' || v_bill.bill_number || ' — input tax',
      v_bill.business_id, v_bill.branch_id, v_sort);
    v_sort := v_sort + 1;
  END IF;

  SELECT COALESCE(SUM(debit), 0) INTO v_total_debits
    FROM journal_entry_lines WHERE journal_entry_id = v_je_id;

  IF ABS(v_total_debits - v_bill.total) > 0.001 AND ABS(v_total_debits - v_bill.total) < 0.05 THEN
    UPDATE journal_entry_lines SET debit = debit + (v_bill.total - v_total_debits)
     WHERE id = (SELECT id FROM journal_entry_lines
                  WHERE journal_entry_id = v_je_id AND debit > 0
                  ORDER BY debit DESC LIMIT 1);
  ELSIF ABS(v_total_debits - v_bill.total) >= 0.05 THEN
    RAISE EXCEPTION 'Bill % cannot be balanced: debits=%, total=%', v_bill.bill_number, v_total_debits, v_bill.total;
  END IF;

  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit,
    description, contact_id, business_id, branch_id, sort_order)
  VALUES (v_je_id, v_effective_ap, 0, v_bill.total,
    'Bill ' || v_bill.bill_number || ' — Accounts Payable',
    v_bill.vendor_id, v_bill.business_id, v_bill.branch_id, v_sort);

  UPDATE bills SET status = 'received'::bill_status,
    journal_entry_id = v_je_id, updated_at = now() WHERE id = v_bill.id;

  RETURN jsonb_build_object('success', true, 'journal_entry_id', v_je_id,
    'journal_entry_number', v_je_number, 'status', 'received');
END;
$$;
GRANT EXECUTE ON FUNCTION public.confirm_bill_atomic(uuid, uuid) TO authenticated;

-- 2. convert_po_to_bill_atomic — derived billing_status + FX snapshot (F2/F8)
CREATE OR REPLACE FUNCTION public.convert_po_to_bill_atomic(_po_id uuid, _user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_po RECORD; v_bill_id uuid; v_bill_no text; v_attempts int := 0; v_max int := 20;
  v_company_ccy text; v_rate numeric := 1; v_company_total numeric;
  v_billing text; v_any_under boolean; v_any_billed boolean;
BEGIN
  SELECT id, organization_id, business_id, branch_id, vendor_id, po_number,
         currency, subtotal, tax_amount, discount_amount, total, notes, status,
         billing_status, converted_bill_id
    INTO v_po FROM purchase_orders WHERE id = _po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
  IF v_po.converted_bill_id IS NOT NULL THEN
    RAISE EXCEPTION 'Purchase order % already converted to a bill (%)', v_po.po_number, v_po.converted_bill_id;
  END IF;

  SELECT base_currency INTO v_company_ccy FROM businesses WHERE id = v_po.business_id;
  IF v_po.currency IS NOT NULL AND v_company_ccy IS NOT NULL AND v_po.currency <> v_company_ccy THEN
    SELECT rate INTO v_rate FROM exchange_rates
     WHERE organization_id = v_po.organization_id
       AND from_currency = v_po.currency AND to_currency = v_company_ccy
       AND effective_date <= CURRENT_DATE
     ORDER BY effective_date DESC LIMIT 1;
    v_rate := COALESCE(v_rate, 1);
  END IF;
  v_company_total := ROUND(COALESCE(v_po.total, 0) * v_rate, 2);

  LOOP
    v_attempts := v_attempts + 1;
    IF v_attempts > v_max THEN RAISE EXCEPTION 'Unable to allocate bill number after % attempts', v_max; END IF;
    v_bill_no := get_next_bill_number(v_po.organization_id);
    BEGIN
      INSERT INTO bills (organization_id, business_id, branch_id, vendor_id,
        bill_number, status, bill_date, due_date, subtotal, tax_amount,
        discount_amount, total, currency, currency_rate, company_currency_total,
        notes, created_by, source_purchase_order_id)
      VALUES (v_po.organization_id, v_po.business_id, v_po.branch_id, v_po.vendor_id,
        v_bill_no, 'draft'::bill_status, CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
        v_po.subtotal, v_po.tax_amount, COALESCE(v_po.discount_amount, 0), v_po.total,
        v_po.currency, v_rate, v_company_total, v_po.notes, _user_id, v_po.id)
      RETURNING id INTO v_bill_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN CONTINUE;
    END;
  END LOOP;

  INSERT INTO bill_items (bill_id, product_id, purchase_order_item_id,
    description, quantity, unit_price, tax_rate, tax_amount, line_total, sort_order)
  SELECT v_bill_id, poi.product_id, poi.id, poi.description, poi.quantity, poi.unit_price,
    COALESCE(poi.tax_rate, 0), COALESCE(poi.tax_amount, 0),
    poi.line_total, COALESCE(poi.sort_order, 0)
  FROM purchase_order_items poi WHERE poi.purchase_order_id = v_po.id;

  UPDATE purchase_order_items
     SET quantity_billed = COALESCE(quantity_billed, 0) + quantity
   WHERE purchase_order_id = v_po.id;

  SELECT BOOL_OR(COALESCE(quantity_billed,0) < COALESCE(quantity,0)),
         BOOL_OR(COALESCE(quantity_billed,0) > 0)
    INTO v_any_under, v_any_billed
    FROM purchase_order_items WHERE purchase_order_id = v_po.id;

  v_billing := CASE
    WHEN v_any_under IS NOT TRUE THEN 'fully_billed'
    WHEN v_any_billed THEN 'to_bill'
    ELSE 'no'
  END;

  UPDATE purchase_orders SET converted_bill_id = v_bill_id,
    billing_status = v_billing, updated_at = now() WHERE id = v_po.id;

  RETURN jsonb_build_object('success', true, 'bill_id', v_bill_id, 'bill_number', v_bill_no,
    'billing_status', v_billing, 'currency_rate', v_rate, 'company_currency_total', v_company_total);
END;
$$;
GRANT EXECUTE ON FUNCTION public.convert_po_to_bill_atomic(uuid, uuid) TO authenticated;

-- 3. record_bill_payment_atomic — WHT inside the same transaction (F7)
CREATE OR REPLACE FUNCTION public.record_bill_payment_atomic(
  _org_id uuid, _business_id uuid, _bill_id uuid, _amount numeric, _payment_date date,
  _payment_method text DEFAULT 'bank_transfer', _reference text DEFAULT NULL,
  _notes text DEFAULT NULL, _bank_account_id uuid DEFAULT NULL, _created_by uuid DEFAULT NULL,
  _ap_account_id uuid DEFAULT NULL, _cash_account_id uuid DEFAULT NULL,
  _je_entry_number text DEFAULT NULL, _wht_rate numeric DEFAULT 0,
  _wht_account_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_payment_id uuid; v_bill RECORD; v_new_amount_paid numeric; v_new_status bill_status;
  v_je_id uuid; v_je_number text; v_wht_je_id uuid; v_wht_je_number text;
  v_wht_amount numeric := 0; v_attempts int := 0; v_max_attempts int := 20; v_result jsonb;
BEGIN
  IF _ap_account_id IS NULL OR _cash_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot record bill payment: missing GL account mapping (AP=%, Cash=%).', _ap_account_id, _cash_account_id;
  END IF;

  SELECT id, bill_number, total, amount_paid, status, journal_entry_id, vendor_id
    INTO v_bill FROM bills WHERE id = _bill_id AND organization_id = _org_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found'; END IF;
  IF _amount > (v_bill.total - COALESCE(v_bill.amount_paid, 0)) THEN
    RAISE EXCEPTION 'Payment amount (%) exceeds balance due (%)', _amount, (v_bill.total - COALESCE(v_bill.amount_paid, 0));
  END IF;

  INSERT INTO bill_payments (organization_id, business_id, bill_id, amount,
    payment_date, payment_method, reference, notes, bank_account_id, created_by)
  VALUES (_org_id, _business_id, _bill_id, _amount, _payment_date, _payment_method,
    _reference, _notes, _bank_account_id, _created_by) RETURNING id INTO v_payment_id;

  v_new_amount_paid := COALESCE(v_bill.amount_paid, 0) + _amount;
  v_new_status := CASE WHEN v_new_amount_paid >= v_bill.total THEN 'paid'::bill_status ELSE 'partial'::bill_status END;

  LOOP
    v_attempts := v_attempts + 1;
    IF v_attempts > v_max_attempts THEN RAISE EXCEPTION 'Unable to allocate JE number after % attempts', v_max_attempts; END IF;
    v_je_number := generate_next_je_number(_org_id);
    BEGIN
      INSERT INTO journal_entries (organization_id, business_id, entry_number, entry_date,
        reference, description, source_type, source_id, status, created_by)
      VALUES (_org_id, _business_id, v_je_number, _payment_date,
        'BP-' || v_bill.bill_number, 'Bill payment for ' || v_bill.bill_number,
        'bill_payment', v_payment_id, 'posted', _created_by)
      RETURNING id INTO v_je_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF POSITION('journal_entries_organization_id_entry_number_key' IN SQLERRM) > 0 THEN CONTINUE; ELSE RAISE; END IF;
    END;
  END LOOP;

  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES (v_je_id, _ap_account_id, _amount, 0, 'Bill payment ' || v_bill.bill_number || ' - AP reduction');
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES (v_je_id, _cash_account_id, 0, _amount, 'Bill payment ' || v_bill.bill_number || ' - Cash/Bank');

  UPDATE bill_payments SET journal_entry_id = v_je_id WHERE id = v_payment_id;

  IF _wht_rate IS NOT NULL AND _wht_rate > 0 AND _wht_account_id IS NOT NULL THEN
    v_wht_amount := ROUND(_amount * (_wht_rate / 100.0), 2);
    IF v_wht_amount > 0 THEN
      v_attempts := 0;
      LOOP
        v_attempts := v_attempts + 1;
        IF v_attempts > v_max_attempts THEN RAISE EXCEPTION 'Unable to allocate WHT JE number'; END IF;
        v_wht_je_number := generate_next_je_number(_org_id);
        BEGIN
          INSERT INTO journal_entries (organization_id, business_id, entry_number, entry_date,
            reference, description, source_type, source_id, source_subtype, status, created_by)
          VALUES (_org_id, _business_id, v_wht_je_number, _payment_date,
            'WHT-' || v_bill.bill_number,
            'Withholding tax on payment for ' || v_bill.bill_number || ' (' || _wht_rate || '%)',
            'bill_payment', v_payment_id, 'wht', 'posted', _created_by)
          RETURNING id INTO v_wht_je_id;
          EXIT;
        EXCEPTION WHEN unique_violation THEN
          IF POSITION('journal_entries_organization_id_entry_number_key' IN SQLERRM) > 0 THEN CONTINUE; ELSE RAISE; END IF;
        END;
      END LOOP;

      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, contact_id)
      VALUES (v_wht_je_id, _ap_account_id, v_wht_amount, 0,
        'WHT ' || v_bill.bill_number || ' - AP reduction', v_bill.vendor_id);
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
      VALUES (v_wht_je_id, _wht_account_id, 0, v_wht_amount,
        'WHT Liability ' || v_bill.bill_number || ' (' || _wht_rate || '%)');

      v_new_amount_paid := v_new_amount_paid + v_wht_amount;
      v_new_status := CASE WHEN v_new_amount_paid >= v_bill.total THEN 'paid'::bill_status ELSE 'partial'::bill_status END;
    END IF;
  END IF;

  UPDATE bills SET amount_paid = v_new_amount_paid, status = v_new_status,
    journal_entry_id = v_je_id WHERE id = _bill_id;

  v_result := jsonb_build_object('payment_id', v_payment_id, 'journal_entry_id', v_je_id,
    'journal_entry_number', v_je_number, 'wht_journal_entry_id', v_wht_je_id,
    'wht_amount', v_wht_amount, 'new_status', v_new_status::text,
    'new_amount_paid', v_new_amount_paid);
  RETURN v_result;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.record_bill_payment_atomic(
  uuid, uuid, uuid, numeric, date, text, text, text, uuid, uuid, uuid, uuid, text, numeric, uuid
) TO authenticated;

-- 4. convert_rfq_to_po_atomic — single-transaction RFQ→PO (F4)
CREATE OR REPLACE FUNCTION public.convert_rfq_to_po_atomic(
  _rfq_id uuid, _rfq_vendor_id uuid, _user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rfq RECORD; v_rv RECORD; v_po_id uuid; v_po_no text;
  v_currency text; v_subtotal numeric := 0;
BEGIN
  SELECT id, organization_id, business_id, branch_id, deadline, notes, status
    INTO v_rfq FROM rfqs WHERE id = _rfq_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RFQ not found'; END IF;
  IF v_rfq.status = 'closed' THEN RAISE EXCEPTION 'RFQ % is already closed', _rfq_id; END IF;

  SELECT id, rfq_id, vendor_id, status INTO v_rv FROM rfq_vendors
   WHERE id = _rfq_vendor_id AND rfq_id = _rfq_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RFQ vendor row not found'; END IF;

  SELECT base_currency INTO v_currency FROM businesses WHERE id = v_rfq.business_id;
  v_po_no := get_next_po_number(v_rfq.organization_id);

  SELECT COALESCE(SUM(COALESCE(rvi.unit_price, ri.target_price, 0)
                    * COALESCE(rvi.available_qty, ri.quantity)), 0)
    INTO v_subtotal
    FROM rfq_items ri
    LEFT JOIN rfq_vendor_items rvi
      ON rvi.rfq_item_id = ri.id AND rvi.rfq_vendor_id = v_rv.id
   WHERE ri.rfq_id = _rfq_id;

  INSERT INTO purchase_orders (organization_id, business_id, branch_id, vendor_id,
    po_number, status, order_date, expected_date, subtotal, tax_amount, discount_amount,
    total, currency, notes, created_by)
  VALUES (v_rfq.organization_id, v_rfq.business_id, v_rfq.branch_id, v_rv.vendor_id,
    v_po_no, 'draft', CURRENT_DATE, v_rfq.deadline, v_subtotal, 0, 0, v_subtotal,
    v_currency, v_rfq.notes, _user_id) RETURNING id INTO v_po_id;

  INSERT INTO purchase_order_items (purchase_order_id, product_id, description,
    quantity, quantity_received, unit_price, tax_rate, tax_amount, line_total, sort_order)
  SELECT v_po_id, ri.product_id, ri.description,
    COALESCE(rvi.available_qty, ri.quantity), 0,
    COALESCE(rvi.unit_price, ri.target_price, 0), 0, 0,
    COALESCE(rvi.unit_price, ri.target_price, 0) * COALESCE(rvi.available_qty, ri.quantity),
    COALESCE(ri.sort_order, 0)
  FROM rfq_items ri
  LEFT JOIN rfq_vendor_items rvi
    ON rvi.rfq_item_id = ri.id AND rvi.rfq_vendor_id = v_rv.id
  WHERE ri.rfq_id = _rfq_id;

  UPDATE rfqs SET status = 'closed', updated_at = now() WHERE id = _rfq_id;

  RETURN jsonb_build_object('success', true, 'purchase_order_id', v_po_id, 'po_number', v_po_no);
END;
$$;
GRANT EXECUTE ON FUNCTION public.convert_rfq_to_po_atomic(uuid, uuid, uuid) TO authenticated;

-- 5. award_rfq_atomic — locked award (F12)
CREATE OR REPLACE FUNCTION public.award_rfq_atomic(_rfq_id uuid, _rfq_vendor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM rfqs WHERE id = _rfq_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RFQ not found'; END IF;
  IF v_status = 'closed' THEN RAISE EXCEPTION 'RFQ already closed'; END IF;

  UPDATE rfq_vendors SET status = 'declined'
   WHERE rfq_id = _rfq_id AND id <> _rfq_vendor_id;
  UPDATE rfq_vendors SET status = 'awarded'
   WHERE id = _rfq_vendor_id AND rfq_id = _rfq_id;
  UPDATE rfqs SET status = 'closed', updated_at = now() WHERE id = _rfq_id;

  RETURN jsonb_build_object('success', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.award_rfq_atomic(uuid, uuid) TO authenticated;

-- 6. RLS hardening on RFQ child tables (F5)
ALTER TABLE public.rfq_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rfq_vendors      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rfq_vendor_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rfq_items_select ON public.rfq_items;
DROP POLICY IF EXISTS rfq_items_insert ON public.rfq_items;
DROP POLICY IF EXISTS rfq_items_update ON public.rfq_items;
DROP POLICY IF EXISTS rfq_items_delete ON public.rfq_items;
DROP POLICY IF EXISTS "Users can view RFQ items"   ON public.rfq_items;
DROP POLICY IF EXISTS "Users can manage RFQ items" ON public.rfq_items;

CREATE POLICY rfq_items_select ON public.rfq_items FOR SELECT
  USING (EXISTS (SELECT 1 FROM rfqs r WHERE r.id = rfq_items.rfq_id
                  AND user_can_access_business(auth.uid(), r.business_id)));
CREATE POLICY rfq_items_insert ON public.rfq_items FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM rfqs r WHERE r.id = rfq_items.rfq_id
                       AND user_can_access_business(auth.uid(), r.business_id)));
CREATE POLICY rfq_items_update ON public.rfq_items FOR UPDATE
  USING (EXISTS (SELECT 1 FROM rfqs r WHERE r.id = rfq_items.rfq_id
                  AND user_can_access_business(auth.uid(), r.business_id)));
CREATE POLICY rfq_items_delete ON public.rfq_items FOR DELETE
  USING (EXISTS (SELECT 1 FROM rfqs r WHERE r.id = rfq_items.rfq_id
                  AND user_can_access_business(auth.uid(), r.business_id)));

DROP POLICY IF EXISTS rfq_vendors_select ON public.rfq_vendors;
DROP POLICY IF EXISTS rfq_vendors_insert ON public.rfq_vendors;
DROP POLICY IF EXISTS rfq_vendors_update ON public.rfq_vendors;
DROP POLICY IF EXISTS rfq_vendors_delete ON public.rfq_vendors;
DROP POLICY IF EXISTS "Users can view RFQ vendors"   ON public.rfq_vendors;
DROP POLICY IF EXISTS "Users can manage RFQ vendors" ON public.rfq_vendors;

CREATE POLICY rfq_vendors_select ON public.rfq_vendors FOR SELECT
  USING (EXISTS (SELECT 1 FROM rfqs r WHERE r.id = rfq_vendors.rfq_id
                  AND user_can_access_business(auth.uid(), r.business_id)));
CREATE POLICY rfq_vendors_insert ON public.rfq_vendors FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM rfqs r WHERE r.id = rfq_vendors.rfq_id
                       AND user_can_access_business(auth.uid(), r.business_id)));
CREATE POLICY rfq_vendors_update ON public.rfq_vendors FOR UPDATE
  USING (EXISTS (SELECT 1 FROM rfqs r WHERE r.id = rfq_vendors.rfq_id
                  AND user_can_access_business(auth.uid(), r.business_id)));
CREATE POLICY rfq_vendors_delete ON public.rfq_vendors FOR DELETE
  USING (EXISTS (SELECT 1 FROM rfqs r WHERE r.id = rfq_vendors.rfq_id
                  AND user_can_access_business(auth.uid(), r.business_id)));

DROP POLICY IF EXISTS rfq_vendor_items_select ON public.rfq_vendor_items;
DROP POLICY IF EXISTS rfq_vendor_items_insert ON public.rfq_vendor_items;
DROP POLICY IF EXISTS rfq_vendor_items_update ON public.rfq_vendor_items;
DROP POLICY IF EXISTS rfq_vendor_items_delete ON public.rfq_vendor_items;
DROP POLICY IF EXISTS "Users can view RFQ vendor items"   ON public.rfq_vendor_items;
DROP POLICY IF EXISTS "Users can manage RFQ vendor items" ON public.rfq_vendor_items;

CREATE POLICY rfq_vendor_items_select ON public.rfq_vendor_items FOR SELECT
  USING (EXISTS (SELECT 1 FROM rfq_vendors rv JOIN rfqs r ON r.id = rv.rfq_id
                  WHERE rv.id = rfq_vendor_items.rfq_vendor_id
                    AND user_can_access_business(auth.uid(), r.business_id)));
CREATE POLICY rfq_vendor_items_insert ON public.rfq_vendor_items FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM rfq_vendors rv JOIN rfqs r ON r.id = rv.rfq_id
                       WHERE rv.id = rfq_vendor_items.rfq_vendor_id
                         AND user_can_access_business(auth.uid(), r.business_id)));
CREATE POLICY rfq_vendor_items_update ON public.rfq_vendor_items FOR UPDATE
  USING (EXISTS (SELECT 1 FROM rfq_vendors rv JOIN rfqs r ON r.id = rv.rfq_id
                  WHERE rv.id = rfq_vendor_items.rfq_vendor_id
                    AND user_can_access_business(auth.uid(), r.business_id)));
CREATE POLICY rfq_vendor_items_delete ON public.rfq_vendor_items FOR DELETE
  USING (EXISTS (SELECT 1 FROM rfq_vendors rv JOIN rfqs r ON r.id = rv.rfq_id
                  WHERE rv.id = rfq_vendor_items.rfq_vendor_id
                    AND user_can_access_business(auth.uid(), r.business_id)));