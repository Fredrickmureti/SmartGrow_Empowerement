-- D1
DROP FUNCTION IF EXISTS public.process_pos_transaction(
  uuid, uuid, uuid, jsonb, jsonb, numeric, numeric, numeric, numeric,
  uuid, text, text, text, uuid, uuid, text, uuid, uuid, numeric, uuid, uuid
);

-- D2
CREATE OR REPLACE FUNCTION public.post_pos_shift_gl(_shift_id uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_shift RECORD; v_existing uuid; v_org_id uuid; v_business_id uuid; v_branch_id uuid; v_actor uuid;
  v_cash_account uuid; v_revenue_account uuid; v_tax_account uuid;
  v_total_sales numeric := 0; v_total_tax numeric := 0; v_total_net numeric := 0;
  v_shift_date date; v_reference text; v_entry_number text; v_lines jsonb; v_jeid uuid;
BEGIN
  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = _shift_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'POS shift not found: %', _shift_id; END IF;
  v_existing := v_shift.journal_entry_id;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_org_id := v_shift.organization_id; v_business_id := v_shift.business_id; v_branch_id := v_shift.branch_id;
  IF v_branch_id IS NULL AND v_shift.register_id IS NOT NULL THEN
    SELECT branch_id INTO v_branch_id FROM public.pos_registers WHERE id = v_shift.register_id;
  END IF;

  v_actor := COALESCE(auth.uid(), v_shift.closed_by);
  IF v_actor IS NOT NULL AND v_business_id IS NOT NULL THEN
    IF NOT (
      EXISTS (SELECT 1 FROM public.user_business_access WHERE user_id = v_actor AND business_id = v_business_id)
      OR public.has_role(v_actor, v_org_id, 'owner'::public.app_role)
      OR public.has_role(v_actor, v_org_id, 'admin'::public.app_role)
    ) THEN
      RAISE EXCEPTION 'User % lacks business access to post POS shift GL for business %', v_actor, v_business_id USING ERRCODE = '42501';
    END IF;
  END IF;

  v_shift_date := COALESCE(v_shift.closed_at, v_shift.created_at, now())::date;
  v_reference  := 'POS-SHIFT-' || COALESCE(v_shift.shift_number, _shift_id::text);

  SELECT COALESCE(SUM(total),0), COALESCE(SUM(tax_amount),0), COALESCE(SUM(subtotal),0)
    INTO v_total_sales, v_total_tax, v_total_net
  FROM public.pos_transactions
  WHERE shift_id = _shift_id AND transaction_type='sale' AND status='completed';

  IF v_total_sales = 0 THEN RETURN NULL; END IF;

  v_cash_account := public.get_default_account_id(v_org_id, v_business_id, 'pos_cash');
  IF v_cash_account IS NULL THEN v_cash_account := public.get_default_account_id(v_org_id, v_business_id, 'cash'); END IF;
  v_revenue_account := public.get_default_account_id(v_org_id, v_business_id, 'pos_revenue');
  IF v_revenue_account IS NULL THEN v_revenue_account := public.get_default_account_id(v_org_id, v_business_id, 'sales_revenue'); END IF;
  v_tax_account := public.get_default_account_id(v_org_id, v_business_id, 'pos_tax_payable');
  IF v_tax_account IS NULL THEN v_tax_account := public.get_default_account_id(v_org_id, v_business_id, 'tax_payable'); END IF;
  IF v_tax_account IS NULL THEN v_tax_account := public.get_default_account_id(v_org_id, v_business_id, 'sales_tax_payable'); END IF;

  IF v_cash_account IS NULL OR v_revenue_account IS NULL THEN
    RAISE EXCEPTION 'POS shift cannot post to GL: missing default account mapping (pos_cash/cash, pos_revenue/sales_revenue). shift_id=%', _shift_id;
  END IF;
  IF v_total_tax > 0 AND v_tax_account IS NULL THEN
    RAISE EXCEPTION 'POS shift has tax of % but no tax-payable account is mapped.', v_total_tax;
  END IF;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', v_cash_account, 'debit', v_total_sales, 'credit', 0, 'description', 'POS Cash/Card Receipts'),
    jsonb_build_object('account_id', v_revenue_account, 'debit', 0, 'credit', v_total_net, 'description', 'POS Sales Revenue')
  );
  IF v_total_tax > 0 AND v_tax_account IS NOT NULL THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_tax_account, 'debit', 0, 'credit', v_total_tax, 'description', 'POS Sales Tax Collected')
    );
  END IF;

  SELECT COALESCE('JE-' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(entry_number,'[^0-9]','','g'),''))::int,0)+1)::text,5,'0'),'JE-00001')
    INTO v_entry_number FROM public.journal_entries WHERE organization_id = v_org_id;

  v_jeid := public.post_journal_entry_atomic(
    v_org_id, v_business_id, v_entry_number, v_shift_date, v_reference,
    'POS Shift Close - aggregated GL posting','pos_shift', _shift_id, v_shift.closed_by,
    false, false, v_lines, NULL, NULL, 'main', v_branch_id
  );

  BEGIN
    UPDATE public.pos_shifts SET journal_entry_id = v_jeid, gl_posted_at = COALESCE(gl_posted_at, now()) WHERE id = _shift_id;
  EXCEPTION WHEN undefined_column THEN NULL; END;
  RETURN v_jeid;
END $function$;

-- helper for Z/X access
CREATE OR REPLACE FUNCTION public._pos_assert_business_access(_org uuid, _business uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN RETURN; END IF;
  IF NOT (
    EXISTS (SELECT 1 FROM public.user_business_access WHERE user_id = v_actor AND business_id = _business)
    OR public.has_role(v_actor, _org, 'owner'::public.app_role)
    OR public.has_role(v_actor, _org, 'admin'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'User lacks business access for POS report' USING ERRCODE = '42501';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.get_pos_x_report(p_organization_id uuid, p_business_id uuid, p_shift_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_result JSONB; v_shift RECORD; v_totals JSONB; v_payment_breakdown JSONB;
BEGIN
  IF p_business_id IS NULL THEN RAISE EXCEPTION 'business_id is required for POS X-Report' USING ERRCODE='invalid_parameter_value'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.businesses WHERE id=p_business_id AND organization_id=p_organization_id) THEN
    RAISE EXCEPTION 'business % does not belong to organization %', p_business_id, p_organization_id USING ERRCODE='insufficient_privilege';
  END IF;
  PERFORM public._pos_assert_business_access(p_organization_id, p_business_id);

  SELECT * INTO v_shift FROM pos_shifts s
    WHERE s.id=p_shift_id AND s.organization_id=p_organization_id AND s.business_id=p_business_id;
  IF v_shift IS NULL THEN RETURN jsonb_build_object('success',false,'error','Shift not found in this Company'); END IF;

  SELECT jsonb_build_object(
    'total_sales', COALESCE(SUM(CASE WHEN transaction_type='sale' AND status='completed' THEN total ELSE 0 END),0),
    'total_returns', COALESCE(SUM(CASE WHEN transaction_type='return' AND status='completed' THEN total ELSE 0 END),0),
    'total_voids', COALESCE(SUM(CASE WHEN status='voided' THEN total ELSE 0 END),0),
    'net_sales', COALESCE(SUM(CASE WHEN status='completed' AND transaction_type='sale' THEN total
                                    WHEN status='completed' AND transaction_type='return' THEN -total ELSE 0 END),0),
    'total_tax', COALESCE(SUM(CASE WHEN status='completed' THEN tax_amount ELSE 0 END),0),
    'total_discounts', COALESCE(SUM(CASE WHEN status='completed' THEN discount_amount ELSE 0 END),0),
    'total_tips', COALESCE(SUM(CASE WHEN status='completed' THEN COALESCE(tip_amount,0) ELSE 0 END),0),
    'transaction_count', COUNT(*) FILTER (WHERE status='completed'),
    'void_count', COUNT(*) FILTER (WHERE status='voided'),
    'return_count', COUNT(*) FILTER (WHERE transaction_type='return' AND status='completed')
  ) INTO v_totals
  FROM pos_transactions WHERE shift_id=p_shift_id AND business_id=p_business_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('payment_method',sub.payment_method,'total_amount',sub.total_amount,'transaction_count',sub.txn_count)),'[]'::JSONB)
    INTO v_payment_breakdown
  FROM (SELECT p.payment_method, SUM(p.amount) AS total_amount, COUNT(DISTINCT p.transaction_id) AS txn_count
        FROM pos_transaction_payments p JOIN pos_transactions t ON t.id=p.transaction_id
        WHERE t.shift_id=p_shift_id AND t.business_id=p_business_id AND t.status='completed' AND p.status='completed'
        GROUP BY p.payment_method) sub;

  v_result := jsonb_build_object('shift_id',v_shift.id,'shift_number',v_shift.shift_number,'opened_at',v_shift.opened_at,
    'status',v_shift.status,'opening_cash',v_shift.opening_cash,'expected_cash',v_shift.expected_cash,
    'business_id',p_business_id,'totals',v_totals,'payment_breakdown',v_payment_breakdown,'generated_at',now());
  RETURN v_result;
END $function$;

CREATE OR REPLACE FUNCTION public.get_pos_z_report(p_organization_id uuid, p_business_id uuid, p_date date DEFAULT CURRENT_DATE, p_register_id uuid DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_result JSONB; v_shifts JSONB; v_payment_breakdown JSONB; v_tax_summary JSONB; v_totals JSONB;
BEGIN
  IF p_business_id IS NULL THEN RAISE EXCEPTION 'business_id is required for POS Z-Report' USING ERRCODE='invalid_parameter_value'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.businesses WHERE id=p_business_id AND organization_id=p_organization_id) THEN
    RAISE EXCEPTION 'business % does not belong to organization %', p_business_id, p_organization_id USING ERRCODE='insufficient_privilege';
  END IF;
  PERFORM public._pos_assert_business_access(p_organization_id, p_business_id);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'shift_id',s.id,'shift_number',s.shift_number,'user_id',s.user_id,
    'opened_at',s.opened_at,'closed_at',s.closed_at,'status',s.status,
    'opening_cash',s.opening_cash,'expected_cash',s.expected_cash,
    'actual_cash',s.actual_cash,'cash_difference',s.cash_difference)),'[]'::JSONB) INTO v_shifts
  FROM pos_shifts s
  WHERE s.organization_id=p_organization_id AND s.business_id=p_business_id
    AND DATE(COALESCE(s.closed_at,s.opened_at))=p_date
    AND (p_register_id IS NULL OR s.register_id=p_register_id);

  SELECT jsonb_build_object(
    'total_sales', COALESCE(SUM(CASE WHEN t.transaction_type='sale' AND t.status='completed' THEN t.total ELSE 0 END),0),
    'total_returns', COALESCE(SUM(CASE WHEN t.transaction_type='return' AND t.status='completed' THEN t.total ELSE 0 END),0),
    'total_voids', COALESCE(SUM(CASE WHEN t.status='voided' THEN t.total ELSE 0 END),0),
    'net_sales', COALESCE(SUM(CASE WHEN t.status='completed' AND t.transaction_type='sale' THEN t.total
                                    WHEN t.status='completed' AND t.transaction_type='return' THEN -t.total ELSE 0 END),0),
    'total_tax', COALESCE(SUM(CASE WHEN t.status='completed' THEN t.tax_amount ELSE 0 END),0),
    'total_discounts', COALESCE(SUM(CASE WHEN t.status='completed' THEN t.discount_amount ELSE 0 END),0),
    'transaction_count', COUNT(*) FILTER (WHERE t.status='completed')
  ) INTO v_totals
  FROM pos_transactions t JOIN pos_shifts s ON s.id=t.shift_id
  WHERE s.organization_id=p_organization_id AND s.business_id=p_business_id
    AND DATE(COALESCE(s.closed_at,s.opened_at))=p_date
    AND (p_register_id IS NULL OR s.register_id=p_register_id);

  SELECT COALESCE(jsonb_agg(jsonb_build_object('payment_method',sub.payment_method,'total_amount',sub.total_amount,'transaction_count',sub.txn_count)),'[]'::JSONB)
    INTO v_payment_breakdown
  FROM (SELECT p.payment_method, SUM(p.amount) AS total_amount, COUNT(DISTINCT p.transaction_id) AS txn_count
        FROM pos_transaction_payments p JOIN pos_transactions t ON t.id=p.transaction_id
        JOIN pos_shifts s ON s.id=t.shift_id
        WHERE s.organization_id=p_organization_id AND s.business_id=p_business_id
          AND DATE(COALESCE(s.closed_at,s.opened_at))=p_date
          AND (p_register_id IS NULL OR s.register_id=p_register_id)
          AND t.status='completed' AND p.status='completed'
        GROUP BY p.payment_method) sub;

  v_tax_summary := '[]'::jsonb;
  v_result := jsonb_build_object('date',p_date,'business_id',p_business_id,'register_id',p_register_id,
    'shifts',v_shifts,'totals',v_totals,'payment_breakdown',v_payment_breakdown,'tax_summary',v_tax_summary,'generated_at',now());
  RETURN v_result;
END $function$;

-- D5
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pos_settings_business_key
  ON public.pos_settings (business_id, setting_key)
  WHERE branch_id IS NULL AND register_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pos_settings_branch_key
  ON public.pos_settings (business_id, branch_id, setting_key)
  WHERE branch_id IS NOT NULL AND register_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pos_settings_register_key
  ON public.pos_settings (register_id, setting_key)
  WHERE register_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_pos_security_settings_business
  ON public.pos_security_settings (business_id)
  WHERE branch_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pos_security_settings_branch
  ON public.pos_security_settings (business_id, branch_id)
  WHERE branch_id IS NOT NULL;

-- D3 (partial): unique company-wide payment method keys per business
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pos_payment_methods_business_key
  ON public.pos_payment_methods (business_id, method_key)
  WHERE branch_id IS NULL;

-- D4
ALTER TABLE public.pos_cashiers ALTER COLUMN branch_id SET NOT NULL;

CREATE OR REPLACE FUNCTION public.enforce_cashier_register_branch_match()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_cashier_branch uuid; v_register_branch uuid;
BEGIN
  SELECT branch_id INTO v_cashier_branch FROM public.pos_cashiers WHERE id = NEW.cashier_id;
  SELECT branch_id INTO v_register_branch FROM public.pos_registers WHERE id = NEW.register_id;
  IF v_cashier_branch IS NULL OR v_register_branch IS NULL OR v_cashier_branch <> v_register_branch THEN
    RAISE EXCEPTION 'Cashier branch (%) must match register branch (%)', v_cashier_branch, v_register_branch USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_enforce_cashier_register_branch_match ON public.pos_cashier_registers;
CREATE TRIGGER trg_enforce_cashier_register_branch_match
  BEFORE INSERT OR UPDATE ON public.pos_cashier_registers
  FOR EACH ROW EXECUTE FUNCTION public.enforce_cashier_register_branch_match();

-- D8
ALTER TABLE public.pos_transaction_items
  ADD COLUMN IF NOT EXISTS organization_id uuid,
  ADD COLUMN IF NOT EXISTS business_id uuid;
ALTER TABLE public.pos_transaction_payments
  ADD COLUMN IF NOT EXISTS organization_id uuid,
  ADD COLUMN IF NOT EXISTS business_id uuid;
ALTER TABLE public.pos_cashier_registers
  ADD COLUMN IF NOT EXISTS organization_id uuid,
  ADD COLUMN IF NOT EXISTS business_id uuid;

CREATE OR REPLACE FUNCTION public.stamp_pos_child_scope_from_txn()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_org uuid; v_biz uuid;
BEGIN
  SELECT organization_id, business_id INTO v_org, v_biz FROM public.pos_transactions WHERE id = NEW.transaction_id;
  IF v_org IS NULL OR v_biz IS NULL THEN
    RAISE EXCEPTION 'Parent pos_transaction % missing scope', NEW.transaction_id USING ERRCODE='23514';
  END IF;
  IF NEW.organization_id IS NOT NULL AND NEW.organization_id <> v_org THEN
    RAISE EXCEPTION 'organization_id mismatch with parent transaction' USING ERRCODE='23514';
  END IF;
  IF NEW.business_id IS NOT NULL AND NEW.business_id <> v_biz THEN
    RAISE EXCEPTION 'business_id mismatch with parent transaction' USING ERRCODE='23514';
  END IF;
  NEW.organization_id := v_org; NEW.business_id := v_biz;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_stamp_pos_txn_items_scope ON public.pos_transaction_items;
CREATE TRIGGER trg_stamp_pos_txn_items_scope BEFORE INSERT OR UPDATE ON public.pos_transaction_items
  FOR EACH ROW EXECUTE FUNCTION public.stamp_pos_child_scope_from_txn();
DROP TRIGGER IF EXISTS trg_stamp_pos_txn_payments_scope ON public.pos_transaction_payments;
CREATE TRIGGER trg_stamp_pos_txn_payments_scope BEFORE INSERT OR UPDATE ON public.pos_transaction_payments
  FOR EACH ROW EXECUTE FUNCTION public.stamp_pos_child_scope_from_txn();

CREATE OR REPLACE FUNCTION public.stamp_pos_cashier_register_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_org uuid; v_biz uuid;
BEGIN
  SELECT organization_id, business_id INTO v_org, v_biz FROM public.pos_cashiers WHERE id = NEW.cashier_id;
  NEW.organization_id := v_org; NEW.business_id := v_biz;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_stamp_pos_cashier_register_scope ON public.pos_cashier_registers;
CREATE TRIGGER trg_stamp_pos_cashier_register_scope BEFORE INSERT OR UPDATE ON public.pos_cashier_registers
  FOR EACH ROW EXECUTE FUNCTION public.stamp_pos_cashier_register_scope();

-- D9
CREATE OR REPLACE FUNCTION public.enforce_pos_credit_invoice_lineage()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_txn_biz uuid; v_txn_branch uuid;
BEGIN
  IF NEW.source IS DISTINCT FROM 'pos_credit' THEN RETURN NEW; END IF;
  IF NEW.source_recurring_id IS NULL THEN RETURN NEW; END IF;
  SELECT business_id, branch_id INTO v_txn_biz, v_txn_branch FROM public.pos_transactions WHERE id = NEW.source_recurring_id;
  IF v_txn_biz IS NULL THEN RETURN NEW; END IF;
  IF NEW.business_id <> v_txn_biz THEN
    RAISE EXCEPTION 'POS-credit invoice business_id (%) must match originating POS transaction (%)', NEW.business_id, v_txn_biz USING ERRCODE='23514';
  END IF;
  IF v_txn_branch IS NOT NULL AND (NEW.branch_id IS DISTINCT FROM v_txn_branch) THEN
    NEW.branch_id := v_txn_branch;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_enforce_pos_credit_invoice_lineage ON public.invoices;
CREATE TRIGGER trg_enforce_pos_credit_invoice_lineage BEFORE INSERT OR UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.enforce_pos_credit_invoice_lineage();