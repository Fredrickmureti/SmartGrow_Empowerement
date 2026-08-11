-- ---------------------------------------------------------------------------
-- 1. Base-currency amount is derived, never client-supplied.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._expenses_derive_base_amount()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  NEW.exchange_rate := COALESCE(NULLIF(NEW.exchange_rate, 0), 1);
  NEW.base_amount := ROUND(COALESCE(NEW.amount, 0) * NEW.exchange_rate, 2);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_expenses_base_amount ON public.expenses;
CREATE TRIGGER trg_expenses_base_amount
  BEFORE INSERT OR UPDATE OF amount, exchange_rate ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public._expenses_derive_base_amount();

-- ---------------------------------------------------------------------------
-- 2. SoD guard: derive the actor from the session, never from a client column.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_expense_self_approval()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE v_actor uuid := COALESCE(auth.uid(), NEW.approved_by);
BEGIN
  IF public._sod_is_approved_status(NEW.status::text)
     AND NOT public._sod_is_approved_status(COALESCE(OLD.status::text, '')) THEN
    IF v_actor IS NOT NULL THEN
      PERFORM public.governance_assert_not_self(
        v_actor, NEW.created_by, 'expense.approve',
        NEW.organization_id, 'expense', NEW.id);
      IF NEW.employee_id IS NOT NULL THEN
        PERFORM public.governance_assert_not_subject(
          v_actor, NEW.employee_id, 'expense.approve_self_benefit',
          NEW.organization_id, 'expense', NEW.id);
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Posting: bill owns the liability; employee-paid credits employee payable.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_expense_gl(p_expense_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
BEGIN
  SELECT e.id, e.organization_id, e.business_id, e.branch_id, e.expense_date,
         COALESCE(e.amount, 0) AS amount, COALESCE(e.tax_amount, 0) AS tax_amount,
         e.description, e.reference, e.payment_method, e.account_id, e.paid_by,
         e.payment_account_id, e.category_id, e.journal_entry_id, e.status::text AS status,
         e.currency, COALESCE(e.exchange_rate, 1) AS exchange_rate
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

  -- Idempotent replay on the canonical posting key.
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

  -- ADR: one economic event, one liability. If a vendor bill was spawned from
  -- this expense, the BILL owns both the expense debit and the AP credit.
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

  -- Who fronted the money decides the credit side.
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

  v_je_id := public.post_journal_entry_atomic(
    v_exp.organization_id, v_exp.business_id,
    public.generate_next_je_number(v_exp.organization_id, v_exp.business_id),
    v_exp.expense_date,
    COALESCE(v_exp.reference, 'EXP-' || left(p_expense_id::text, 8)),
    'Expense ' || COALESCE(v_exp.reference, 'EXP-' || left(p_expense_id::text, 8))
      || ' (' || COALESCE(v_exp.description, 'approved') || ')',
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
$$;

-- ---------------------------------------------------------------------------
-- 4. Domain commands. These are the ONLY writers of expense state.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._expense_guard(p_expense_id uuid, p_allowed text[])
RETURNS public.expenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE r public.expenses;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO r FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public._assert_org_member(r.organization_id);
  IF p_allowed IS NOT NULL AND NOT (r.status::text = ANY (p_allowed)) THEN
    RAISE EXCEPTION 'Expense is %, this action is not allowed', r.status
      USING ERRCODE = '22023';
  END IF;
  RETURN r;
END;
$$;

CREATE OR REPLACE FUNCTION public._expense_apply_approval(p_expense_id uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE r public.expenses; v_post jsonb;
BEGIN
  UPDATE public.expenses
     SET status = 'approved', approved_by = p_actor, approved_at = now(), updated_at = now()
   WHERE id = p_expense_id
   RETURNING * INTO r;

  v_post := public.post_expense_gl(p_expense_id);

  INSERT INTO public.audit_logs
    (organization_id, business_id, user_id, action, entity_type, entity_id, new_values)
  VALUES (r.organization_id, r.business_id, p_actor, 'expense.approve', 'expense', r.id,
          jsonb_build_object('posting', v_post));

  RETURN jsonb_build_object('success', true, 'status', 'approved', 'posting', v_post);
END;
$$;

CREATE OR REPLACE FUNCTION public.expense_submit(p_expense_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r public.expenses;
  v_req public.approval_requests;
BEGIN
  r := public._expense_guard(p_expense_id, ARRAY['draft','pending','rejected']);

  UPDATE public.expenses
     SET status = 'submitted', submitted_by = auth.uid(), submitted_at = now(),
         rejected_reason = NULL, updated_at = now()
   WHERE id = p_expense_id;

  -- Canonical governance engine. NULL means policy does not gate this action.
  v_req := public.approval_route(
    'expense.approve', 'expense', p_expense_id,
    COALESCE(r.reference, 'EXP-' || left(p_expense_id::text, 8)),
    jsonb_build_object('amount', r.amount, 'total_amount', r.amount,
                       'currency', r.currency, 'employee_id', r.employee_id,
                       'paid_by', r.paid_by),
    jsonb_build_object('organization_id', r.organization_id),
    'expense.approve:' || p_expense_id::text,
    r.business_id);

  IF v_req.id IS NOT NULL THEN
    UPDATE public.expenses SET approval_request_id = v_req.id, updated_at = now()
     WHERE id = p_expense_id;
    RETURN jsonb_build_object('success', true, 'status', 'submitted',
                              'gated', true, 'approval_request_id', v_req.id);
  END IF;

  RETURN public._expense_apply_approval(p_expense_id, auth.uid())
         || jsonb_build_object('gated', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.expense_approve(p_expense_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE r public.expenses; v_live uuid;
BEGIN
  r := public._expense_guard(p_expense_id, ARRAY['draft','pending','submitted']);

  SELECT ar.id INTO v_live
    FROM public.approval_requests ar
   WHERE ar.id = r.approval_request_id
     AND ar.status NOT IN ('approved','rejected','cancelled');
  IF v_live IS NOT NULL THEN
    RAISE EXCEPTION 'This expense is under governance approval'
      USING ERRCODE = '42501', HINT = 'GOV_USE_APPROVAL_ENGINE';
  END IF;

  RETURN public._expense_apply_approval(p_expense_id, auth.uid());
END;
$$;

CREATE OR REPLACE FUNCTION public.expense_reject(p_expense_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE r public.expenses; v_live uuid;
BEGIN
  r := public._expense_guard(p_expense_id, ARRAY['draft','pending','submitted']);

  SELECT ar.id INTO v_live
    FROM public.approval_requests ar
   WHERE ar.id = r.approval_request_id
     AND ar.status NOT IN ('approved','rejected','cancelled');
  IF v_live IS NOT NULL THEN
    RAISE EXCEPTION 'This expense is under governance approval'
      USING ERRCODE = '42501', HINT = 'GOV_USE_APPROVAL_ENGINE';
  END IF;

  UPDATE public.expenses
     SET status = 'rejected', rejected_reason = p_reason, updated_at = now()
   WHERE id = p_expense_id;

  INSERT INTO public.audit_logs
    (organization_id, business_id, user_id, action, entity_type, entity_id, new_values)
  VALUES (r.organization_id, r.business_id, auth.uid(), 'expense.reject', 'expense', r.id,
          jsonb_build_object('reason', p_reason));

  RETURN jsonb_build_object('success', true, 'status', 'rejected');
END;
$$;

CREATE OR REPLACE FUNCTION public.expense_void(p_expense_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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

  UPDATE public.expenses
     SET status = 'voided', voided_at = now(), voided_by = auth.uid(), updated_at = now()
   WHERE id = p_expense_id;

  INSERT INTO public.audit_logs
    (organization_id, business_id, user_id, action, entity_type, entity_id, new_values)
  VALUES (r.organization_id, r.business_id, auth.uid(), 'expense.void', 'expense', r.id,
          jsonb_build_object('reason', p_reason, 'journal_entry_id', r.journal_entry_id));

  RETURN jsonb_build_object('success', true, 'status', 'voided');
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Expense -> Bill: one server command, one bill, ever.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expense_convert_to_bill(p_expense_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r public.expenses;
  v_bill_id uuid;
  v_bill_number text;
  v_subtotal numeric;
  v_days int;
BEGIN
  r := public._expense_guard(p_expense_id, NULL);

  IF r.status::text IN ('voided','rejected') THEN
    RAISE EXCEPTION 'Expense is %, cannot become a vendor bill', r.status
      USING ERRCODE = '22023';
  END IF;

  SELECT id, bill_number INTO v_bill_id, v_bill_number
    FROM public.bills WHERE source_expense_id = p_expense_id LIMIT 1;
  IF v_bill_id IS NOT NULL THEN
    RETURN jsonb_build_object('bill_id', v_bill_id, 'bill_number', v_bill_number,
                              'idempotent_replay', true);
  END IF;

  IF r.vendor_id IS NULL THEN
    RAISE EXCEPTION 'Select a supplier before converting this expense to a bill'
      USING ERRCODE = '22023';
  END IF;

  IF r.journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'This expense is already posted; void it before creating a vendor bill'
      USING ERRCODE = '22023';
  END IF;

  v_subtotal := COALESCE(r.amount, 0) - COALESCE(r.tax_amount, 0);
  v_days := 30;

  v_bill_number := public.get_next_bill_number(r.organization_id, r.business_id, r.branch_id);

  INSERT INTO public.bills (
    organization_id, business_id, branch_id, created_by, bill_number, vendor_id,
    bill_date, due_date, subtotal, tax_amount, total, amount_paid, status,
    currency, notes, vendor_invoice_number, source_expense_id
  ) VALUES (
    r.organization_id, r.business_id, r.branch_id, auth.uid(), v_bill_number, r.vendor_id,
    r.expense_date, r.expense_date + v_days, v_subtotal, COALESCE(r.tax_amount, 0),
    COALESCE(r.amount, 0), 0, 'received',
    r.currency, 'Created from expense: ' || COALESCE(r.description, ''),
    r.reference, p_expense_id
  ) RETURNING id INTO v_bill_id;

  INSERT INTO public.bill_items (
    bill_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, sort_order
  ) VALUES (
    v_bill_id, COALESCE(r.description, 'Expense'), 1, v_subtotal,
    CASE WHEN v_subtotal > 0 AND COALESCE(r.tax_amount, 0) > 0
         THEN ROUND(r.tax_amount / v_subtotal * 100, 4) ELSE 0 END,
    COALESCE(r.tax_amount, 0), v_subtotal, 0
  );

  INSERT INTO public.audit_logs
    (organization_id, business_id, user_id, action, entity_type, entity_id, new_values)
  VALUES (r.organization_id, r.business_id, auth.uid(), 'expense.convert_to_bill',
          'expense', r.id, jsonb_build_object('bill_id', v_bill_id, 'bill_number', v_bill_number));

  RETURN jsonb_build_object('bill_id', v_bill_id, 'bill_number', v_bill_number);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Governance decisions mirror back onto the expense.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._mirror_approval_to_expense()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_exp public.expenses; v_actor uuid;
BEGIN
  IF NEW.entity_type <> 'expense' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  SELECT * INTO v_exp FROM public.expenses WHERE id = NEW.entity_id;
  IF v_exp.id IS NULL THEN RETURN NEW; END IF;

  SELECT h.actor_user_id INTO v_actor
    FROM public.approval_history h
   WHERE h.request_id = NEW.id AND h.actor_user_id IS NOT NULL
   ORDER BY h.created_at DESC LIMIT 1;
  v_actor := COALESCE(auth.uid(), v_actor);

  IF NEW.status = 'approved' AND v_exp.status::text IN ('submitted','pending','draft') THEN
    PERFORM public._expense_apply_approval(v_exp.id, v_actor);
  ELSIF NEW.status IN ('rejected','cancelled')
        AND v_exp.status::text IN ('submitted','pending') THEN
    UPDATE public.expenses
       SET status = 'rejected', approval_request_id = NULL, updated_at = now()
     WHERE id = v_exp.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mirror_approval_to_expense ON public.approval_requests;
CREATE TRIGGER trg_mirror_approval_to_expense
  AFTER UPDATE ON public.approval_requests
  FOR EACH ROW EXECUTE FUNCTION public._mirror_approval_to_expense();

-- ---------------------------------------------------------------------------
-- 7. Client cannot author expense state any more.
-- ---------------------------------------------------------------------------
REVOKE UPDATE ON public.expenses FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.expenses TO authenticated;
GRANT UPDATE (
  category_id, vendor_id, account_id, payment_account_id, expense_date, amount,
  tax_amount, currency, exchange_rate, description, reference, receipt_url,
  is_billable, payment_method, paid_by, branch_id, project_id, task_id,
  department_id, employee_id, reimburse_via_payroll, updated_at
) ON public.expenses TO authenticated;
GRANT ALL ON public.expenses TO service_role;

GRANT EXECUTE ON FUNCTION public.expense_submit(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.expense_approve(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.expense_reject(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.expense_void(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.expense_convert_to_bill(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public._expense_apply_approval(uuid, uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public._expense_guard(uuid, text[]) FROM authenticated;