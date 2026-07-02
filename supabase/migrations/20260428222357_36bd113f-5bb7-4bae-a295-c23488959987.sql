-- Wave 0 — P0: invoice confirmation must work on every freshly-seeded org

-- 1. Template gets a detail_type column
ALTER TABLE public.default_chart_of_accounts
  ADD COLUMN IF NOT EXISTS detail_type text;

UPDATE public.default_chart_of_accounts
SET detail_type = CASE
  WHEN account_type = 'asset' AND (lower(account_name) ~ 'receivable|debtor' OR account_code LIKE '12%') THEN 'accounts_receivable'
  WHEN account_type = 'asset' AND (lower(account_name) ~ 'cash|petty') THEN 'cash_on_hand'
  WHEN account_type = 'asset' AND lower(account_name) ~ 'bank|checking' THEN 'checking'
  WHEN account_type = 'asset' AND lower(account_name) ~ 'savings' THEN 'savings'
  WHEN account_type = 'asset' AND lower(account_name) ~ 'inventory|stock' THEN 'inventory'
  WHEN account_type = 'asset' AND lower(account_name) ~ 'input tax|tax input|gst receivable|prepaid tax' THEN 'tax_input'
  WHEN account_type = 'asset' AND lower(account_name) ~ 'fixed asset|equipment|machinery|vehicle|building|land' THEN 'fixed_asset_other'
  WHEN account_type = 'asset' AND lower(account_name) ~ 'accumulated depreciation' THEN 'accumulated_depreciation'
  WHEN account_type = 'liability' AND (lower(account_name) ~ 'payable|creditor' AND lower(account_name) !~ 'tax|vat') THEN 'accounts_payable'
  WHEN account_type = 'liability' AND lower(account_name) ~ 'sales tax|vat payable|output tax' THEN 'sales_tax_payable'
  WHEN account_type = 'liability' AND lower(account_name) ~ 'customer deposit|unearned' THEN 'customer_deposits'
  WHEN account_type = 'income' AND lower(account_name) ~ 'service' THEN 'service_income'
  WHEN account_type = 'income' AND lower(account_name) ~ 'interest' THEN 'interest_income'
  WHEN account_type = 'income' AND lower(account_name) ~ 'rental|rent income' THEN 'rental_income'
  WHEN account_type = 'income' AND lower(account_name) ~ 'other income' THEN 'other_income'
  WHEN account_type = 'income' THEN 'sales_income'
  WHEN account_type = 'expense' AND lower(account_name) ~ 'cost of goods|cogs' THEN 'cost_of_goods_sold'
  WHEN account_type = 'expense' AND lower(account_name) ~ 'depreciation' THEN 'depreciation'
  WHEN account_type = 'expense' AND lower(account_name) ~ 'rent' THEN 'rent_expense'
  WHEN account_type = 'expense' AND lower(account_name) ~ 'salaries|wages|payroll' THEN 'payroll_expense'
  WHEN account_type = 'expense' AND lower(account_name) ~ 'utilit' THEN 'utilities'
  WHEN account_type = 'expense' AND lower(account_name) ~ 'bank charge|bank fee' THEN 'bank_charges'
  WHEN account_type = 'expense' AND lower(account_name) ~ 'insurance' THEN 'insurance_expense'
  WHEN account_type = 'expense' AND lower(account_name) ~ 'office' THEN 'office_expenses'
  WHEN account_type = 'expense' AND lower(account_name) ~ 'travel' THEN 'travel'
  WHEN account_type = 'expense' AND lower(account_name) ~ 'legal|professional' THEN 'legal_professional_fees'
  WHEN account_type = 'expense' THEN 'other_business_expenses'
  WHEN account_type = 'equity' AND lower(account_name) ~ 'retained' THEN 'retained_earnings'
  WHEN account_type = 'equity' AND lower(account_name) ~ 'opening balance' THEN 'opening_balance_equity'
  ELSE detail_type
END
WHERE detail_type IS NULL;

-- 2. Idempotent backfill function for live accounts
CREATE OR REPLACE FUNCTION public.backfill_account_detail_types(
  _org_id uuid DEFAULT NULL,
  _business_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_updated integer;
BEGIN
  WITH upd AS (
    UPDATE public.accounts a
    SET detail_type = CASE
      WHEN a.account_type = 'asset' AND (lower(a.name) ~ 'receivable|debtor' OR a.code LIKE '12%') THEN 'accounts_receivable'
      WHEN a.account_type = 'asset' AND (lower(a.name) ~ 'cash|petty') THEN 'cash_on_hand'
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'bank|checking' THEN 'checking'
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'savings' THEN 'savings'
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'inventory|stock' THEN 'inventory'
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'input tax|tax input|gst receivable|prepaid tax' THEN 'tax_input'
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'fixed asset|equipment|machinery|vehicle|building|land' THEN 'fixed_asset_other'
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'accumulated depreciation' THEN 'accumulated_depreciation'
      WHEN a.account_type = 'liability' AND (lower(a.name) ~ 'payable|creditor' AND lower(a.name) !~ 'tax|vat') THEN 'accounts_payable'
      WHEN a.account_type = 'liability' AND lower(a.name) ~ 'sales tax|vat payable|output tax' THEN 'sales_tax_payable'
      WHEN a.account_type = 'liability' AND lower(a.name) ~ 'customer deposit|unearned' THEN 'customer_deposits'
      WHEN a.account_type = 'income' AND lower(a.name) ~ 'service' THEN 'service_income'
      WHEN a.account_type = 'income' AND lower(a.name) ~ 'interest' THEN 'interest_income'
      WHEN a.account_type = 'income' AND lower(a.name) ~ 'rental|rent income' THEN 'rental_income'
      WHEN a.account_type = 'income' AND lower(a.name) ~ 'other income' THEN 'other_income'
      WHEN a.account_type = 'income' THEN 'sales_income'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'cost of goods|cogs' THEN 'cost_of_goods_sold'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'depreciation' THEN 'depreciation'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'rent' THEN 'rent_expense'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'salaries|wages|payroll' THEN 'payroll_expense'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'utilit' THEN 'utilities'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'bank charge|bank fee' THEN 'bank_charges'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'insurance' THEN 'insurance_expense'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'office' THEN 'office_expenses'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'travel' THEN 'travel'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'legal|professional' THEN 'legal_professional_fees'
      WHEN a.account_type = 'expense' THEN 'other_business_expenses'
      WHEN a.account_type = 'equity' AND lower(a.name) ~ 'retained' THEN 'retained_earnings'
      WHEN a.account_type = 'equity' AND lower(a.name) ~ 'opening balance' THEN 'opening_balance_equity'
      ELSE a.detail_type
    END
    WHERE a.detail_type IS NULL
      AND (_org_id IS NULL OR a.organization_id = _org_id)
      AND (_business_id IS NULL OR a.business_id = _business_id)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_updated FROM upd;
  RETURN COALESCE(v_updated, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.backfill_account_detail_types(uuid, uuid) TO authenticated;

-- 3. Heal every existing account NOW
SELECT public.backfill_account_detail_types(NULL, NULL);

-- 4. Update the seeder to copy detail_type and self-heal at the end
CREATE OR REPLACE FUNCTION public.provision_default_chart_of_accounts(
  _org_id uuid,
  _business_id uuid,
  _country_code text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _template public.default_chart_of_accounts%ROWTYPE;
  _parent_id uuid;
  _new_id uuid;
  _code_to_id jsonb := '{}'::jsonb;
  _accounts_created integer := 0;
  _resolved_country text := upper(coalesce(_country_code, 'INT'));
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.default_chart_of_accounts WHERE country_code = _resolved_country LIMIT 1
  ) THEN
    _resolved_country := 'INT';
  END IF;

  FOR _template IN
    SELECT * FROM public.default_chart_of_accounts
    WHERE country_code = _resolved_country
      AND is_country_neutral = true
      AND account_name !~* '\m(nhif|shif|paye|nssf|housing\s*levy|uif|sdl|wcf|skills\s*levy|gratuity|epf|esic|provident\s*fund|pf\s*payable|kra|sars|ura|tra|bir)\m'
    ORDER BY account_code
  LOOP
    _parent_id := NULL;
    IF _template.parent_code IS NOT NULL THEN
      _parent_id := NULLIF(_code_to_id->>_template.parent_code, '')::uuid;
    END IF;

    INSERT INTO public.accounts (
      organization_id, business_id, code, name, account_type,
      detail_type, parent_id, description, is_system, is_active
    ) VALUES (
      _org_id, _business_id, _template.account_code, _template.account_name,
      _template.account_type, _template.detail_type,
      _parent_id, _template.description,
      coalesce(_template.is_system, false), true
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO _new_id;

    IF _new_id IS NOT NULL THEN
      _code_to_id := _code_to_id || jsonb_build_object(_template.account_code, _new_id::text);
      _accounts_created := _accounts_created + 1;
    END IF;
  END LOOP;

  PERFORM public.backfill_account_detail_types(_org_id, _business_id);

  RETURN _accounts_created;
END;
$function$;

-- 5. Harden confirm_invoice_atomic (AR/Tax classification widened)
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
  v_default_ar_id uuid;
  v_default_tax_id uuid;
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

  SELECT account_id INTO v_default_ar_id FROM public.default_account_settings
   WHERE organization_id = v_inv.organization_id AND business_id = v_inv.business_id
     AND setting_key = 'accounts_receivable' LIMIT 1;
  SELECT account_id INTO v_default_tax_id FROM public.default_account_settings
   WHERE organization_id = v_inv.organization_id AND business_id = v_inv.business_id
     AND setting_key = 'output_tax' LIMIT 1;

  WITH lines AS (
    SELECT * FROM jsonb_to_recordset(p_main_lines) AS l(account_id uuid, debit numeric, credit numeric, contact_id uuid)
  ),
  classified AS (
    SELECT
      l.*,
      a.account_type, a.detail_type, a.name,
      a.organization_id AS a_org, a.business_id AS a_biz, a.is_active AS a_active,
      (a.detail_type = 'accounts_receivable'
        OR (a.account_type = 'asset' AND lower(a.name) ~ 'receivable|debtor')
        OR (v_default_ar_id IS NOT NULL AND l.account_id = v_default_ar_id)
      ) AS is_ar,
      (a.account_type = 'income'
        OR a.detail_type IN ('sales_income','service_income','revenue_general','sales_revenue','revenue','income','interest_income','rental_income','other_income')
      ) AS is_revenue,
      (a.detail_type IN ('sales_tax_payable','tax_payable','sales_tax','output_tax')
        OR (a.account_type = 'liability' AND lower(a.name) ~ 'tax|vat')
        OR (v_default_tax_id IS NOT NULL AND l.account_id = v_default_tax_id)
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
    RAISE EXCEPTION 'Invoice JE must contain an Accounts Receivable debit line. Map an AR account in Settings > Default Accounts.';
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

  RETURN jsonb_build_object('success', true, 'journal_entry_id', v_je_id, 'cogs_journal_entry_id', v_cogs_je_id);
END;
$function$;