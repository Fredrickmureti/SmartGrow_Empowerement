-- 1. Human-readable expense number (ADR-0020: narrations must not embed UUIDs)
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS expense_number text;

CREATE OR REPLACE FUNCTION public.get_next_expense_number(
  _org_id uuid,
  _business_id uuid DEFAULT NULL::uuid,
  _branch_id uuid DEFAULT NULL::uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  next_num integer;
  prefix text := 'EXP-';
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('expenses_' || _org_id::text));

  SELECT COALESCE(MAX(
    CASE WHEN expense_number ~ '\d+$'
      THEN CAST(substring(expense_number FROM '\d+$') AS integer)
      ELSE 0
    END
  ), 0) + 1 INTO next_num
  FROM public.expenses
  WHERE organization_id = _org_id;

  RETURN prefix || LPAD(next_num::text, 5, '0');
END;
$function$;

CREATE OR REPLACE FUNCTION public._expenses_assign_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.expense_number IS NULL OR NEW.expense_number = '' THEN
    NEW.expense_number := public.get_next_expense_number(
      NEW.organization_id, NEW.business_id, NEW.branch_id);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_expenses_assign_number ON public.expenses;
CREATE TRIGGER trg_expenses_assign_number
  BEFORE INSERT ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public._expenses_assign_number();

-- Backfill existing rows, oldest first, per organization.
WITH numbered AS (
  SELECT id,
         organization_id,
         ROW_NUMBER() OVER (
           PARTITION BY organization_id
           ORDER BY expense_date NULLS LAST, created_at NULLS LAST, id
         ) AS rn
    FROM public.expenses
   WHERE expense_number IS NULL
)
UPDATE public.expenses e
   SET expense_number = 'EXP-' || LPAD(n.rn::text, 5, '0')
  FROM numbered n
 WHERE e.id = n.id;

CREATE UNIQUE INDEX IF NOT EXISTS expenses_org_number_uidx
  ON public.expenses (organization_id, expense_number)
  WHERE expense_number IS NOT NULL;

-- 2. Narration uses the expense number, never the UUID.
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
BEGIN
  SELECT e.id, e.organization_id, e.business_id, e.branch_id, e.expense_date,
         COALESCE(e.amount, 0) AS amount, COALESCE(e.tax_amount, 0) AS tax_amount,
         e.description, e.reference, e.payment_method, e.account_id, e.paid_by,
         e.payment_account_id, e.category_id, e.journal_entry_id, e.status::text AS status,
         e.currency, COALESCE(e.exchange_rate, 1) AS exchange_rate, e.expense_number
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

  v_has_tax := v_exp.tax_amount > 0 AND v_input_tax_acct IS NOT NULL;
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

  RETURN jsonb_build_object(
    'journal_entry_id', v_je_id,
    'expense_account_id', v_expense_acct,
    'payment_account_id', v_payment_acct,
    'input_tax_account_id', CASE WHEN v_has_tax THEN v_input_tax_acct ELSE NULL END
  );
END;
$function$;