-- =============================================================================
-- Fix: confirm_invoice_atomic referenced 'revenue' as account_type enum value,
-- but the enum is {asset, liability, equity, income, expense}. Postgres
-- aborted the RPC with `invalid input value for enum account_type: "revenue"`,
-- breaking every invoice confirmation in every tenant.
--
-- This migration:
--   1. Replaces confirm_invoice_atomic with the corrected literal ('income')
--      and adds a defensive presence check for revenue + AR lines.
--   2. Backfills accounts.detail_type where NULL on income / expense / AR / AP
--      rows so the primary detail_type matcher works on its own and the
--      account_type fallback becomes truly defensive.
-- =============================================================================

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
    -- FIX: enum is {asset,liability,equity,income,expense}. Was 'revenue' which
    -- caused: invalid input value for enum account_type: "revenue".
    COALESCE(SUM(CASE
      WHEN a.detail_type IN ('sales_revenue','sales_income','revenue_general','service_income','revenue','income')
        OR a.account_type = 'income'
      THEN credit ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN a.detail_type IN ('tax_payable','sales_tax_payable','sales_tax','output_tax') OR lower(a.name) LIKE '%tax%' THEN credit ELSE 0 END), 0),
    COUNT(*) FILTER (WHERE a.id IS NULL OR a.organization_id IS DISTINCT FROM v_inv.organization_id OR a.business_id IS DISTINCT FROM v_inv.business_id OR COALESCE(a.is_active, true) = false),
    COUNT(*) FILTER (WHERE l.contact_id IS NOT NULL AND (c.id IS NULL OR c.organization_id IS DISTINCT FROM v_inv.organization_id OR (c.business_id IS NOT NULL AND c.business_id IS DISTINCT FROM v_inv.business_id))),
    COUNT(*) FILTER (WHERE a.account_type = 'income' AND COALESCE(credit, 0) > 0),
    COUNT(*) FILTER (WHERE a.detail_type = 'accounts_receivable' AND COALESCE(debit, 0) > 0)
  INTO v_main_debits, v_main_credits, v_ar_debit, v_revenue_credit, v_tax_credit, v_bad_accounts, v_bad_contacts, v_revenue_line_count, v_ar_line_count
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
  -- Defensive structural assertions (Fix 4): reject malformed JEs even if balanced.
  IF v_ar_line_count = 0 THEN
    RAISE EXCEPTION 'Invoice JE must contain an Accounts Receivable debit line';
  END IF;
  IF v_revenue_line_count = 0 THEN
    RAISE EXCEPTION 'Invoice JE must contain at least one income (revenue) credit line. Check your account mappings — revenue accounts must have account_type = income.';
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
$function$;

REVOKE ALL ON FUNCTION public.confirm_invoice_atomic(uuid, uuid, jsonb, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.confirm_invoice_atomic(uuid, uuid, jsonb, jsonb) TO authenticated;

-- =============================================================================
-- Fix 3 — Backfill detail_type for accounts where NULL on income / expense /
-- AR / AP rows. Uses deterministic name + code heuristics. Idempotent.
-- =============================================================================

-- Accounts Receivable: code starts with 12 (per chart) or name matches AR
UPDATE public.accounts
SET detail_type = 'accounts_receivable'
WHERE detail_type IS NULL
  AND account_type = 'asset'
  AND (lower(name) LIKE '%accounts receivable%' OR lower(name) LIKE '%trade receivable%' OR code LIKE '12%');

-- Accounts Payable: code starts with 20 / 21 or name matches AP
UPDATE public.accounts
SET detail_type = 'accounts_payable'
WHERE detail_type IS NULL
  AND account_type = 'liability'
  AND (lower(name) LIKE '%accounts payable%' OR lower(name) LIKE '%trade payable%' OR code LIKE '20%' OR code LIKE '21%');

-- Sales tax payable
UPDATE public.accounts
SET detail_type = 'sales_tax_payable'
WHERE detail_type IS NULL
  AND account_type = 'liability'
  AND (lower(name) LIKE '%sales tax%' OR lower(name) LIKE '%vat payable%' OR lower(name) LIKE '%output tax%');

-- Income accounts: classify by name first, then default to sales_income
UPDATE public.accounts
SET detail_type = CASE
  WHEN lower(name) LIKE '%service%' THEN 'service_income'
  WHEN lower(name) LIKE '%interest%' THEN 'interest_income'
  WHEN lower(name) LIKE '%rental%' OR lower(name) LIKE '%rent income%' THEN 'rental_income'
  WHEN lower(name) LIKE '%dividend%' THEN 'dividend_income'
  WHEN lower(name) LIKE '%foreign exchange%' OR lower(name) LIKE '%fx gain%' THEN 'other_income'
  WHEN lower(name) LIKE '%other income%' THEN 'other_income'
  ELSE 'sales_income'
END
WHERE detail_type IS NULL
  AND account_type = 'income';

-- Expense accounts: classify by common name patterns; default to other_business_expenses
UPDATE public.accounts
SET detail_type = CASE
  WHEN lower(name) LIKE '%cost of goods%' OR lower(name) LIKE '%cogs%' THEN 'cost_of_goods_sold'
  WHEN lower(name) LIKE '%payroll%wage%' OR lower(name) LIKE '%salaries%' OR lower(name) LIKE '%wages%' THEN 'payroll_wage_expense'
  WHEN lower(name) LIKE '%payroll tax%' THEN 'payroll_tax_expense'
  WHEN lower(name) LIKE '%payroll%' THEN 'payroll_expense'
  WHEN lower(name) LIKE '%rent%' THEN 'rent_expense'
  WHEN lower(name) LIKE '%utilit%' THEN 'utilities'
  WHEN lower(name) LIKE '%bank charge%' OR lower(name) LIKE '%bank fee%' THEN 'bank_charges'
  WHEN lower(name) LIKE '%depreciation%' THEN 'depreciation'
  WHEN lower(name) LIKE '%insurance%' THEN 'insurance_expense'
  WHEN lower(name) LIKE '%advertis%' OR lower(name) LIKE '%marketing%' THEN 'advertising'
  WHEN lower(name) LIKE '%office%' THEN 'office_expenses'
  WHEN lower(name) LIKE '%travel%' THEN 'travel'
  WHEN lower(name) LIKE '%telephone%' OR lower(name) LIKE '%internet%' THEN 'telephone_internet'
  WHEN lower(name) LIKE '%legal%' OR lower(name) LIKE '%professional%' THEN 'legal_professional_fees'
  WHEN lower(name) LIKE '%repair%' OR lower(name) LIKE '%maintenance%' THEN 'repair_maintenance'
  WHEN lower(name) LIKE '%interest paid%' OR lower(name) LIKE '%interest expense%' THEN 'interest_paid'
  WHEN lower(name) LIKE '%tax%' THEN 'taxes_paid'
  ELSE 'other_business_expenses'
END
WHERE detail_type IS NULL
  AND account_type = 'expense';