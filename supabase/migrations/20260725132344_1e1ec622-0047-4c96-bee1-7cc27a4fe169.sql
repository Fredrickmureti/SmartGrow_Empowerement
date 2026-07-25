-- ============================================================
-- Loan subsystem repair — Phase 1/2/4/5 (server side)
-- ============================================================

-- ---------- Phase 2: remove ambiguous / legacy overloads ----------
DROP FUNCTION IF EXISTS public.generate_loan_schedule(uuid);
DROP FUNCTION IF EXISTS public.approve_employee_loan(uuid, text, text);
DROP FUNCTION IF EXISTS public.approve_employee_loan(uuid);

-- ---------- Shared helper: resolve the owning business ----------
CREATE OR REPLACE FUNCTION public._loan_resolve_business(_org uuid, _supplied uuid, _employee_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_biz uuid; v_count int;
BEGIN
  IF _supplied IS NOT NULL THEN RETURN _supplied; END IF;

  SELECT business_id INTO v_biz FROM public.employees WHERE id = _employee_id;
  IF v_biz IS NOT NULL THEN RETURN v_biz; END IF;

  SELECT count(*), min(id) INTO v_count, v_biz
    FROM public.businesses WHERE organization_id = _org;
  IF v_count = 1 THEN RETURN v_biz; END IF;

  RAISE EXCEPTION 'Cannot determine which business this loan belongs to. Select a workspace before submitting the request.'
    USING ERRCODE = '22023', HINT = 'LOAN_CONTEXT_BUSINESS';
END $$;

-- ---------- Phase 1: valid request contract ----------
CREATE OR REPLACE FUNCTION public.request_employee_loan(_input jsonb)
RETURNS employee_loans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor            uuid := auth.uid();
  v_org              uuid := NULLIF(_input->>'organization_id','')::uuid;
  v_biz              uuid := NULLIF(_input->>'business_id','')::uuid;
  v_employee_id      uuid := NULLIF(_input->>'employee_id','')::uuid;
  v_loan_type_id     uuid := NULLIF(_input->>'loan_type_id','')::uuid;
  v_principal        numeric := (_input->>'principal_amount')::numeric;
  v_installments     integer := COALESCE(NULLIF(_input->>'total_installments','')::integer, 0);
  v_start_date       date    := COALESCE(NULLIF(_input->>'start_date','')::date, CURRENT_DATE);
  v_method           text    := NULLIF(_input->>'repayment_method','');
  v_percent          numeric := NULLIF(_input->>'repayment_percent','')::numeric;
  v_floor            numeric := NULLIF(_input->>'min_net_pay_floor','')::numeric;
  v_cap              numeric := NULLIF(_input->>'max_pct_of_net','')::numeric;
  v_reason           text    := NULLIF(_input->>'reason','');
  v_idem             text    := NULLIF(_input->>'idempotency_key','');
  v_collateral_desc  text    := NULLIF(_input->>'collateral_description','');
  v_consent_ack      boolean := COALESCE((_input->>'consent_acknowledged')::boolean, false);

  v_lt               public.loan_types%ROWTYPE;
  v_existing         public.employee_loans%ROWTYPE;
  v_loan             public.employee_loans%ROWTYPE;
  v_loan_number      text;
  v_monthly          numeric;
  v_total            numeric;
  v_legacy_kind      text;
  v_needs_approval   boolean;
  v_wf_id            uuid;
  v_req_id           uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to request a loan.'
      USING ERRCODE='28000', HINT='LOAN_CONTEXT_AUTH';
  END IF;
  IF v_org IS NULL OR v_employee_id IS NULL OR v_loan_type_id IS NULL
     OR v_principal IS NULL OR v_principal <= 0 THEN
    RAISE EXCEPTION 'A loan product, an employee and an amount greater than zero are required.'
      USING ERRCODE='22023', HINT='LOAN_CONTEXT_INPUT';
  END IF;

  -- Idempotency short-circuit
  IF v_idem IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.employee_loans
      WHERE organization_id = v_org AND idempotency_key = v_idem
      LIMIT 1;
    IF FOUND THEN RETURN v_existing; END IF;
  END IF;

  -- Owning business is resolved server-side (column is NOT NULL)
  v_biz := public._loan_resolve_business(v_org, v_biz, v_employee_id);

  SELECT * INTO v_lt
    FROM public.loan_types
    WHERE id = v_loan_type_id AND organization_id = v_org
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That loan product is not available in this organisation.'
      USING ERRCODE='22023', HINT='LOAN_POLICY_TYPE';
  END IF;
  IF NOT v_lt.is_active THEN
    RAISE EXCEPTION 'The loan product "%" is no longer available for new requests.', v_lt.name
      USING ERRCODE='22023', HINT='LOAN_POLICY_TYPE_INACTIVE';
  END IF;

  v_method := COALESCE(v_method, v_lt.default_repayment_method);
  IF v_method NOT IN ('fixed_installment','fixed_amount','percent_of_net','one_off_next_payroll') THEN
    RAISE EXCEPTION 'Unsupported repayment method "%".', v_method
      USING ERRCODE='22023', HINT='LOAN_POLICY_METHOD';
  END IF;

  IF v_method = 'one_off_next_payroll' THEN
    v_installments := 1;
  ELSE
    IF v_installments IS NULL OR v_installments < 1 THEN
      v_installments := COALESCE(v_lt.default_installments, 12);
    END IF;
    IF v_lt.min_installments IS NOT NULL AND v_installments < v_lt.min_installments THEN
      RAISE EXCEPTION '% requires at least % instalments (you requested %).',
        v_lt.name, v_lt.min_installments, v_installments
        USING ERRCODE='22023', HINT='LOAN_POLICY_INSTALLMENTS_MIN';
    END IF;
    IF v_lt.max_installments IS NOT NULL AND v_installments > v_lt.max_installments THEN
      RAISE EXCEPTION '% allows at most % instalments (you requested %).',
        v_lt.name, v_lt.max_installments, v_installments
        USING ERRCODE='22023', HINT='LOAN_POLICY_INSTALLMENTS_MAX';
    END IF;
  END IF;

  IF v_lt.min_principal IS NOT NULL AND v_principal < v_lt.min_principal THEN
    RAISE EXCEPTION 'The minimum amount for % is %.', v_lt.name, v_lt.min_principal
      USING ERRCODE='22023', HINT='LOAN_POLICY_PRINCIPAL_MIN';
  END IF;
  IF v_lt.max_principal IS NOT NULL AND v_principal > v_lt.max_principal THEN
    RAISE EXCEPTION 'The maximum amount for % is %.', v_lt.name, v_lt.max_principal
      USING ERRCODE='22023', HINT='LOAN_POLICY_PRINCIPAL_MAX';
  END IF;

  IF v_lt.min_tenure_months IS NOT NULL AND v_installments < v_lt.min_tenure_months THEN
    RAISE EXCEPTION '% requires a tenure of at least % months.', v_lt.name, v_lt.min_tenure_months
      USING ERRCODE='22023', HINT='LOAN_POLICY_TENURE_MIN';
  END IF;
  IF v_lt.max_tenure_months IS NOT NULL AND v_installments > v_lt.max_tenure_months THEN
    RAISE EXCEPTION '% allows a tenure of at most % months.', v_lt.name, v_lt.max_tenure_months
      USING ERRCODE='22023', HINT='LOAN_POLICY_TENURE_MAX';
  END IF;

  v_cap := COALESCE(v_cap, v_lt.default_max_pct_of_net);
  v_floor := COALESCE(v_floor, v_lt.default_min_net_pay_floor);
  IF v_cap IS NOT NULL AND (v_cap < 0 OR v_cap > 100) THEN
    RAISE EXCEPTION 'The net-pay cap must be between 0 and 100 percent (got %).', v_cap
      USING ERRCODE='22023', HINT='LOAN_POLICY_CAP';
  END IF;
  IF v_floor IS NOT NULL AND v_floor < 0 THEN
    RAISE EXCEPTION 'The minimum take-home floor cannot be negative (got %).', v_floor
      USING ERRCODE='22023', HINT='LOAN_POLICY_FLOOR';
  END IF;

  IF v_method = 'percent_of_net' AND (v_percent IS NULL OR v_percent <= 0 OR v_percent > 100) THEN
    RAISE EXCEPTION 'Percentage-of-net repayment needs a recovery percentage between 0 and 100.'
      USING ERRCODE='22023', HINT='LOAN_POLICY_PERCENT';
  END IF;

  IF v_lt.requires_consent AND NOT v_consent_ack THEN
    RAISE EXCEPTION '% requires you to accept the payroll deduction consent before submitting.', v_lt.name
      USING ERRCODE='22023', HINT='LOAN_POLICY_CONSENT';
  END IF;
  IF v_lt.requires_collateral AND (v_collateral_desc IS NULL OR length(trim(v_collateral_desc)) = 0) THEN
    RAISE EXCEPTION '% requires a description of the collateral offered.', v_lt.name
      USING ERRCODE='22023', HINT='LOAN_POLICY_COLLATERAL';
  END IF;

  -- Derived amounts. `monthly_deduction` is CHECK (> 0) and must never be a
  -- sentinel: for percent-of-net it carries the indicative instalment while
  -- payroll recomputes the real figure each period from `repayment_percent`.
  v_total := v_principal;
  v_monthly := CASE
    WHEN v_method = 'one_off_next_payroll' THEN v_total
    ELSE ROUND(v_total / GREATEST(v_installments,1), 2)
  END;
  IF v_monthly IS NULL OR v_monthly <= 0 THEN v_monthly := v_total; END IF;

  v_legacy_kind := CASE WHEN v_method = 'one_off_next_payroll' THEN 'advance' ELSE 'loan' END;

  BEGIN
    SELECT public.get_next_loan_number(v_org) INTO v_loan_number;
  EXCEPTION WHEN undefined_function THEN
    v_loan_number := 'LR-' || to_char(now(),'YYYYMMDDHH24MISS');
  END;

  v_needs_approval := v_lt.requires_approval;

  INSERT INTO public.employee_loans (
    organization_id, business_id, employee_id, loan_number,
    loan_type, loan_type_id, description,
    principal_amount, interest_rate, total_amount, amount_repaid,
    outstanding_balance, monthly_deduction,
    total_installments, installments_paid,
    start_date, end_date, status,
    repayment_method, repayment_percent, min_net_pay_floor, max_pct_of_net,
    requested_by, requested_at, created_by, notes, idempotency_key
  ) VALUES (
    v_org, v_biz, v_employee_id, v_loan_number,
    v_legacy_kind, v_lt.id, v_reason,
    v_principal, 0, v_total, 0,
    v_total, v_monthly,
    v_installments, 0,
    v_start_date, NULL,
    CASE WHEN v_needs_approval THEN 'requested' ELSE 'approved' END,
    v_method, v_percent, v_floor, v_cap,
    v_actor, now(), v_actor, v_reason, v_idem
  ) RETURNING * INTO v_loan;

  PERFORM public._loan_lifecycle_emit(
    v_loan.id, 'loan.requested', v_actor,
    jsonb_build_object(
      'loan_type_id', v_lt.id, 'loan_type_code', v_lt.code,
      'principal', v_principal, 'installments', v_installments,
      'method', v_method, 'requires_approval', v_needs_approval,
      'requires_dual_approval', v_lt.requires_dual_approval
    )
  );

  IF v_needs_approval THEN
    SELECT id INTO v_wf_id
      FROM public.approval_workflows
      WHERE organization_id = v_org
        AND entity_type = 'employee_loan'
        AND COALESCE(is_active, true)
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1;

    INSERT INTO public.approval_requests (
      organization_id, business_id, workflow_id,
      entity_type, entity_id, entity_reference,
      current_step, status, requested_by, requested_at, notes
    ) VALUES (
      v_org, v_biz, v_wf_id,
      'employee_loan', v_loan.id, v_loan.loan_number,
      1, 'pending', v_actor, now(), v_reason
    ) RETURNING id INTO v_req_id;

    PERFORM public._loan_lifecycle_emit(
      v_loan.id, 'loan.approval_requested', v_actor,
      jsonb_build_object('approval_request_id', v_req_id, 'workflow_id', v_wf_id,
                         'dual_approval', v_lt.requires_dual_approval)
    );
  END IF;

  RETURN v_loan;
END $$;

-- ---------- Phase 2: the genuinely missing suspend action ----------
CREATE OR REPLACE FUNCTION public.employee_loan_suspend(_loan_id uuid, _reason text DEFAULT NULL)
RETURNS employee_loans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE r public.employee_loans; prior text;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  IF r.id IS NULL THEN
    RAISE EXCEPTION 'Loan not found.' USING ERRCODE='22023', HINT='LOAN_CONTEXT_NOT_FOUND';
  END IF;
  prior := r.status;
  IF prior NOT IN ('active','in_arrears','paused','approved','awaiting_disbursement') THEN
    RAISE EXCEPTION 'A loan in status "%" cannot be suspended.', prior
      USING ERRCODE='22023', HINT='LOAN_STATE_SUSPEND';
  END IF;
  PERFORM public.governance_assert_not_self('employee_loan.restructure','employee_loan',_loan_id, r.created_by);
  UPDATE public.employee_loans
     SET status='suspended', updated_at=now()
   WHERE id=_loan_id RETURNING * INTO r;
  PERFORM public.loan_log_event(_loan_id,'suspend',prior,'suspended',NULL,_reason);
  RETURN r;
END $$;

-- ---------- Phase 4: close the approval request on decision ----------
CREATE OR REPLACE FUNCTION public._loan_close_approval_request(_loan_id uuid, _action text, _notes text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_req uuid; v_step int;
BEGIN
  SELECT id, COALESCE(current_step,1) INTO v_req, v_step
    FROM public.approval_requests
   WHERE entity_type='employee_loan' AND entity_id=_loan_id AND COALESCE(status,'pending')='pending'
   ORDER BY requested_at DESC NULLS LAST
   LIMIT 1;
  IF v_req IS NULL THEN RETURN; END IF;

  UPDATE public.approval_requests
     SET status = CASE WHEN _action='approve' THEN 'approved' ELSE 'rejected' END,
         completed_at = now()
   WHERE id = v_req;

  INSERT INTO public.approval_history (request_id, step_number, action, approved_by, approved_at, comments)
  VALUES (v_req, v_step, _action, auth.uid(), now(), _notes);
END $$;

CREATE OR REPLACE FUNCTION public.employee_loan_lifecycle_approve(_loan_id uuid)
RETURNS employee_loans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE r public.employee_loans; prior text;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  IF r.id IS NULL THEN
    RAISE EXCEPTION 'Loan not found.' USING ERRCODE='22023', HINT='LOAN_CONTEXT_NOT_FOUND';
  END IF;
  prior := r.status;
  IF prior NOT IN ('pending_approval','requested','draft') THEN
    RAISE EXCEPTION 'A loan in status "%" cannot be approved.', prior
      USING ERRCODE='22023', HINT='LOAN_STATE_APPROVE';
  END IF;
  PERFORM public.governance_assert_not_self('loan.approve','employee_loan',_loan_id, r.created_by);
  PERFORM public.governance_assert_not_subject('loan.approve_self_benefit','employee_loan',_loan_id);
  UPDATE public.employee_loans SET status='approved', approved_by=auth.uid(), approved_at=now(), updated_at=now()
    WHERE id=_loan_id RETURNING * INTO r;
  PERFORM public._loan_close_approval_request(_loan_id, 'approve', NULL);
  PERFORM public.loan_log_event(_loan_id,'approve',prior,'approved');
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.employee_loan_lifecycle_reject(_loan_id uuid, _reason text)
RETURNS employee_loans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE r public.employee_loans; prior text;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  IF r.id IS NULL THEN
    RAISE EXCEPTION 'Loan not found.' USING ERRCODE='22023', HINT='LOAN_CONTEXT_NOT_FOUND';
  END IF;
  prior := r.status;
  IF prior NOT IN ('pending_approval','requested','draft') THEN
    RAISE EXCEPTION 'A loan in status "%" cannot be rejected.', prior
      USING ERRCODE='22023', HINT='LOAN_STATE_REJECT';
  END IF;
  PERFORM public.governance_assert_not_self('loan.approve','employee_loan',_loan_id, r.created_by);
  UPDATE public.employee_loans
     SET status='rejected', rejected_by=auth.uid(), rejected_at=now(),
         rejection_reason=_reason, updated_at=now()
   WHERE id=_loan_id RETURNING * INTO r;
  PERFORM public._loan_close_approval_request(_loan_id, 'reject', _reason);
  PERFORM public.loan_log_event(_loan_id,'reject',prior,'rejected',NULL,_reason);
  RETURN r;
END $$;

-- ---------- Phase 5: schedule is generated by the lifecycle, not by hand ----------
CREATE OR REPLACE FUNCTION public.tg_employee_loan_autogenerate_schedule()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status IN ('approved','active','awaiting_disbursement')
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status)
     AND NEW.repayment_method <> 'percent_of_net'
     AND NOT EXISTS (SELECT 1 FROM public.loan_repayment_schedule WHERE loan_id = NEW.id)
  THEN
    PERFORM public.generate_loan_schedule(NEW.id, false);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_employee_loan_autogenerate_schedule ON public.employee_loans;
CREATE TRIGGER trg_employee_loan_autogenerate_schedule
AFTER INSERT OR UPDATE OF status ON public.employee_loans
FOR EACH ROW EXECUTE FUNCTION public.tg_employee_loan_autogenerate_schedule();