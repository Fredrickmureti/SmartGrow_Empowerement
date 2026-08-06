CREATE OR REPLACE FUNCTION public.disburse_employee_advance(
  p_advance_id uuid,
  p_payment_account_id uuid DEFAULT NULL,
  p_disbursement_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_adv        public.employee_advances%ROWTYPE;
  v_recv_acct  uuid;
  v_pay_acct   uuid;
  v_existing   uuid;
  v_lines      jsonb;
  v_je_id      uuid;
  v_date       date;
  v_emp_name   text;
BEGIN
  SELECT * INTO v_adv
    FROM public.employee_advances
   WHERE id = p_advance_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'disburse_employee_advance: advance % not found', p_advance_id
      USING ERRCODE = '22023';
  END IF;

  PERFORM public._assert_org_member(v_adv.organization_id);

  IF v_adv.status = 'cancelled'::employee_advance_status THEN
    RAISE EXCEPTION 'disburse_employee_advance: advance % is cancelled', p_advance_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_adv.status = 'requested'::employee_advance_status THEN
    RAISE EXCEPTION 'disburse_employee_advance: advance % must be approved before disbursement', p_advance_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF COALESCE(v_adv.amount, 0) <= 0 THEN
    RAISE EXCEPTION 'disburse_employee_advance: advance % has no amount', p_advance_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT id INTO v_existing
    FROM public.journal_entries
   WHERE organization_id = v_adv.organization_id
     AND source_type = 'employee_advance'
     AND source_id = p_advance_id
     AND status <> 'void'
   LIMIT 1;

  IF v_existing IS NOT NULL THEN
    UPDATE public.employee_advances
       SET journal_entry_id = v_existing,
           status = CASE WHEN status = 'approved'::employee_advance_status
                         THEN 'disbursed'::employee_advance_status ELSE status END,
           disbursed_at = COALESCE(disbursed_at, now()),
           disbursed_by = COALESCE(disbursed_by, auth.uid())
     WHERE id = p_advance_id;
    RETURN jsonb_build_object('journal_entry_id', v_existing, 'idempotent_replay', true);
  END IF;

  v_recv_acct := COALESCE(
    public.resolve_expense_default_account(v_adv.organization_id, v_adv.business_id, 'employee_advance_receivable'),
    public.resolve_expense_default_account(v_adv.organization_id, v_adv.business_id, 'loan_receivable'));

  v_pay_acct := p_payment_account_id;
  IF v_pay_acct IS NULL THEN
    v_pay_acct := COALESCE(
      public.resolve_expense_default_account(v_adv.organization_id, v_adv.business_id, 'bank'),
      public.resolve_expense_default_account(v_adv.organization_id, v_adv.business_id, 'cash'));
  END IF;

  IF v_recv_acct IS NULL OR v_pay_acct IS NULL THEN
    RAISE EXCEPTION 'disburse_employee_advance: missing account mapping (advance receivable / bank). Configure them under Finance / Default Accounts.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(e.first_name || ' ' || e.last_name, e.employee_number)
    INTO v_emp_name
    FROM public.employees e
   WHERE e.id = v_adv.employee_id;

  v_date := COALESCE(p_disbursement_date, v_adv.advance_date, CURRENT_DATE);

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', v_recv_acct, 'debit', v_adv.amount, 'credit', 0,
      'description', 'Employee advance - ' || COALESCE(v_emp_name, v_adv.employee_id::text),
      'business_id', v_adv.business_id),
    jsonb_build_object('account_id', v_pay_acct, 'debit', 0, 'credit', v_adv.amount,
      'description', 'Employee advance disbursement - ' || COALESCE(v_emp_name, v_adv.employee_id::text),
      'business_id', v_adv.business_id)
  );

  v_je_id := public.post_journal_entry_atomic(
    v_adv.organization_id,
    v_adv.business_id,
    public.generate_next_je_number(v_adv.organization_id, v_adv.business_id),
    v_date,
    'ADV-' || left(p_advance_id::text, 8),
    'Employee advance disbursement: ' || COALESCE(v_emp_name, ''),
    'employee_advance', p_advance_id, auth.uid(), false, false,
    v_lines, NULL, NULL, NULL, NULL
  );

  UPDATE public.employee_advances
     SET status = 'disbursed'::employee_advance_status,
         disbursed_at = COALESCE(disbursed_at, now()),
         disbursed_by = auth.uid(),
         journal_entry_id = v_je_id,
         updated_at = now()
   WHERE id = p_advance_id;

  RETURN jsonb_build_object(
    'journal_entry_id', v_je_id,
    'receivable_account_id', v_recv_acct,
    'payment_account_id', v_pay_acct);
END;
$$;

REVOKE ALL ON FUNCTION public.disburse_employee_advance(uuid, uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.disburse_employee_advance(uuid, uuid, date) TO authenticated, service_role;