-- ─────────────────────────────────────────────────────────────
-- Phase 3 — Employee payable & reimbursement settlement
-- Reimbursement is server-owned: the browser may never stamp
-- reimbursement state, only invoke the commands below.
-- ─────────────────────────────────────────────────────────────

REVOKE UPDATE (reimburse_via_payroll, reimbursed_payslip_id, reimbursed_run_id, reimbursed_at)
  ON public.expenses FROM authenticated;

-- One reimbursement settlement per expense (payroll OR direct, never both).
CREATE UNIQUE INDEX IF NOT EXISTS ux_expenses_single_reimbursement
  ON public.expenses (id)
  WHERE reimbursed_at IS NOT NULL;

-- Resolve the payable account the expense actually credited, so settlement
-- debits the same account instead of re-deriving a possibly-changed mapping.
CREATE OR REPLACE FUNCTION public._expense_payable_account(p_expense_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT jel.account_id
    FROM public.expenses e
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id = e.journal_entry_id
   WHERE e.id = p_expense_id
     AND COALESCE(jel.credit, 0) > 0
   ORDER BY COALESCE(jel.credit, 0) DESC
   LIMIT 1;
$$;

-- Shared eligibility gate for both reimbursement routes.
CREATE OR REPLACE FUNCTION public._expense_reimbursement_guard(p_expense_id uuid)
RETURNS public.expenses
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE r public.expenses; v_bill uuid;
BEGIN
  SELECT * INTO r FROM public.expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense % not found', p_expense_id USING ERRCODE = '22023';
  END IF;

  PERFORM public._assert_org_member(r.organization_id);

  IF r.status::text NOT IN ('approved', 'paid') THEN
    RAISE EXCEPTION 'Only approved expenses can be reimbursed (expense is %)', r.status
      USING ERRCODE = '22023';
  END IF;

  IF COALESCE(r.paid_by, 'company') <> 'employee'
     AND COALESCE(r.payment_method, '') <> 'employee_reimbursement' THEN
    RAISE EXCEPTION 'Only employee-paid expenses create a reimbursement obligation'
      USING ERRCODE = '22023';
  END IF;

  IF r.reimbursed_at IS NOT NULL OR r.reimbursed_payslip_id IS NOT NULL THEN
    RAISE EXCEPTION 'Expense has already been reimbursed' USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_bill FROM public.bills
   WHERE source_expense_id = p_expense_id AND status <> 'void' LIMIT 1;
  IF v_bill IS NOT NULL THEN
    RAISE EXCEPTION 'A vendor bill owns this liability; settle the bill instead'
      USING ERRCODE = '22023';
  END IF;

  RETURN r;
END;
$$;

-- ── Route A: payroll ────────────────────────────────────────
-- Sets the flag `compute-payroll` (Turn C) reads to add a
-- non-taxable reimbursement earning and stamp reimbursed_*.
CREATE OR REPLACE FUNCTION public.expense_queue_payroll_reimbursement(
  p_expense_id uuid,
  p_employee_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE r public.expenses; v_emp uuid;
BEGIN
  r := public._expense_reimbursement_guard(p_expense_id);

  v_emp := COALESCE(p_employee_id, r.employee_id);
  IF v_emp IS NULL THEN
    RAISE EXCEPTION 'An employee is required to reimburse through payroll'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.employees
     WHERE id = v_emp AND organization_id = r.organization_id
  ) THEN
    RAISE EXCEPTION 'Employee does not belong to this organization'
      USING ERRCODE = '22023';
  END IF;

  IF r.reimburse_via_payroll THEN
    RETURN jsonb_build_object('success', true, 'queued', true,
                              'employee_id', v_emp, 'idempotent_replay', true);
  END IF;

  UPDATE public.expenses
     SET reimburse_via_payroll = true,
         employee_id = v_emp,
         updated_at = now()
   WHERE id = p_expense_id;

  INSERT INTO public.audit_logs
    (organization_id, business_id, user_id, action, entity_type, entity_id, new_values)
  VALUES (r.organization_id, r.business_id, auth.uid(),
          'expense.reimbursement.queue_payroll', 'expense', r.id,
          jsonb_build_object('employee_id', v_emp, 'amount', r.amount));

  RETURN jsonb_build_object('success', true, 'queued', true, 'employee_id', v_emp);
END;
$$;

CREATE OR REPLACE FUNCTION public.expense_unqueue_payroll_reimbursement(p_expense_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE r public.expenses;
BEGIN
  SELECT * INTO r FROM public.expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense % not found', p_expense_id USING ERRCODE = '22023';
  END IF;
  PERFORM public._assert_org_member(r.organization_id);

  IF r.reimbursed_payslip_id IS NOT NULL OR r.reimbursed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Expense was already reimbursed through payroll and cannot be unqueued'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.expenses
     SET reimburse_via_payroll = false, updated_at = now()
   WHERE id = p_expense_id;

  INSERT INTO public.audit_logs
    (organization_id, business_id, user_id, action, entity_type, entity_id, new_values)
  VALUES (r.organization_id, r.business_id, auth.uid(),
          'expense.reimbursement.unqueue_payroll', 'expense', r.id,
          jsonb_build_object('amount', r.amount));

  RETURN jsonb_build_object('success', true, 'queued', false);
END;
$$;

-- ── Route B: direct bank/cash settlement ────────────────────
-- Posts through the single journal engine with
-- source_subtype='reimbursement' so the canonical unique index
-- on (org, source_type, source_id, source_subtype) makes the
-- settlement idempotent on retry.
CREATE OR REPLACE FUNCTION public.expense_reimburse_direct(
  p_expense_id uuid,
  p_bank_account_id uuid,
  p_payment_date date DEFAULT NULL,
  p_reference text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r public.expenses;
  v_payable uuid;
  v_existing uuid;
  v_je uuid;
  v_date date;
  v_lines jsonb;
  v_doc text;
BEGIN
  r := public._expense_reimbursement_guard(p_expense_id);

  IF r.reimburse_via_payroll THEN
    RAISE EXCEPTION 'Expense is queued for payroll reimbursement; remove it from the payroll queue first'
      USING ERRCODE = '22023';
  END IF;

  IF r.journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'Expense has not been posted to the ledger yet'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.accounts
     WHERE id = p_bank_account_id AND organization_id = r.organization_id
  ) THEN
    RAISE EXCEPTION 'Payment account does not belong to this organization'
      USING ERRCODE = '22023';
  END IF;

  v_payable := public._expense_payable_account(p_expense_id);
  IF v_payable IS NULL THEN
    RAISE EXCEPTION 'Could not resolve the employee payable account from the expense journal entry'
      USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_existing
    FROM public.journal_entries
   WHERE organization_id = r.organization_id
     AND source_type = 'expense'
     AND source_id = p_expense_id
     AND COALESCE(source_subtype, '') = 'reimbursement'
     AND status <> 'voided'
   LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('journal_entry_id', v_existing, 'idempotent_replay', true);
  END IF;

  v_date := COALESCE(p_payment_date, CURRENT_DATE);
  v_doc  := COALESCE(NULLIF(r.expense_number, ''), 'EXP');

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', v_payable, 'debit', r.amount, 'credit', 0,
      'description', 'Employee reimbursement settled - ' || COALESCE(r.description, ''),
      'business_id', r.business_id, 'branch_id', r.branch_id),
    jsonb_build_object('account_id', p_bank_account_id, 'debit', 0, 'credit', r.amount,
      'description', 'Employee reimbursement payment - ' || COALESCE(r.description, ''),
      'business_id', r.business_id, 'branch_id', r.branch_id)
  );

  v_je := public.post_journal_entry_atomic(
    r.organization_id, r.business_id,
    public.generate_next_je_number(r.organization_id, r.business_id),
    v_date,
    COALESCE(NULLIF(p_reference, ''), v_doc),
    'Reimbursement of expense ' || v_doc,
    'expense', p_expense_id, auth.uid(), false, false,
    v_lines, r.currency, COALESCE(r.exchange_rate, 1), 'reimbursement', r.branch_id
  );

  UPDATE public.expenses
     SET reimbursed_at = now(),
         status = 'paid',
         updated_at = now()
   WHERE id = p_expense_id;

  INSERT INTO public.audit_logs
    (organization_id, business_id, user_id, action, entity_type, entity_id, new_values)
  VALUES (r.organization_id, r.business_id, auth.uid(),
          'expense.reimbursement.pay_direct', 'expense', r.id,
          jsonb_build_object('journal_entry_id', v_je, 'bank_account_id', p_bank_account_id,
                             'amount', r.amount, 'payment_date', v_date));

  RETURN jsonb_build_object('success', true, 'journal_entry_id', v_je,
                            'status', 'paid', 'payment_date', v_date);
END;
$$;

GRANT EXECUTE ON FUNCTION public.expense_queue_payroll_reimbursement(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.expense_unqueue_payroll_reimbursement(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.expense_reimburse_direct(uuid, uuid, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public._expense_payable_account(uuid) TO authenticated;