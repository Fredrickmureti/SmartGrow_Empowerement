-- Wave 2a — extend teardown bypass to all remaining operational guards
CREATE OR REPLACE FUNCTION public.enforce_payroll_maker_checker()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  v_role public.app_role;
  v_policy text;
  v_has_approve boolean := false;
BEGIN
  IF public._is_teardown_for_org(NEW.organization_id) THEN RETURN NEW; END IF;
  IF TG_OP <> 'UPDATE'
     OR NEW.status NOT IN ('approved','posted','finalized')
     OR COALESCE(OLD.status,'') IN ('approved','posted','finalized') THEN
    RETURN NEW;
  END IF;
  IF NEW.approved_by IS NULL THEN
    RAISE EXCEPTION 'Payroll approval requires an approver (approved_by must be set).';
  END IF;
  v_has_approve := public.user_has_module_permission(
    NEW.approved_by, NEW.organization_id, 'payroll', 'approve'
  );
  IF NOT v_has_approve THEN
    RAISE EXCEPTION 'Approver lacks payroll.approve permission. Grant it via Access Groups or assign an admin/owner.';
  END IF;
  IF NEW.created_by IS NOT NULL AND NEW.approved_by = NEW.created_by THEN
    SELECT ur.role INTO v_role FROM public.user_roles ur
    WHERE ur.user_id = NEW.approved_by AND ur.organization_id = NEW.organization_id
      AND ur.is_active = true LIMIT 1;
    SELECT b.payroll_self_approval_policy INTO v_policy
    FROM public.businesses b WHERE b.id = NEW.business_id;
    v_policy := COALESCE(v_policy, 'admin_only');
    IF v_policy = 'disabled' THEN
      RAISE EXCEPTION 'Payroll self-approval is disabled for this workspace.';
    ELSIF v_policy = 'admin_only' THEN
      IF v_role NOT IN ('super_admin','owner','admin') THEN
        RAISE EXCEPTION 'Only owner/admin may self-approve payroll under the current policy.';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_liability_paid_via_allocations()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE v_alloc NUMERIC(18,2);
BEGIN
  IF public._is_teardown_for_org(COALESCE(NEW.organization_id, OLD.organization_id)) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.paid_amount IS DISTINCT FROM OLD.paid_amount THEN
    SELECT COALESCE(SUM(a.amount),0) INTO v_alloc
      FROM public.payroll_remittance_payment_allocations a
      JOIN public.payroll_remittance_payments p ON p.id = a.payment_id
      WHERE a.liability_id = NEW.id AND p.status = 'posted';
    IF NEW.paid_amount IS DISTINCT FROM v_alloc AND NOT NEW.is_legacy_paid THEN
      RAISE EXCEPTION 'payroll_liabilities.paid_amount can only be changed via posted remittance payment allocations (got %, allocated %)', NEW.paid_amount, v_alloc;
    END IF;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.enforce_payment_amount_split()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF public._is_teardown_for_org(NEW.organization_id) THEN RETURN NEW; END IF;
  IF NEW.status = 'voided' THEN
    NEW.outstanding_amount := 0; NEW.applied_amount := 0; RETURN NEW;
  END IF;
  NEW.outstanding_amount := COALESCE(NEW.outstanding_amount, 0);
  NEW.applied_amount     := COALESCE(NEW.applied_amount, 0);
  IF ABS((NEW.outstanding_amount + NEW.applied_amount) - NEW.amount) > 0.005 THEN
    RAISE EXCEPTION 'payments invariant violated: amount=% outstanding=% applied=% (sum=%)',
      NEW.amount, NEW.outstanding_amount, NEW.applied_amount,
      NEW.outstanding_amount + NEW.applied_amount USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_sales_order_lock()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF public._is_teardown_for_org(COALESCE(NEW.organization_id, OLD.organization_id)) THEN
    RETURN NEW;
  END IF;
  IF OLD.is_locked = true THEN
    IF NEW.subtotal <> OLD.subtotal OR NEW.tax_amount <> OLD.tax_amount
       OR NEW.discount_amount <> OLD.discount_amount
       OR NEW.shipping_amount <> OLD.shipping_amount
       OR NEW.total <> OLD.total
       OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
       OR NEW.currency <> OLD.currency THEN
      RAISE EXCEPTION 'Sales order % is locked (already invoiced). Cannot modify financial fields.', OLD.so_number;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_locked_attendance_edit()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF public._is_teardown_for_org(COALESCE(NEW.organization_id, OLD.organization_id)) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF current_setting('role', true) = 'service_role' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_locked THEN
      RAISE EXCEPTION 'Cannot delete attendance record locked by payroll run.';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.is_locked AND NOT (NEW.is_locked = OLD.is_locked) THEN
    RAISE EXCEPTION 'Cannot modify attendance record locked by payroll run.';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_pos_table_session_status_transition()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE v_rank_old int; v_rank_new int;
BEGIN
  IF public._is_teardown_for_org(COALESCE(NEW.organization_id, OLD.organization_id)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('open','ordered') THEN
      RAISE EXCEPTION 'Table session % may only start at open|ordered (got %)', NEW.id, NEW.status USING ERRCODE='check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  v_rank_old := CASE OLD.status WHEN 'open' THEN 1 WHEN 'ordered' THEN 2 WHEN 'served' THEN 3 WHEN 'paid' THEN 4 WHEN 'closed' THEN 5 END;
  v_rank_new := CASE NEW.status WHEN 'open' THEN 1 WHEN 'ordered' THEN 2 WHEN 'served' THEN 3 WHEN 'paid' THEN 4 WHEN 'closed' THEN 5 END;
  IF v_rank_new < v_rank_old THEN
    RAISE EXCEPTION 'Table session % illegal backward % → %', NEW.id, OLD.status, NEW.status USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_pos_kitchen_status_transition()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE v_rank_old int; v_rank_new int;
BEGIN
  IF public._is_teardown_for_org(COALESCE(NEW.organization_id, OLD.organization_id)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('new','sent') THEN
      RAISE EXCEPTION 'Kitchen ticket % may only start at new|sent (got %)', NEW.id, NEW.status USING ERRCODE='check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  v_rank_old := CASE OLD.status WHEN 'new' THEN 1 WHEN 'sent' THEN 2 WHEN 'cooking' THEN 3 WHEN 'ready' THEN 4 WHEN 'served' THEN 5 WHEN 'cancelled' THEN 99 END;
  v_rank_new := CASE NEW.status WHEN 'new' THEN 1 WHEN 'sent' THEN 2 WHEN 'cooking' THEN 3 WHEN 'ready' THEN 4 WHEN 'served' THEN 5 WHEN 'cancelled' THEN 99 END;
  IF NEW.status = 'cancelled' AND OLD.status = 'served' THEN
    RAISE EXCEPTION 'Kitchen ticket % cannot be cancelled after served', NEW.id USING ERRCODE='check_violation';
  END IF;
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'Kitchen ticket % is cancelled', NEW.id USING ERRCODE='check_violation';
  END IF;
  IF v_rank_new < v_rank_old THEN
    RAISE EXCEPTION 'Kitchen ticket % illegal backward % → %', NEW.id, OLD.status, NEW.status USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_pos_shift_cash_variance()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE v_diff numeric; v_has_override boolean;
BEGIN
  IF public._is_teardown_for_org(COALESCE(NEW.organization_id, OLD.organization_id)) THEN
    RETURN NEW;
  END IF;
  IF NEW.status <> 'closed' OR OLD.status = 'closed' THEN RETURN NEW; END IF;
  IF NEW.actual_cash IS NULL THEN
    RAISE EXCEPTION 'Cannot close shift %: cash count is required.', COALESCE(NEW.shift_number, NEW.id::text)
      USING ERRCODE = 'check_violation';
  END IF;
  v_diff := COALESCE(NEW.actual_cash, 0) - COALESCE(NEW.expected_cash, 0);
  NEW.cash_difference := v_diff;
  v_has_override := NEW.variance_override_pin_id IS NOT NULL OR NEW.variance_override_id IS NOT NULL;
  IF abs(v_diff) > COALESCE(NEW.cash_variance_tolerance, 0) AND NOT v_has_override THEN
    RAISE EXCEPTION 'Cash variance % exceeds tolerance % for shift %. Manager override required.',
      to_char(v_diff, 'FM999G999G990D00'),
      to_char(COALESCE(NEW.cash_variance_tolerance, 0), 'FM999G999G990D00'),
      COALESCE(NEW.shift_number, NEW.id::text) USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_pos_credit_invoice_lineage()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE v_txn_id uuid; v_txn_biz uuid; v_txn_branch uuid;
BEGIN
  IF public._is_teardown_for_org(NEW.organization_id) THEN RETURN NEW; END IF;
  IF NEW.source IS DISTINCT FROM 'pos_credit' THEN RETURN NEW; END IF;
  v_txn_id := COALESCE(NEW.source_pos_transaction_id, NEW.source_recurring_id);
  IF v_txn_id IS NULL THEN RETURN NEW; END IF;
  SELECT business_id, branch_id INTO v_txn_biz, v_txn_branch
    FROM public.pos_transactions WHERE id = v_txn_id;
  IF v_txn_biz IS NULL THEN RETURN NEW; END IF;
  IF NEW.business_id <> v_txn_biz THEN
    RAISE EXCEPTION 'POS-credit invoice business_id (%) must match originating POS transaction (%)',
      NEW.business_id, v_txn_biz USING ERRCODE='23514';
  END IF;
  IF v_txn_branch IS NOT NULL AND (NEW.branch_id IS DISTINCT FROM v_txn_branch) THEN
    NEW.branch_id := v_txn_branch;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.enforce_lock_date_perm()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE any_business_id uuid;
BEGIN
  IF public._is_teardown_for_org(NEW.id) THEN RETURN NEW; END IF;
  IF NEW.fiscalyear_lock_date IS NOT DISTINCT FROM OLD.fiscalyear_lock_date
     AND NEW.period_lock_date IS NOT DISTINCT FROM OLD.period_lock_date
     AND NEW.tax_lock_date     IS NOT DISTINCT FROM OLD.tax_lock_date THEN
    RETURN NEW;
  END IF;
  SELECT id INTO any_business_id FROM public.businesses WHERE organization_id = NEW.id LIMIT 1;
  IF NOT public.has_finance_permission(auth.uid(), 'finance.manage_periods', any_business_id) THEN
    RAISE EXCEPTION 'Permission denied: finance.manage_periods is required to change lock dates.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_business_currency_immutable()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE v_je_count int;
BEGIN
  IF public._is_teardown_for_org(NEW.organization_id) THEN RETURN NEW; END IF;
  IF NEW.base_currency IS NOT DISTINCT FROM OLD.base_currency THEN RETURN NEW; END IF;
  SELECT COUNT(*) INTO v_je_count FROM public.journal_entries WHERE business_id = NEW.id LIMIT 1;
  IF v_je_count > 0 THEN
    RAISE EXCEPTION 'business.base_currency is immutable once journal entries exist (business_id=%, je_count=%)',
      NEW.id, v_je_count USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_business_has_active_branch()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE remaining_active INTEGER; biz_active BOOLEAN; v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.businesses
    WHERE id = COALESCE(NEW.business_id, OLD.business_id);
  IF v_org IS NOT NULL AND public._is_teardown_for_org(v_org) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF (TG_OP = 'DELETE') THEN
    SELECT is_active INTO biz_active FROM public.businesses WHERE id = OLD.business_id;
    IF biz_active IS NOT TRUE THEN RETURN OLD; END IF;
    SELECT COUNT(*) INTO remaining_active FROM public.branches
      WHERE business_id = OLD.business_id AND is_active = true AND id <> OLD.id;
    IF remaining_active = 0 THEN
      RAISE EXCEPTION 'Cannot remove the last active branch of an active company (business_id=%).', OLD.business_id USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (TG_OP = 'UPDATE') AND OLD.is_active = true AND NEW.is_active = false THEN
    SELECT is_active INTO biz_active FROM public.businesses WHERE id = NEW.business_id;
    IF biz_active IS NOT TRUE THEN RETURN NEW; END IF;
    SELECT COUNT(*) INTO remaining_active FROM public.branches
      WHERE business_id = NEW.business_id AND is_active = true AND id <> NEW.id;
    IF remaining_active = 0 THEN
      RAISE EXCEPTION 'Cannot deactivate the last active branch of an active company (business_id=%).', NEW.business_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_active_bank_account_has_gl()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF public._is_teardown_for_org(NEW.organization_id) THEN RETURN NEW; END IF;
  IF NEW.is_active = true AND NEW.account_id IS NULL THEN
    RAISE EXCEPTION 'Active bank account "%" must be linked to a Chart-of-Accounts entry (account_id).',
      COALESCE(NEW.name, NEW.id::text) USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_core_app_active_tg()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE v_is_core BOOLEAN; v_app_id TEXT; v_org uuid;
BEGIN
  v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  IF public._is_teardown_for_org(v_org) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN v_app_id := OLD.app_id; ELSE v_app_id := NEW.app_id; END IF;
  SELECT is_core INTO v_is_core FROM public.platform_apps WHERE id = v_app_id;
  IF v_is_core IS NOT TRUE THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CORE_APP_PROTECTED: cannot delete core app % from organization %', OLD.app_id, OLD.organization_id USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.is_active = false AND OLD.is_active = true THEN
    RAISE EXCEPTION 'CORE_APP_PROTECTED: cannot deactivate core app % for organization %', NEW.app_id, NEW.organization_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_last_business_removal()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE remaining_count integer; v_org_id uuid; v_org_exists boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN v_org_id := OLD.organization_id;
  ELSIF TG_OP = 'UPDATE' THEN
    IF (COALESCE(OLD.is_active, true) = true)
       AND (COALESCE(NEW.is_active, true) = false
            OR (NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL)) THEN
      v_org_id := OLD.organization_id;
    ELSE RETURN NEW; END IF;
  END IF;
  IF public._is_teardown_for_org(v_org_id) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.organizations WHERE id = v_org_id) INTO v_org_exists;
  IF NOT v_org_exists THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  SELECT COUNT(*) INTO remaining_count FROM public.businesses
    WHERE organization_id = v_org_id AND id <> COALESCE(OLD.id, NEW.id)
      AND COALESCE(is_active, true) = true AND archived_at IS NULL;
  IF remaining_count = 0 THEN
    RAISE EXCEPTION 'A workspace must always have at least one active company. Create another company before removing this one.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$;