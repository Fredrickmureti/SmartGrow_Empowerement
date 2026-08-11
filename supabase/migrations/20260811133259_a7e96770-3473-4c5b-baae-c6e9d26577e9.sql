-- ============================================================
-- Expense Phase 5 — currency/FX, tax codes, analytic dimensions
-- ============================================================

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS tax_rate_id uuid REFERENCES public.tax_rates(id),
  ADD COLUMN IF NOT EXISTS tax_treatment text NOT NULL DEFAULT 'recoverable',
  ADD COLUMN IF NOT EXISTS analytic_account_id uuid REFERENCES public.analytic_accounts(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'expenses_tax_treatment_check'
  ) THEN
    ALTER TABLE public.expenses
      ADD CONSTRAINT expenses_tax_treatment_check
      CHECK (tax_treatment IN ('recoverable', 'non_recoverable'));
  END IF;
END$$;

-- ------------------------------------------------------------
-- Derived money columns: currency validation, FX, tax
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._expenses_derive_base_amount()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_base text;
  v_rate numeric;
  v_tax_rate numeric;
  v_active_count int;
BEGIN
  SELECT b.base_currency INTO v_base
    FROM public.businesses b WHERE b.id = NEW.business_id;
  v_base := COALESCE(NULLIF(v_base, ''), 'USD');

  NEW.currency := UPPER(COALESCE(NULLIF(NEW.currency, ''), v_base));

  IF NOT EXISTS (SELECT 1 FROM public.currencies c WHERE c.code = NEW.currency) THEN
    RAISE EXCEPTION 'Unknown currency %', NEW.currency USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_active_count
    FROM public.business_active_currencies bac
   WHERE bac.business_id = NEW.business_id AND bac.is_enabled;

  IF v_active_count > 0 AND NEW.currency <> v_base
     AND NOT EXISTS (
       SELECT 1 FROM public.business_active_currencies bac
        WHERE bac.business_id = NEW.business_id
          AND bac.is_enabled
          AND bac.currency_code = NEW.currency) THEN
    RAISE EXCEPTION 'Currency % is not enabled for this business', NEW.currency
      USING ERRCODE = '22023';
  END IF;

  -- FX rate is resolved server-side; never taken from the client.
  IF NEW.currency = v_base THEN
    v_rate := 1;
  ELSE
    SELECT er.rate INTO v_rate
      FROM public.exchange_rates er
     WHERE er.organization_id = NEW.organization_id
       AND er.from_currency = NEW.currency
       AND er.to_currency = v_base
       AND (er.business_id = NEW.business_id OR er.business_id IS NULL)
       AND er.effective_date <= COALESCE(NEW.expense_date, CURRENT_DATE)
     ORDER BY er.effective_date DESC, (er.business_id IS NULL)
     LIMIT 1;

    IF v_rate IS NULL OR v_rate <= 0 THEN
      RAISE EXCEPTION 'No exchange rate from % to % on or before % — add one in Currency settings',
        NEW.currency, v_base, COALESCE(NEW.expense_date, CURRENT_DATE)
        USING ERRCODE = '22023';
    END IF;
  END IF;

  NEW.exchange_rate := v_rate;
  NEW.base_amount := ROUND(COALESCE(NEW.amount, 0) * v_rate, 2);

  -- Tax is derived from the selected tax code; `amount` is gross.
  IF NEW.tax_rate_id IS NULL THEN
    NEW.tax_amount := 0;
  ELSE
    SELECT tr.rate INTO v_tax_rate
      FROM public.tax_rates tr
     WHERE tr.id = NEW.tax_rate_id
       AND tr.organization_id = NEW.organization_id;

    IF v_tax_rate IS NULL THEN
      RAISE EXCEPTION 'Tax rate not found for this organization' USING ERRCODE = '22023';
    END IF;

    NEW.tax_amount := ROUND(COALESCE(NEW.amount, 0) * v_tax_rate / (100 + v_tax_rate), 2);
  END IF;

  NEW.tax_treatment := COALESCE(NEW.tax_treatment, 'recoverable');

  RETURN NEW;
END;
$function$;

-- Derived columns are server-owned.
REVOKE UPDATE (exchange_rate, tax_amount, base_amount) ON public.expenses FROM authenticated;
REVOKE INSERT (exchange_rate, tax_amount, base_amount) ON public.expenses FROM authenticated;
GRANT INSERT (tax_rate_id, tax_treatment, analytic_account_id),
      UPDATE (tax_rate_id, tax_treatment, analytic_account_id)
  ON public.expenses TO authenticated;

-- ------------------------------------------------------------
-- Posting: non-recoverable tax + analytic distribution
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_expense_gl(p_expense_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_exp record;
  v_expense_acct uuid;
  v_payment_acct uuid;
  v_input_tax_acct uuid;
  v_existing uuid;
  v_net numeric;
  v_has_tax boolean;
  v_lines jsonb;
  v_je_id uuid;
  v_bill_id uuid;
  v_doc_no text;
  v_analytic uuid;
BEGIN
  SELECT e.id, e.organization_id, e.business_id, e.branch_id, e.expense_date,
         COALESCE(e.amount, 0) AS amount, COALESCE(e.tax_amount, 0) AS tax_amount,
         e.description, e.reference, e.payment_method, e.account_id, e.paid_by,
         e.payment_account_id, e.category_id, e.journal_entry_id, e.status::text AS status,
         e.currency, COALESCE(e.exchange_rate, 1) AS exchange_rate, e.expense_number,
         COALESCE(e.tax_treatment, 'recoverable') AS tax_treatment,
         e.analytic_account_id, e.project_id
    INTO v_exp
    FROM public.expenses e
   WHERE e.id = p_expense_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense % not found', p_expense_id USING ERRCODE = '22023';
  END IF;

  PERFORM public._assert_org_member(v_exp.organization_id);

  IF v_exp.status NOT IN ('approved', 'paid') THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'not_approved');
  END IF;

  IF v_exp.amount <= 0 THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'zero_amount');
  END IF;

  SELECT id INTO v_existing
    FROM public.journal_entries
   WHERE organization_id = v_exp.organization_id
     AND source_type = 'expense'
     AND source_id = p_expense_id
     AND status <> 'void'
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    UPDATE public.expenses SET journal_entry_id = v_existing WHERE id = p_expense_id;
    RETURN jsonb_build_object('journal_entry_id', v_existing, 'idempotent_replay', true);
  END IF;

  SELECT id INTO v_bill_id FROM public.bills WHERE source_expense_id = p_expense_id LIMIT 1;
  IF v_bill_id IS NOT NULL THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'bill_owns_liability', 'bill_id', v_bill_id);
  END IF;

  v_expense_acct := v_exp.account_id;

  IF v_expense_acct IS NULL AND v_exp.category_id IS NOT NULL THEN
    SELECT account_id INTO v_expense_acct
      FROM public.expense_categories WHERE id = v_exp.category_id;
  END IF;

  IF v_expense_acct IS NULL THEN
    v_expense_acct := public.resolve_expense_default_account(
      v_exp.organization_id, v_exp.business_id, 'operating_expenses');
  END IF;

  v_payment_acct := v_exp.payment_account_id;

  IF v_payment_acct IS NULL AND v_exp.paid_by = 'employee' THEN
    v_payment_acct := COALESCE(
      public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'employee_reimbursements_payable'),
      public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'net_salary_payable'),
      public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'accounts_payable'));
  END IF;

  IF v_payment_acct IS NULL AND v_exp.paid_by = 'company_card' THEN
    v_payment_acct := COALESCE(
      public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'credit_card_clearing'),
      public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'bank'));
  END IF;

  IF v_payment_acct IS NULL THEN
    v_payment_acct := CASE COALESCE(v_exp.payment_method, 'cash')
      WHEN 'cash' THEN COALESCE(
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'cash'),
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'bank'))
      WHEN 'petty_cash' THEN
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'cash')
      WHEN 'bank' THEN COALESCE(
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'bank'),
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'cash'))
      WHEN 'credit_card' THEN COALESCE(
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'credit_card_clearing'),
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'bank'))
      WHEN 'mobile_money' THEN COALESCE(
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'mobile_money'),
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'bank'))
      WHEN 'payable' THEN
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'accounts_payable')
      WHEN 'employee_reimbursement' THEN COALESCE(
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'employee_reimbursements_payable'),
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'accounts_payable'))
      ELSE COALESCE(
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'cash'),
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'bank'))
    END;
  END IF;

  IF v_expense_acct IS NULL OR v_payment_acct IS NULL THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'missing_account_mappings');
  END IF;

  v_input_tax_acct := public.resolve_expense_default_account(
    v_exp.organization_id, v_exp.business_id, 'input_tax');

  -- Only recoverable tax is separated into the input-tax asset. Non-recoverable
  -- tax stays part of the cost and is charged to the expense account.
  v_has_tax := v_exp.tax_amount > 0
               AND v_input_tax_acct IS NOT NULL
               AND v_exp.tax_treatment = 'recoverable';
  v_net := CASE WHEN v_has_tax THEN v_exp.amount - v_exp.tax_amount ELSE v_exp.amount END;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', v_expense_acct, 'debit', v_net, 'credit', 0,
      'description', 'Expense - ' || COALESCE(v_exp.description, ''),
      'business_id', v_exp.business_id, 'branch_id', v_exp.branch_id)
  );

  IF v_has_tax THEN
    v_lines := v_lines || jsonb_build_object(
      'account_id', v_input_tax_acct, 'debit', v_exp.tax_amount, 'credit', 0,
      'description', 'Expense Input Tax - ' || COALESCE(v_exp.description, ''),
      'business_id', v_exp.business_id, 'branch_id', v_exp.branch_id);
  END IF;

  v_lines := v_lines || jsonb_build_object(
    'account_id', v_payment_acct, 'debit', 0, 'credit', v_exp.amount,
    'description', CASE WHEN v_exp.paid_by = 'employee'
                        THEN 'Employee reimbursement due - ' || COALESCE(v_exp.description, '')
                        ELSE 'Expense payment - ' || COALESCE(v_exp.description, '') END,
    'business_id', v_exp.business_id, 'branch_id', v_exp.branch_id);

  -- ADR-0020: reference and narration carry the expense's human number.
  v_doc_no := COALESCE(
    NULLIF(v_exp.expense_number, ''),
    public.get_next_expense_number(v_exp.organization_id, v_exp.business_id, v_exp.branch_id));

  IF v_exp.expense_number IS NULL OR v_exp.expense_number = '' THEN
    UPDATE public.expenses SET expense_number = v_doc_no WHERE id = p_expense_id;
  END IF;

  v_je_id := public.post_journal_entry_atomic(
    v_exp.organization_id, v_exp.business_id,
    public.generate_next_je_number(v_exp.organization_id, v_exp.business_id),
    v_exp.expense_date,
    v_doc_no,
    'Expense ' || v_doc_no || ' (' || COALESCE(NULLIF(v_exp.description, ''), 'approved') || ')',
    'expense', p_expense_id, auth.uid(), false, false,
    v_lines, v_exp.currency, v_exp.exchange_rate, NULL, v_exp.branch_id
  );

  UPDATE public.expenses SET journal_entry_id = v_je_id WHERE id = p_expense_id;

  -- Canonical analytic dimension. Explicit analytic account wins; otherwise a
  -- project's analytic account code is resolved.
  v_analytic := v_exp.analytic_account_id;
  IF v_analytic IS NULL AND v_exp.project_id IS NOT NULL THEN
    SELECT aa.id INTO v_analytic
      FROM public.projects p
      JOIN public.analytic_accounts aa
        ON aa.organization_id = p.organization_id
       AND aa.code = p.analytic_account_code
     WHERE p.id = v_exp.project_id
     LIMIT 1;
  END IF;

  IF v_analytic IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.analytic_distributions ad
        WHERE ad.source_type = 'expense' AND ad.source_id = p_expense_id) THEN
    INSERT INTO public.analytic_distributions
      (organization_id, business_id, analytic_account_id, source_type, source_id,
       amount, percentage, date, description)
    VALUES
      (v_exp.organization_id, v_exp.business_id, v_analytic, 'expense', p_expense_id,
       v_net, 100, v_exp.expense_date,
       'Expense ' || v_doc_no || COALESCE(' - ' || NULLIF(v_exp.description, ''), ''));
  END IF;

  RETURN jsonb_build_object(
    'journal_entry_id', v_je_id,
    'expense_account_id', v_expense_acct,
    'payment_account_id', v_payment_acct,
    'analytic_account_id', v_analytic,
    'tax_treatment', v_exp.tax_treatment,
    'input_tax_account_id', CASE WHEN v_has_tax THEN v_input_tax_acct ELSE NULL END
  );
END;
$function$;

-- ------------------------------------------------------------
-- Void removes the analytic distribution as well
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expense_void(p_expense_id uuid, p_reason text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE r public.expenses; v_bill uuid;
BEGIN
  r := public._expense_guard(p_expense_id, ARRAY['approved','paid']);

  IF r.reimbursed_payslip_id IS NOT NULL OR r.reimbursed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Expense has been reimbursed and cannot be voided'
      USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_bill FROM public.bills
   WHERE source_expense_id = p_expense_id AND status <> 'void' LIMIT 1;
  IF v_bill IS NOT NULL THEN
    RAISE EXCEPTION 'A vendor bill was created from this expense; void the bill instead'
      USING ERRCODE = '22023';
  END IF;

  IF r.journal_entry_id IS NOT NULL THEN
    PERFORM public.void_journal_entry_atomic(
      r.journal_entry_id,
      COALESCE(p_reason, 'Expense voided'),
      auth.uid(), NULL, NULL);
  END IF;

  DELETE FROM public.analytic_distributions
   WHERE source_type = 'expense' AND source_id = p_expense_id;

  UPDATE public.expenses
     SET status = 'voided', voided_at = now(), voided_by = auth.uid(),
         void_reason = COALESCE(p_reason, 'Expense voided'),
         updated_at = now()
   WHERE id = p_expense_id;

  INSERT INTO public.audit_logs
    (organization_id, business_id, user_id, action, entity_type, entity_id, new_values)
  VALUES (r.organization_id, r.business_id, auth.uid(), 'expense.void', 'expense', r.id,
          jsonb_build_object('reason', p_reason, 'journal_entry_id', r.journal_entry_id));

  RETURN jsonb_build_object('success', true, 'status', 'voided');
END;
$function$;