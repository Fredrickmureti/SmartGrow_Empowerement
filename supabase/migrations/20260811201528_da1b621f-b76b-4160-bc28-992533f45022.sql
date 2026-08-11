CREATE OR REPLACE FUNCTION public._assert_expense_account_postable(
  p_account_id uuid, p_label text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE a public.accounts;
BEGIN
  IF p_account_id IS NULL THEN RETURN; END IF;
  SELECT * INTO a FROM public.accounts WHERE id = p_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The % account for this expense no longer exists. Pick another account.', p_label
      USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(a.is_header, false) THEN
    RAISE EXCEPTION '% "%/%" is a grouping (header) account and cannot receive postings. Choose a specific sub-account instead.',
      initcap(p_label), a.code, a.name
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT COALESCE(a.is_active, true) THEN
    RAISE EXCEPTION '% "%/%" is inactive and cannot receive postings.', initcap(p_label), a.code, a.name
      USING ERRCODE = 'P0001';
  END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public._assert_expense_account_postable(uuid, text) TO authenticated, service_role;

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

  -- Fail fast with a legible, user-safe message instead of letting the
  -- journal-line header guard raise deep inside post_journal_entry_atomic.
  PERFORM public._assert_expense_account_postable(v_expense_acct, 'expense account');
  PERFORM public._assert_expense_account_postable(v_payment_acct, 'payment account');

  v_input_tax_acct := public.resolve_expense_default_account(
    v_exp.organization_id, v_exp.business_id, 'input_tax');

  -- Only recoverable tax is separated into the input-tax asset. Non-recoverable
  -- tax stays part of the cost and is charged to the expense account.
  v_has_tax := v_exp.tax_amount > 0
               AND v_input_tax_acct IS NOT NULL
               AND v_exp.tax_treatment = 'recoverable';

  IF v_has_tax THEN
    PERFORM public._assert_expense_account_postable(v_input_tax_acct, 'input tax account');
  END IF;

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