-- ---------------------------------------------------------------------------
-- Phase 4 producers: analytic attribution on bill and invoice lines.
-- The analytic ledger (journal_entry_line_analytics) is materialised by the
-- database from journal_entry_lines.analytic_account_id. Producers therefore
-- only need to carry the attribution into the JE line array they hand to
-- post_journal_entry_atomic.
-- ---------------------------------------------------------------------------

ALTER TABLE public.bill_items
  ADD COLUMN IF NOT EXISTS analytic_account_id uuid
    REFERENCES public.analytic_accounts(id) ON DELETE RESTRICT;

ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS analytic_account_id uuid
    REFERENCES public.analytic_accounts(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_bill_items_analytic_account
  ON public.bill_items(analytic_account_id) WHERE analytic_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_items_analytic_account
  ON public.invoice_items(analytic_account_id) WHERE analytic_account_id IS NOT NULL;

-- Guard: the attributed analytic account must live in the document's business
-- and be postable. Business is resolved from the parent document so it also
-- works for bill_items, which carries no business_id of its own.
CREATE OR REPLACE FUNCTION public._assert_document_line_analytic_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_business uuid;
  v_acct record;
BEGIN
  IF NEW.analytic_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'bill_items' THEN
    SELECT b.business_id INTO v_business FROM public.bills b WHERE b.id = NEW.bill_id;
  ELSE
    SELECT i.business_id INTO v_business FROM public.invoices i WHERE i.id = NEW.invoice_id;
  END IF;

  SELECT id, business_id, status INTO v_acct
    FROM public.analytic_accounts WHERE id = NEW.analytic_account_id;

  IF v_acct.id IS NULL THEN
    RAISE EXCEPTION 'Analytic account % does not exist', NEW.analytic_account_id
      USING ERRCODE = '23503';
  END IF;
  IF v_business IS NOT NULL AND v_acct.business_id IS DISTINCT FROM v_business THEN
    RAISE EXCEPTION 'Analytic account belongs to another company'
      USING ERRCODE = '42501';
  END IF;
  IF v_acct.status NOT IN ('active', 'draft') THEN
    RAISE EXCEPTION 'Analytic account is % and cannot be used on new documents', v_acct.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bill_items_analytic_guard ON public.bill_items;
CREATE TRIGGER trg_bill_items_analytic_guard
  BEFORE INSERT OR UPDATE OF analytic_account_id ON public.bill_items
  FOR EACH ROW EXECUTE FUNCTION public._assert_document_line_analytic_account();

DROP TRIGGER IF EXISTS trg_invoice_items_analytic_guard ON public.invoice_items;
CREATE TRIGGER trg_invoice_items_analytic_guard
  BEFORE INSERT OR UPDATE OF analytic_account_id ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._assert_document_line_analytic_account();

-- ---------------------------------------------------------------------------
-- Invoice revenue lines: group by resolved revenue account AND analytic axis.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.build_invoice_je_lines(p_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
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

  v_lines := v_lines || jsonb_build_object(
    'account_id', v_ar_account,
    'debit', ROUND(COALESCE(v_inv.total, 0), 2),
    'credit', 0,
    'description', 'Invoice ' || v_inv.invoice_number || ' - Accounts Receivable',
    'contact_id', v_inv.contact_id
  );

  -- Revenue credits, grouped by resolved account and analytic attribution.
  FOR v_rev IN
    SELECT COALESCE(
             public.resolve_product_gl_account(
               v_inv.organization_id, v_inv.business_id, ii.product_id, 'sales_revenue'),
             v_default_revenue) AS account_id,
           ii.analytic_account_id AS analytic_account_id,
           ROUND(SUM(COALESCE(ii.line_total, 0)), 2) AS amount
      FROM public.invoice_items ii
     WHERE ii.invoice_id = p_invoice_id
     GROUP BY 1, 2
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
      'description', 'Invoice ' || v_inv.invoice_number || ' - Sales Revenue',
      'analytic_account_id', v_rev.analytic_account_id
    );
  END LOOP;

  IF v_unmapped > 0 THEN
    RAISE EXCEPTION 'No Sales Revenue account is mapped for % invoice line group(s). Map product/category revenue accounts or the Sales Revenue default.', v_unmapped
      USING ERRCODE = 'check_violation';
  END IF;

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

-- ---------------------------------------------------------------------------
-- Bill debit lines: group by resolved account AND analytic axis.
-- Only the grouping key and the emitted analytic_account_id change.
-- ---------------------------------------------------------------------------
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
    ) AS acct_id,
    bi.analytic_account_id AS analytic_account_id,
    ROUND(SUM(bi.line_total), 2) AS amt
    FROM public.bill_items bi
    LEFT JOIN public.products p ON p.id = bi.product_id
    LEFT JOIN public.purchase_order_items poi ON poi.id = bi.purchase_order_item_id
    LEFT JOIN public.contacts c ON c.id = v_bill.vendor_id
    WHERE bi.bill_id = v_bill.id
    GROUP BY 1, 2
  )
  SELECT jsonb_agg(
           jsonb_build_object(
             'account_id', acct_id,
             'debit', amt,
             'credit', 0,
             'description', 'Bill ' || v_bill.bill_number || ' — line group',
             'analytic_account_id', analytic_account_id
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