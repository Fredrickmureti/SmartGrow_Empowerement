
-- =========================================================================
-- SoD Wave G2 — Migration 4: canonical approve_* RPCs
-- =========================================================================

-- approve_bill --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_bill(p_bill_id uuid)
RETURNS public.bills LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); r public.bills;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found' USING ERRCODE='P0002'; END IF;
  IF lower(coalesce(r.status,'')) NOT IN ('draft','submitted','pending','pending_approval') THEN
    RAISE EXCEPTION 'Bill is %, cannot approve', r.status USING ERRCODE='22023';
  END IF;
  UPDATE public.bills SET status='approved', approved_by=v_uid, approved_at=now(), updated_at=now()
   WHERE id=p_bill_id RETURNING * INTO r;
  INSERT INTO public.audit_logs(organization_id,business_id,user_id,action,entity_type,entity_id,new_values)
  VALUES (r.organization_id, r.business_id, v_uid, 'bill.approve', 'bill', r.id,
          jsonb_build_object('amount', to_jsonb(r)->'total_amount'));
  RETURN r;
END$$;
GRANT EXECUTE ON FUNCTION public.approve_bill(uuid) TO authenticated;

-- approve_bill_payment -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_bill_payment(p_payment_id uuid)
RETURNS public.bill_payments LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); r public.bill_payments;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.bill_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill payment not found' USING ERRCODE='P0002'; END IF;
  IF r.approved_by IS NOT NULL THEN
    RAISE EXCEPTION 'Bill payment already approved' USING ERRCODE='22023';
  END IF;
  UPDATE public.bill_payments SET approved_by=v_uid, approved_at=now(), updated_at=now()
   WHERE id=p_payment_id RETURNING * INTO r;
  INSERT INTO public.audit_logs(organization_id,business_id,user_id,action,entity_type,entity_id,new_values)
  VALUES (r.organization_id, r.business_id, v_uid, 'bill_payment.approve', 'bill_payment', r.id, '{}'::jsonb);
  RETURN r;
END$$;
GRANT EXECUTE ON FUNCTION public.approve_bill_payment(uuid) TO authenticated;

-- approve_payment ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_payment(p_payment_id uuid)
RETURNS public.payments LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); r public.payments;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found' USING ERRCODE='P0002'; END IF;
  IF lower(coalesce(r.status,'')) NOT IN ('draft','pending','pending_approval','submitted') THEN
    RAISE EXCEPTION 'Payment is %, cannot approve', r.status USING ERRCODE='22023';
  END IF;
  UPDATE public.payments SET status='approved', approved_by=v_uid, approved_at=now(), updated_at=now()
   WHERE id=p_payment_id RETURNING * INTO r;
  INSERT INTO public.audit_logs(organization_id,business_id,user_id,action,entity_type,entity_id,new_values)
  VALUES (r.organization_id, r.business_id, v_uid, 'payment.approve', 'payment', r.id, '{}'::jsonb);
  RETURN r;
END$$;
GRANT EXECUTE ON FUNCTION public.approve_payment(uuid) TO authenticated;

-- approve_journal_entry ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_journal_entry(p_je_id uuid)
RETURNS public.journal_entries LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); r public.journal_entries;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.journal_entries WHERE id = p_je_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Journal entry not found' USING ERRCODE='P0002'; END IF;
  IF lower(coalesce(r.status,'')) NOT IN ('draft','pending','pending_approval','submitted') THEN
    RAISE EXCEPTION 'Journal entry is %, cannot approve', r.status USING ERRCODE='22023';
  END IF;
  UPDATE public.journal_entries SET status='posted', approved_by=v_uid, approved_at=now(), updated_at=now()
   WHERE id=p_je_id RETURNING * INTO r;
  INSERT INTO public.audit_logs(organization_id,business_id,user_id,action,entity_type,entity_id,new_values)
  VALUES (r.organization_id, r.business_id, v_uid, 'journal_entry.post', 'journal_entry', r.id, '{}'::jsonb);
  RETURN r;
END$$;
GRANT EXECUTE ON FUNCTION public.approve_journal_entry(uuid) TO authenticated;

-- approve_purchase_order ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_purchase_order(p_po_id uuid)
RETURNS public.purchase_orders LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); r public.purchase_orders;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found' USING ERRCODE='P0002'; END IF;
  IF lower(coalesce(r.status,'')) NOT IN ('draft','submitted','pending','pending_approval') THEN
    RAISE EXCEPTION 'Purchase order is %, cannot approve', r.status USING ERRCODE='22023';
  END IF;
  UPDATE public.purchase_orders SET status='approved', approved_by=v_uid, approved_at=now(), updated_at=now()
   WHERE id=p_po_id RETURNING * INTO r;
  INSERT INTO public.audit_logs(organization_id,business_id,user_id,action,entity_type,entity_id,new_values)
  VALUES (r.organization_id, r.business_id, v_uid, 'purchase_order.approve', 'purchase_order', r.id, '{}'::jsonb);
  RETURN r;
END$$;
GRANT EXECUTE ON FUNCTION public.approve_purchase_order(uuid) TO authenticated;

-- approve_expense ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_expense(p_expense_id uuid)
RETURNS public.expenses LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); r public.expenses;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found' USING ERRCODE='P0002'; END IF;
  IF lower(coalesce(r.status,'')) NOT IN ('draft','submitted','pending','pending_approval') THEN
    RAISE EXCEPTION 'Expense is %, cannot approve', r.status USING ERRCODE='22023';
  END IF;
  UPDATE public.expenses SET status='approved', approved_by=v_uid, approved_at=now(), updated_at=now()
   WHERE id=p_expense_id RETURNING * INTO r;
  INSERT INTO public.audit_logs(organization_id,business_id,user_id,action,entity_type,entity_id,new_values)
  VALUES (r.organization_id, r.business_id, v_uid, 'expense.approve', 'expense', r.id, '{}'::jsonb);
  RETURN r;
END$$;
GRANT EXECUTE ON FUNCTION public.approve_expense(uuid) TO authenticated;

-- approve_employee_loan ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_employee_loan(p_loan_id uuid)
RETURNS public.employee_loans LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); r public.employee_loans;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.employee_loans WHERE id = p_loan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found' USING ERRCODE='P0002'; END IF;
  IF lower(coalesce(r.status,'')) NOT IN ('draft','requested','pending','pending_approval','submitted') THEN
    RAISE EXCEPTION 'Loan is %, cannot approve', r.status USING ERRCODE='22023';
  END IF;
  UPDATE public.employee_loans SET status='approved', approved_by=v_uid, updated_at=now()
   WHERE id=p_loan_id RETURNING * INTO r;
  INSERT INTO public.audit_logs(organization_id,business_id,user_id,action,entity_type,entity_id,new_values)
  VALUES (r.organization_id, r.business_id, v_uid, 'loan.approve', 'employee_loan', r.id,
          jsonb_build_object('employee_id', r.employee_id));
  RETURN r;
END$$;
GRANT EXECUTE ON FUNCTION public.approve_employee_loan(uuid) TO authenticated;

-- approve_customer_refund --------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_customer_refund(p_refund_id uuid)
RETURNS public.customer_refunds LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); r public.customer_refunds;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.customer_refunds WHERE id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Refund not found' USING ERRCODE='P0002'; END IF;
  IF lower(coalesce(r.status,'')) NOT IN ('draft','submitted','pending','pending_approval') THEN
    RAISE EXCEPTION 'Refund is %, cannot approve', r.status USING ERRCODE='22023';
  END IF;
  UPDATE public.customer_refunds SET status='approved', approved_by=v_uid, approved_at=now(), updated_at=now()
   WHERE id=p_refund_id RETURNING * INTO r;
  INSERT INTO public.audit_logs(organization_id,business_id,user_id,action,entity_type,entity_id,new_values)
  VALUES (r.organization_id, r.business_id, v_uid, 'customer_refund.approve', 'customer_refund', r.id, '{}'::jsonb);
  RETURN r;
END$$;
GRANT EXECUTE ON FUNCTION public.approve_customer_refund(uuid) TO authenticated;

-- approve_vendor_credit_note -----------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_vendor_credit_note(p_id uuid)
RETURNS public.vendor_credit_notes LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); r public.vendor_credit_notes;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.vendor_credit_notes WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vendor credit note not found' USING ERRCODE='P0002'; END IF;
  IF lower(coalesce(r.status,'')) NOT IN ('draft','submitted','pending','pending_approval') THEN
    RAISE EXCEPTION 'Vendor credit note is %, cannot approve', r.status USING ERRCODE='22023';
  END IF;
  UPDATE public.vendor_credit_notes SET status='approved', approved_by=v_uid, approved_at=now(), updated_at=now()
   WHERE id=p_id RETURNING * INTO r;
  INSERT INTO public.audit_logs(organization_id,business_id,user_id,action,entity_type,entity_id,new_values)
  VALUES (r.organization_id, r.business_id, v_uid, 'vendor_credit_note.approve', 'vendor_credit_note', r.id, '{}'::jsonb);
  RETURN r;
END$$;
GRANT EXECUTE ON FUNCTION public.approve_vendor_credit_note(uuid) TO authenticated;

-- approve_credit_note (sales) ----------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_credit_note(p_id uuid)
RETURNS public.credit_notes LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); r public.credit_notes;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.credit_notes WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Credit note not found' USING ERRCODE='P0002'; END IF;
  IF lower(coalesce(r.status,'')) NOT IN ('draft','submitted','pending','pending_approval') THEN
    RAISE EXCEPTION 'Credit note is %, cannot approve', r.status USING ERRCODE='22023';
  END IF;
  UPDATE public.credit_notes SET status='approved', approved_by=v_uid, approved_at=now(), updated_at=now()
   WHERE id=p_id RETURNING * INTO r;
  INSERT INTO public.audit_logs(organization_id,business_id,user_id,action,entity_type,entity_id,new_values)
  VALUES (r.organization_id, r.business_id, v_uid, 'credit_note.approve', 'credit_note', r.id, '{}'::jsonb);
  RETURN r;
END$$;
GRANT EXECUTE ON FUNCTION public.approve_credit_note(uuid) TO authenticated;

-- approve_compensation_change ---------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_compensation_change(p_id uuid)
RETURNS public.employee_compensation_history LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); r public.employee_compensation_history;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.employee_compensation_history WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Compensation change not found' USING ERRCODE='P0002'; END IF;
  IF r.approved_by IS NOT NULL THEN
    RAISE EXCEPTION 'Compensation change already approved' USING ERRCODE='22023';
  END IF;
  UPDATE public.employee_compensation_history
     SET approved_by=v_uid, approved_at=now()
   WHERE id=p_id RETURNING * INTO r;
  INSERT INTO public.audit_logs(organization_id,business_id,user_id,action,entity_type,entity_id,new_values)
  VALUES (r.organization_id, r.business_id, v_uid, 'compensation.approve',
          'employee_compensation_history', r.id,
          jsonb_build_object('employee_id', r.employee_id));
  RETURN r;
END$$;
GRANT EXECUTE ON FUNCTION public.approve_compensation_change(uuid) TO authenticated;

-- approve_employee_contract ------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_employee_contract(p_id uuid)
RETURNS public.employee_contracts LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); r public.employee_contracts;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.employee_contracts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Contract not found' USING ERRCODE='P0002'; END IF;
  IF lower(coalesce(r.status,'')) NOT IN ('draft','pending','pending_approval','submitted') THEN
    RAISE EXCEPTION 'Contract is %, cannot approve', r.status USING ERRCODE='22023';
  END IF;
  UPDATE public.employee_contracts SET status='active', approved_by=v_uid, approved_at=now(), updated_at=now()
   WHERE id=p_id RETURNING * INTO r;
  INSERT INTO public.audit_logs(organization_id,business_id,user_id,action,entity_type,entity_id,new_values)
  VALUES (r.organization_id, r.business_id, v_uid, 'contract.approve', 'employee_contract', r.id,
          jsonb_build_object('employee_id', r.employee_id));
  RETURN r;
END$$;
GRANT EXECUTE ON FUNCTION public.approve_employee_contract(uuid) TO authenticated;
