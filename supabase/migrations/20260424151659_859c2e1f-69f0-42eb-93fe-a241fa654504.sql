-- Final finance hardening pass: server-side posting validation for invoices and bills.

CREATE OR REPLACE FUNCTION public.assert_account_in_business(
  _account_id uuid,
  _organization_id uuid,
  _business_id uuid,
  _expected_detail_type text DEFAULT NULL,
  _label text DEFAULT 'account'
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account record;
BEGIN
  IF _account_id IS NULL THEN
    RAISE EXCEPTION '% is required', _label;
  END IF;

  SELECT organization_id, business_id, detail_type, is_active
    INTO v_account
  FROM public.accounts
  WHERE id = _account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION '% not found', _label;
  END IF;

  IF v_account.organization_id IS DISTINCT FROM _organization_id
     OR v_account.business_id IS DISTINCT FROM _business_id THEN
    RAISE EXCEPTION '% belongs to a different organization/company', _label;
  END IF;

  IF COALESCE(v_account.is_active, true) = false THEN
    RAISE EXCEPTION '% is inactive', _label;
  END IF;

  IF _expected_detail_type IS NOT NULL
     AND v_account.detail_type IS DISTINCT FROM _expected_detail_type THEN
    RAISE EXCEPTION '% must be a % account', _label, _expected_detail_type;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_contact_in_business(
  _contact_id uuid,
  _organization_id uuid,
  _business_id uuid,
  _label text DEFAULT 'contact'
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact record;
BEGIN
  IF _contact_id IS NULL THEN
    RETURN;
  END IF;

  SELECT organization_id, business_id
    INTO v_contact
  FROM public.contacts
  WHERE id = _contact_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION '% not found', _label;
  END IF;

  IF v_contact.organization_id IS DISTINCT FROM _organization_id
     OR (v_contact.business_id IS NOT NULL AND v_contact.business_id IS DISTINCT FROM _business_id) THEN
    RAISE EXCEPTION '% belongs to a different organization/company', _label;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_no_existing_source_posting(
  _organization_id uuid,
  _source_type text,
  _source_id uuid,
  _source_subtype text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.journal_entries je
    WHERE je.organization_id = _organization_id
      AND public.normalize_journal_source_type(je.source_type) = public.normalize_journal_source_type(_source_type)
      AND je.source_id = _source_id
      AND COALESCE(je.source_subtype, 'main') = COALESCE(_source_subtype, 'main')
      AND je.status <> 'voided'
  ) THEN
    RAISE EXCEPTION 'A non-voided journal entry already exists for this % posting', public.normalize_journal_source_type(_source_type);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_invoice_atomic(
  p_invoice_id uuid,
  p_user_id uuid,
  p_main_lines jsonb,
  p_cogs_lines jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM public.invoices
  WHERE id = p_invoice_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % not found', p_invoice_id;
  END IF;

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
  FROM public.invoice_items
  WHERE invoice_id = p_invoice_id;

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
  )
  SELECT
    COALESCE(SUM(debit), 0),
    COALESCE(SUM(credit), 0),
    COALESCE(SUM(CASE WHEN a.detail_type = 'accounts_receivable' THEN debit ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN a.detail_type IN ('sales_revenue','revenue','income') OR a.account_type = 'revenue' THEN credit ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN a.detail_type IN ('tax_payable','sales_tax','output_tax') OR lower(a.name) LIKE '%tax%' THEN credit ELSE 0 END), 0),
    COUNT(*) FILTER (WHERE a.id IS NULL OR a.organization_id IS DISTINCT FROM v_inv.organization_id OR a.business_id IS DISTINCT FROM v_inv.business_id OR COALESCE(a.is_active, true) = false),
    COUNT(*) FILTER (WHERE l.contact_id IS NOT NULL AND (c.id IS NULL OR c.organization_id IS DISTINCT FROM v_inv.organization_id OR (c.business_id IS NOT NULL AND c.business_id IS DISTINCT FROM v_inv.business_id)))
  INTO v_main_debits, v_main_credits, v_ar_debit, v_revenue_credit, v_tax_credit, v_bad_accounts, v_bad_contacts
  FROM lines l
  LEFT JOIN public.accounts a ON a.id = l.account_id
  LEFT JOIN public.contacts c ON c.id = l.contact_id;

  IF v_bad_accounts > 0 THEN
    RAISE EXCEPTION 'Invoice posting lines contain accounts outside the invoice company or inactive accounts';
  END IF;
  IF v_bad_contacts > 0 THEN
    RAISE EXCEPTION 'Invoice posting lines contain contacts outside the invoice company';
  END IF;
  IF ABS(v_main_debits - v_main_credits) > 0.01 THEN
    RAISE EXCEPTION 'Invoice journal entry is not balanced: debits=%, credits=%', v_main_debits, v_main_credits;
  END IF;
  IF ABS(v_ar_debit - v_inv.total) > 0.01 THEN
    RAISE EXCEPTION 'Invoice AR debit must equal invoice total';
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
    FROM cogs l
    LEFT JOIN public.accounts a ON a.id = l.account_id;

    IF v_bad_accounts > 0 THEN
      RAISE EXCEPTION 'Invoice COGS lines contain accounts outside the invoice company or inactive accounts';
    END IF;
    IF ABS(v_cogs_debits - v_cogs_credits) > 0.01 THEN
      RAISE EXCEPTION 'Invoice COGS journal entry is not balanced';
    END IF;
  END IF;

  SELECT public.get_next_journal_entry_number(v_inv.organization_id) INTO v_main_entry_no;

  v_je_id := public.post_journal_entry_atomic(
    _org_id          := v_inv.organization_id,
    _business_id     := v_inv.business_id,
    _entry_number    := v_main_entry_no,
    _entry_date      := v_inv.issue_date,
    _reference       := v_inv.invoice_number,
    _description     := 'Invoice ' || v_inv.invoice_number || ' confirmed',
    _source_type     := 'invoice',
    _source_id       := p_invoice_id,
    _created_by      := p_user_id,
    _is_closing      := false,
    _is_adjusting    := false,
    _lines           := p_main_lines,
    _currency        := v_inv.currency,
    _exchange_rate   := NULL,
    _source_subtype  := NULL,
    _branch_id       := v_inv.branch_id
  );

  IF p_cogs_lines IS NOT NULL AND jsonb_array_length(p_cogs_lines) >= 2 THEN
    SELECT public.get_next_journal_entry_number(v_inv.organization_id) INTO v_cogs_entry_no;
    v_cogs_je_id := public.post_journal_entry_atomic(
      _org_id          := v_inv.organization_id,
      _business_id     := v_inv.business_id,
      _entry_number    := v_cogs_entry_no,
      _entry_date      := v_inv.issue_date,
      _reference       := 'COGS-' || v_inv.invoice_number,
      _description     := 'COGS for Invoice ' || v_inv.invoice_number,
      _source_type     := 'invoice',
      _source_id       := p_invoice_id,
      _created_by      := p_user_id,
      _is_closing      := false,
      _is_adjusting    := false,
      _lines           := p_cogs_lines,
      _currency        := v_inv.currency,
      _exchange_rate   := NULL,
      _source_subtype  := 'cogs',
      _branch_id       := v_inv.branch_id
    );
  END IF;

  UPDATE public.invoices
  SET status = 'confirmed',
      confirmed_by = p_user_id,
      journal_entry_id = v_je_id,
      updated_at = now()
  WHERE id = p_invoice_id;

  RETURN jsonb_build_object(
    'success', true,
    'journal_entry_id', v_je_id,
    'cogs_journal_entry_id', v_cogs_je_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_invoice_atomic(uuid, uuid, jsonb, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.confirm_invoice_atomic(uuid, uuid, jsonb, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.confirm_bill_atomic(_bill_id uuid, _user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  v_attempts int := 0;
  v_max_attempts int := 20;
  v_total_debits numeric := 0;
  v_sort int := 0;
  v_line_count integer := 0;
  v_items_subtotal numeric := 0;
  v_items_tax numeric := 0;
  v_bad_products integer := 0;
  v_bad_line_accounts integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT id, organization_id, business_id, branch_id, vendor_id, bill_number,
         bill_date, status, subtotal, tax_amount, discount_amount, total, journal_entry_id
    INTO v_bill
  FROM public.bills
  WHERE id = _bill_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bill not found';
  END IF;
  IF v_bill.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft bills can be confirmed (current: %)', v_bill.status;
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

  LOOP
    v_attempts := v_attempts + 1;
    IF v_attempts > v_max_attempts THEN
      RAISE EXCEPTION 'Unable to allocate JE number after % attempts', v_max_attempts;
    END IF;
    v_je_number := public.generate_next_je_number(v_bill.organization_id, v_bill.business_id);
    BEGIN
      INSERT INTO public.journal_entries (organization_id, business_id, branch_id, entry_number,
        entry_date, reference, description, source_type, source_id, status, created_by)
      VALUES (v_bill.organization_id, v_bill.business_id, v_bill.branch_id, v_je_number,
        v_bill.bill_date, v_bill.bill_number, 'Bill ' || v_bill.bill_number || ' confirmed',
        'bill', v_bill.id, 'posted', _user_id)
      RETURNING id INTO v_je_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF POSITION('journal_entries_organization_id_entry_number_key' IN SQLERRM) > 0 THEN
        CONTINUE;
      ELSE
        RAISE;
      END IF;
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
    FROM public.bill_items bi
    LEFT JOIN public.products p ON p.id = bi.product_id
    LEFT JOIN public.purchase_order_items poi ON poi.id = bi.purchase_order_item_id
    LEFT JOIN public.contacts c ON c.id = v_bill.vendor_id
    WHERE bi.bill_id = v_bill.id
    GROUP BY 1
  )
  INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit,
    description, business_id, branch_id, sort_order)
  SELECT v_je_id, r.acct_id, ROUND(r.amt, 2), 0,
    'Bill ' || v_bill.bill_number || ' — line group',
    v_bill.business_id, v_bill.branch_id,
    ROW_NUMBER() OVER (ORDER BY r.acct_id) - 1
  FROM resolved r
  WHERE r.acct_id IS NOT NULL;

  GET DIAGNOSTICS v_sort = ROW_COUNT;

  IF v_sort = 0 THEN
    RAISE EXCEPTION 'Bill % produced no debit lines; cannot confirm', v_bill.bill_number;
  END IF;

  IF v_bill.tax_amount IS NOT NULL AND v_bill.tax_amount > 0 THEN
    IF v_default_tax IS NULL THEN
      RAISE EXCEPTION 'Cannot confirm bill %: input tax account is required for taxable bill', v_bill.bill_number;
    END IF;
    INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit,
      description, business_id, branch_id, sort_order)
    VALUES (v_je_id, v_default_tax, ROUND(v_bill.tax_amount, 2), 0,
      'Bill ' || v_bill.bill_number || ' — input tax',
      v_bill.business_id, v_bill.branch_id, v_sort);
    v_sort := v_sort + 1;
  END IF;

  SELECT COALESCE(SUM(debit), 0) INTO v_total_debits
    FROM public.journal_entry_lines WHERE journal_entry_id = v_je_id;

  IF ABS(v_total_debits - v_bill.total) > 0.001 AND ABS(v_total_debits - v_bill.total) < 0.05 THEN
    UPDATE public.journal_entry_lines
    SET debit = debit + (v_bill.total - v_total_debits)
    WHERE id = (
      SELECT id FROM public.journal_entry_lines
      WHERE journal_entry_id = v_je_id AND debit > 0
      ORDER BY debit DESC LIMIT 1
    );
  ELSIF ABS(v_total_debits - v_bill.total) >= 0.05 THEN
    RAISE EXCEPTION 'Bill % cannot be balanced: debits=%, total=%', v_bill.bill_number, v_total_debits, v_bill.total;
  END IF;

  INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit,
    description, contact_id, business_id, branch_id, sort_order)
  VALUES (v_je_id, v_effective_ap, 0, v_bill.total,
    'Bill ' || v_bill.bill_number || ' — Accounts Payable',
    v_bill.vendor_id, v_bill.business_id, v_bill.branch_id, v_sort);

  UPDATE public.bills
  SET status = 'received'::bill_status,
      journal_entry_id = v_je_id,
      updated_at = now()
  WHERE id = v_bill.id;

  RETURN jsonb_build_object('success', true, 'journal_entry_id', v_je_id,
    'journal_entry_number', v_je_number, 'status', 'received');
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_bill_atomic(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.confirm_bill_atomic(uuid, uuid) TO authenticated;

CREATE OR REPLACE VIEW public.accounting_integrity_findings_supplemental
WITH (security_invoker = true) AS
SELECT gen_random_uuid() AS id, bt.organization_id, bt.business_id, NULL::uuid AS branch_id,
  'critical'::text AS severity,
  'bank_reconciled_without_confirmed_match'::text AS finding_code,
  'Bank transaction is marked reconciled without a confirmed reconciliation match'::text AS finding_title,
  format('Bank transaction %s is reconciled but has no confirmed match row.', bt.reference) AS finding_detail,
  'bank_transaction'::text AS entity_type,
  bt.id AS entity_id,
  bt.reference AS entity_ref,
  jsonb_build_object('bank_transaction_id', bt.id, 'reconciled_type', bt.reconciled_type, 'reconciled_entity_id', bt.reconciled_entity_id) AS evidence,
  now() AS detected_at
FROM public.bank_transactions bt
WHERE COALESCE(bt.is_reconciled, false) = true
  AND NOT EXISTS (
    SELECT 1 FROM public.bank_reconciliation_matches m
    WHERE m.bank_transaction_id = bt.id AND m.status IN ('confirmed','to_check')
  )
UNION ALL
SELECT gen_random_uuid(), m.organization_id, m.business_id, m.branch_id,
  'critical', 'confirmed_reconciliation_match_without_source',
  'Confirmed bank reconciliation match has no matched accounting source',
  format('Match %s is confirmed but has no payment, bill payment, journal entry, source entity, or write-off.', m.id),
  'bank_reconciliation_match', m.id, m.id::text,
  jsonb_build_object('bank_transaction_id', m.bank_transaction_id, 'match_type', m.match_type, 'status', m.status), now()
FROM public.bank_reconciliation_matches m
WHERE m.status = 'confirmed'
  AND m.matched_journal_entry_id IS NULL
  AND m.matched_payment_id IS NULL
  AND m.matched_bill_payment_id IS NULL
  AND m.matched_entity_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.bank_reconciliation_writeoffs w
    WHERE w.reconciliation_match_id = m.id AND w.status IN ('draft','posted')
  )
UNION ALL
SELECT gen_random_uuid(), m.organization_id, m.business_id, m.branch_id,
  'critical', 'writeoff_journal_state_mismatch',
  'Bank reconciliation write-off journal entry state does not match lifecycle state',
  format('Write-off %s has status %s but journal entry is missing or not posted/reversed consistently.', w.id, w.status),
  'bank_reconciliation_writeoff', w.id, w.id::text,
  jsonb_build_object('match_id', m.id, 'journal_entry_id', w.journal_entry_id, 'writeoff_status', w.status, 'journal_status', je.status), now()
FROM public.bank_reconciliation_writeoffs w
JOIN public.bank_reconciliation_matches m ON m.id = w.reconciliation_match_id
LEFT JOIN public.journal_entries je ON je.id = w.journal_entry_id
WHERE (w.status = 'posted' AND (w.journal_entry_id IS NULL OR je.status IS DISTINCT FROM 'posted'))
   OR (w.status = 'reversed' AND w.journal_entry_id IS NOT NULL AND je.status = 'posted')
UNION ALL
SELECT gen_random_uuid(), inv.organization_id, inv.business_id, inv.branch_id,
  'critical', 'posted_invoice_missing_journal_entry',
  'Posted invoice has no linked posted journal entry',
  format('Invoice %s is %s but has no linked posted journal entry.', inv.invoice_number, inv.status),
  'invoice', inv.id, inv.invoice_number,
  jsonb_build_object('invoice_status', inv.status, 'journal_entry_id', inv.journal_entry_id, 'journal_status', je.status), now()
FROM public.invoices inv
LEFT JOIN public.journal_entries je ON je.id = inv.journal_entry_id
WHERE inv.status::text NOT IN ('draft','cancelled','voided','void')
  AND (inv.journal_entry_id IS NULL OR je.status IS DISTINCT FROM 'posted')
UNION ALL
SELECT gen_random_uuid(), b.organization_id, b.business_id, b.branch_id,
  'critical', 'posted_bill_missing_journal_entry',
  'Posted bill has no linked posted journal entry',
  format('Bill %s is %s but has no linked posted journal entry.', b.bill_number, b.status),
  'bill', b.id, b.bill_number,
  jsonb_build_object('bill_status', b.status, 'journal_entry_id', b.journal_entry_id, 'journal_status', je.status), now()
FROM public.bills b
LEFT JOIN public.journal_entries je ON je.id = b.journal_entry_id
WHERE b.status::text NOT IN ('draft','void','voided','cancelled')
  AND (b.journal_entry_id IS NULL OR je.status IS DISTINCT FROM 'posted')
UNION ALL
SELECT gen_random_uuid(), p.organization_id, p.business_id, NULL::uuid,
  'critical', 'customer_payment_missing_posted_journal_entry',
  'Customer payment is applied without a posted journal entry',
  format('Payment %s is applied but has no linked posted journal entry.', COALESCE(p.receipt_number, p.id::text)),
  'payment', p.id, COALESCE(p.receipt_number, p.id::text),
  jsonb_build_object('invoice_id', p.invoice_id, 'amount', p.amount, 'journal_entry_id', p.journal_entry_id, 'journal_status', je.status), now()
FROM public.payments p
LEFT JOIN public.journal_entries je ON je.id = p.journal_entry_id
WHERE COALESCE(p.status::text, '') NOT IN ('voided','cancelled','unreconciled')
  AND (p.journal_entry_id IS NULL OR je.status IS DISTINCT FROM 'posted')
UNION ALL
SELECT gen_random_uuid(), bp.organization_id, bp.business_id, NULL::uuid,
  'critical', 'vendor_payment_missing_posted_journal_entry',
  'Vendor payment is applied without a posted journal entry',
  format('Bill payment %s is applied but has no linked posted journal entry.', bp.id),
  'bill_payment', bp.id, bp.id::text,
  jsonb_build_object('bill_id', bp.bill_id, 'amount', bp.amount, 'journal_entry_id', bp.journal_entry_id, 'journal_status', je.status), now()
FROM public.bill_payments bp
LEFT JOIN public.journal_entries je ON je.id = bp.journal_entry_id
WHERE bp.journal_entry_id IS NULL OR je.status IS DISTINCT FROM 'posted'
UNION ALL
SELECT gen_random_uuid(), je.organization_id, je.business_id, je.branch_id,
  'critical', 'source_posting_duplicate_canonical_alias',
  'Multiple non-voided journal entries exist for the same canonical source',
  format('Source %s/%s has duplicate non-voided postings.', public.normalize_journal_source_type(je.source_type), je.source_id),
  'journal_entry', je.id, je.entry_number,
  jsonb_build_object('source_type', je.source_type, 'source_id', je.source_id, 'source_subtype', je.source_subtype), now()
FROM public.journal_entries je
WHERE je.source_id IS NOT NULL
  AND je.status <> 'voided'
  AND EXISTS (
    SELECT 1
    FROM public.journal_entries other
    WHERE other.id <> je.id
      AND other.organization_id = je.organization_id
      AND public.normalize_journal_source_type(other.source_type) = public.normalize_journal_source_type(je.source_type)
      AND other.source_id = je.source_id
      AND COALESCE(other.source_subtype, 'main') = COALESCE(je.source_subtype, 'main')
      AND other.status <> 'voided'
  )
UNION ALL
SELECT gen_random_uuid(), je.organization_id, je.business_id, je.branch_id,
  'warning', 'legacy_direct_bank_recon_posting',
  'Legacy bank reconciliation journal entry may bypass the canonical match lifecycle',
  format('Journal entry %s uses legacy source type %s.', je.entry_number, je.source_type),
  'journal_entry', je.id, je.entry_number,
  jsonb_build_object('source_type', je.source_type, 'source_id', je.source_id), now()
FROM public.journal_entries je
WHERE je.status = 'posted'
  AND public.normalize_journal_source_type(je.source_type) IN ('bank_recon','bank_reconciliation')
  AND NOT EXISTS (
    SELECT 1 FROM public.bank_reconciliation_matches m
    WHERE m.matched_journal_entry_id = je.id
       OR m.bank_transaction_id = je.source_id
  );

GRANT SELECT ON public.accounting_integrity_findings_supplemental TO authenticated;

CREATE OR REPLACE FUNCTION public.get_accounting_integrity_findings(_include_supplemental boolean DEFAULT true)
RETURNS TABLE(
  id uuid,
  organization_id uuid,
  business_id uuid,
  branch_id uuid,
  severity text,
  finding_code text,
  finding_title text,
  finding_detail text,
  entity_type text,
  entity_id uuid,
  entity_ref text,
  evidence jsonb,
  detected_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.accounting_integrity_findings
  UNION ALL
  SELECT * FROM public.accounting_integrity_findings_supplemental WHERE _include_supplemental;
$$;

REVOKE ALL ON FUNCTION public.get_accounting_integrity_findings(boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.get_accounting_integrity_findings(boolean) TO authenticated;