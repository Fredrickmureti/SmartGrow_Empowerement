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
         e.currency, e.exchange_rate AS exchange_rate, e.expense_number,
         COALESCE(e.tax_treatment, 'recoverable') AS tax_treatment,
         e.analytic_account_id
    INTO v_exp
    FROM public.expenses e
   WHERE e.id = p_expense_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense % not found', p_expense_id USING ERRCODE = '22023';
  END IF;

  IF v_exp.exchange_rate IS NULL OR v_exp.exchange_rate <= 0 THEN
    RAISE EXCEPTION 'Expense % has no exchange rate on file for % — it cannot be posted at parity',
      p_expense_id, v_exp.currency USING ERRCODE = '23514';
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

  IF to_regclass('public.bills') IS NOT NULL THEN
    EXECUTE 'SELECT id FROM public.bills WHERE source_expense_id = $1 LIMIT 1'
      INTO v_bill_id USING p_expense_id;
    IF v_bill_id IS NOT NULL THEN
      RETURN jsonb_build_object('skipped', true, 'reason', 'bill_owns_liability', 'bill_id', v_bill_id);
    END IF;
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
      ELSE COALESCE(
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'bank'),
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'cash'))
    END;
  END IF;

  IF v_expense_acct IS NULL OR v_payment_acct IS NULL THEN
    RAISE EXCEPTION 'Expense % cannot be posted: expense or payment account is not configured', p_expense_id
      USING ERRCODE = '23514';
  END IF;

  PERFORM public._assert_expense_account_postable(v_expense_acct, 'expense account');
  PERFORM public._assert_expense_account_postable(v_payment_acct, 'payment account');

  v_has_tax := v_exp.tax_amount > 0 AND v_exp.tax_treatment = 'recoverable';
  v_net := CASE WHEN v_has_tax THEN v_exp.amount - v_exp.tax_amount ELSE v_exp.amount END;

  IF v_has_tax THEN
    v_input_tax_acct := public.resolve_expense_default_account(
      v_exp.organization_id, v_exp.business_id, 'input_tax');
    IF v_input_tax_acct IS NULL THEN
      v_has_tax := false;
      v_net := v_exp.amount;
    END IF;
  END IF;

  v_doc_no := COALESCE(v_exp.expense_number, v_exp.reference, p_expense_id::text);

  v_analytic := v_exp.analytic_account_id;

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', v_expense_acct,
      'description', 'Expense ' || v_doc_no || COALESCE(' - ' || NULLIF(v_exp.description, ''), ''),
      'debit', v_net,
      'credit', 0,
      'analytic_account_id', v_analytic
    )
  );

  IF v_has_tax THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_input_tax_acct,
        'description', 'Input tax on expense ' || v_doc_no,
        'debit', v_exp.tax_amount,
        'credit', 0
      )
    );
  END IF;

  v_lines := v_lines || jsonb_build_array(
    jsonb_build_object(
      'account_id', v_payment_acct,
      'description', 'Payment for expense ' || v_doc_no,
      'debit', 0,
      'credit', v_exp.amount
    )
  );

  v_je_id := public.post_journal_entry_atomic(
    _org_id        => v_exp.organization_id,
    _business_id   => v_exp.business_id,
    _entry_number  => NULL,
    _entry_date    => v_exp.expense_date,
    _reference     => COALESCE(NULLIF(btrim(v_exp.reference), ''), v_doc_no),
    _description   => 'Expense ' || v_doc_no,
    _source_type   => 'expense',
    _source_id     => p_expense_id,
    _created_by    => auth.uid(),
    _is_closing    => false,
    _is_adjusting  => false,
    _lines         => v_lines,
    _currency      => v_exp.currency,
    _exchange_rate => v_exp.exchange_rate,
    _source_subtype => NULL,
    _branch_id     => v_exp.branch_id,
    _is_opening_entry => false,
    _amounts_in_document_currency => false);

  UPDATE public.expenses SET journal_entry_id = v_je_id WHERE id = p_expense_id;

  RETURN jsonb_build_object(
    'journal_entry_id', v_je_id,
    'expense_account_id', v_expense_acct,
    'payment_account_id', v_payment_acct,
    'analytic_account_id', v_analytic,
    'tax_treatment', v_exp.tax_treatment,
    'net', v_net,
    'tax', CASE WHEN v_has_tax THEN v_exp.tax_amount ELSE 0 END
  );
END;
$function$;