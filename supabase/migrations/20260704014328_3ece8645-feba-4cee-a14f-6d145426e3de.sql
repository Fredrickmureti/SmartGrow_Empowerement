-- Phase B — Loan Types policy engine: canonical request + approval RPCs.

-- ─────────────────────────────────────────────────────────────
-- Helper: safe insert into loan_lifecycle_events (table shape varies
-- across environments; never fail the parent operation).
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._loan_lifecycle_emit(
  _loan_id uuid,
  _event text,
  _actor uuid,
  _payload jsonb
) RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  BEGIN
    INSERT INTO public.loan_lifecycle_events (loan_id, event, actor_user_id, payload)
    VALUES (_loan_id, _event, _actor, COALESCE(_payload, '{}'::jsonb));
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    NULL;
  END;
END $$;

-- ─────────────────────────────────────────────────────────────
-- request_employee_loan — canonical entry point for opening a loan.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.request_employee_loan(_input jsonb)
RETURNS public.employee_loans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated' USING ERRCODE='28000'; END IF;
  IF v_org IS NULL OR v_employee_id IS NULL OR v_loan_type_id IS NULL
     OR v_principal IS NULL OR v_principal <= 0 THEN
    RAISE EXCEPTION 'organization_id, employee_id, loan_type_id, principal_amount > 0 are required'
      USING ERRCODE='22023';
  END IF;

  -- Idempotency short-circuit
  IF v_idem IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.employee_loans
      WHERE organization_id = v_org AND idempotency_key = v_idem
      LIMIT 1;
    IF FOUND THEN RETURN v_existing; END IF;
  END IF;

  -- Load and lock the loan type row (org scope + active)
  SELECT * INTO v_lt
    FROM public.loan_types
    WHERE id = v_loan_type_id
      AND organization_id = v_org
    FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'loan type not found for this organization' USING ERRCODE='22023'; END IF;
  IF NOT v_lt.is_active THEN RAISE EXCEPTION 'loan type % is inactive', v_lt.code USING ERRCODE='22023'; END IF;

  -- Method: default from type, then validate
  v_method := COALESCE(v_method, v_lt.default_repayment_method);
  IF v_method NOT IN ('fixed_installment','fixed_amount','percent_of_net','one_off_next_payroll') THEN
    RAISE EXCEPTION 'invalid repayment_method: %', v_method USING ERRCODE='22023';
  END IF;

  -- Installments: one-off collapses to 1; else default/validate against type bounds
  IF v_method = 'one_off_next_payroll' THEN
    v_installments := 1;
  ELSE
    IF v_installments IS NULL OR v_installments < 1 THEN
      v_installments := COALESCE(v_lt.default_installments, 12);
    END IF;
    IF v_lt.min_installments IS NOT NULL AND v_installments < v_lt.min_installments THEN
      RAISE EXCEPTION 'installments % below policy minimum %', v_installments, v_lt.min_installments USING ERRCODE='22023';
    END IF;
    IF v_lt.max_installments IS NOT NULL AND v_installments > v_lt.max_installments THEN
      RAISE EXCEPTION 'installments % above policy maximum %', v_installments, v_lt.max_installments USING ERRCODE='22023';
    END IF;
  END IF;

  -- Principal bounds
  IF v_lt.min_principal IS NOT NULL AND v_principal < v_lt.min_principal THEN
    RAISE EXCEPTION 'principal % below policy minimum %', v_principal, v_lt.min_principal USING ERRCODE='22023';
  END IF;
  IF v_lt.max_principal IS NOT NULL AND v_principal > v_lt.max_principal THEN
    RAISE EXCEPTION 'principal % above policy maximum %', v_principal, v_lt.max_principal USING ERRCODE='22023';
  END IF;

  -- Tenure bounds (installments proxy months for monthly-paid schedules)
  IF v_lt.min_tenure_months IS NOT NULL AND v_installments < v_lt.min_tenure_months THEN
    RAISE EXCEPTION 'tenure % months below policy minimum %', v_installments, v_lt.min_tenure_months USING ERRCODE='22023';
  END IF;
  IF v_lt.max_tenure_months IS NOT NULL AND v_installments > v_lt.max_tenure_months THEN
    RAISE EXCEPTION 'tenure % months above policy maximum %', v_installments, v_lt.max_tenure_months USING ERRCODE='22023';
  END IF;

  -- Cap and floor: default from type; cap must remain 0..100
  v_cap := COALESCE(v_cap, v_lt.default_max_pct_of_net);
  v_floor := COALESCE(v_floor, v_lt.default_min_net_pay_floor);
  IF v_cap IS NOT NULL AND (v_cap < 0 OR v_cap > 100) THEN
    RAISE EXCEPTION 'max_pct_of_net must be between 0 and 100 (got %)', v_cap USING ERRCODE='22023';
  END IF;
  IF v_floor IS NOT NULL AND v_floor < 0 THEN
    RAISE EXCEPTION 'min_net_pay_floor must be >= 0 (got %)', v_floor USING ERRCODE='22023';
  END IF;

  -- Percent method needs an explicit percent value
  IF v_method = 'percent_of_net' AND (v_percent IS NULL OR v_percent <= 0 OR v_percent > 100) THEN
    RAISE EXCEPTION 'repayment_percent (0 < x <= 100) required for percent_of_net method' USING ERRCODE='22023';
  END IF;

  -- Consent / collateral proof when the type demands it
  IF v_lt.requires_consent AND NOT v_consent_ack THEN
    RAISE EXCEPTION 'this loan type requires the borrower to acknowledge consent' USING ERRCODE='22023';
  END IF;
  IF v_lt.requires_collateral AND (v_collateral_desc IS NULL OR length(trim(v_collateral_desc)) = 0) THEN
    RAISE EXCEPTION 'this loan type requires a collateral_description' USING ERRCODE='22023';
  END IF;

  -- Derived amounts
  v_total := v_principal;
  v_monthly := CASE
    WHEN v_method = 'one_off_next_payroll' THEN v_total
    WHEN v_method = 'percent_of_net' THEN 0  -- computed per period by payroll
    ELSE ROUND(v_total / GREATEST(v_installments,1), 2)
  END;
  v_legacy_kind := CASE WHEN v_method = 'one_off_next_payroll' THEN 'advance' ELSE 'loan' END;

  -- Loan number
  BEGIN
    SELECT public.get_next_loan_number(v_org) INTO v_loan_number;
  EXCEPTION WHEN undefined_function THEN
    v_loan_number := 'LR-' || to_char(now(),'YYYYMMDDHH24MISS');
  END;

  v_needs_approval := v_lt.requires_approval;

  -- Insert loan (triggers still validate row shape)
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

  -- Emit lifecycle event
  PERFORM public._loan_lifecycle_emit(
    v_loan.id,
    'loan.requested',
    v_actor,
    jsonb_build_object(
      'loan_type_id', v_lt.id, 'loan_type_code', v_lt.code,
      'principal', v_principal, 'installments', v_installments,
      'method', v_method, 'requires_approval', v_needs_approval,
      'requires_dual_approval', v_lt.requires_dual_approval
    )
  );

  -- Open approval workflow if the policy requires it
  IF v_needs_approval THEN
    -- Pick an active workflow for entity_type='employee_loan' in this org, if any.
    -- Falls back to a policy-defined ad-hoc single/dual-step request (workflow_id NULL).
    BEGIN
      SELECT id INTO v_wf_id
        FROM public.approval_workflows
        WHERE organization_id = v_org
          AND entity_type = 'employee_loan'
          AND COALESCE(is_active, true)
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1;
    EXCEPTION WHEN undefined_table OR undefined_column THEN
      v_wf_id := NULL;
    END;

    BEGIN
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
    EXCEPTION WHEN undefined_table OR undefined_column THEN
      -- approvals infrastructure absent → keep loan in 'requested', HR handles manually.
      NULL;
    END;
  END IF;

  RETURN v_loan;
END $$;

REVOKE ALL ON FUNCTION public.request_employee_loan(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_employee_loan(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_employee_loan(jsonb) TO service_role;

-- ─────────────────────────────────────────────────────────────
-- approve_employee_loan — advance / reject the workflow.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.approve_employee_loan(
  _loan_id  uuid,
  _decision text,             -- 'approve' | 'reject'
  _notes    text DEFAULT NULL
) RETURNS public.employee_loans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_loan     public.employee_loans%ROWTYPE;
  v_lt       public.loan_types%ROWTYPE;
  v_req      public.approval_requests%ROWTYPE;
  v_step_ct  int := 0;
  v_final    boolean := true;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated' USING ERRCODE='28000'; END IF;
  IF _decision NOT IN ('approve','reject') THEN
    RAISE EXCEPTION 'decision must be approve|reject' USING ERRCODE='22023';
  END IF;

  SELECT * INTO v_loan FROM public.employee_loans WHERE id = _loan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'loan not found' USING ERRCODE='22023'; END IF;
  IF v_loan.status NOT IN ('requested','pending') THEN
    RAISE EXCEPTION 'loan is not awaiting approval (status=%)', v_loan.status USING ERRCODE='22023';
  END IF;

  SELECT * INTO v_lt FROM public.loan_types WHERE id = v_loan.loan_type_id;

  -- Advance the workflow row if one exists
  BEGIN
    SELECT * INTO v_req
      FROM public.approval_requests
      WHERE entity_type = 'employee_loan' AND entity_id = v_loan.id
        AND status = 'pending'
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE;

    IF FOUND THEN
      IF _decision = 'reject' THEN
        UPDATE public.approval_requests
          SET status='rejected', completed_at=now(), notes=COALESCE(_notes, notes)
          WHERE id = v_req.id;
      ELSE
        -- Dual-approval policy: require 2 steps total. Single-approval: 1.
        v_step_ct := CASE WHEN COALESCE(v_lt.requires_dual_approval,false) THEN 2 ELSE 1 END;
        v_final := (COALESCE(v_req.current_step,1) >= v_step_ct);
        IF v_final THEN
          UPDATE public.approval_requests
            SET status='approved', completed_at=now(), notes=COALESCE(_notes, notes)
            WHERE id = v_req.id;
        ELSE
          UPDATE public.approval_requests
            SET current_step = COALESCE(current_step,1) + 1,
                notes = COALESCE(_notes, notes)
            WHERE id = v_req.id;
        END IF;
      END IF;
    ELSE
      v_final := true;  -- no workflow row → treat as terminal decision
    END IF;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_final := true;
  END;

  -- Update the loan
  IF _decision = 'reject' THEN
    UPDATE public.employee_loans
      SET status='rejected', rejected_by=v_actor, rejected_at=now(),
          rejection_reason=COALESCE(_notes, rejection_reason)
      WHERE id = v_loan.id
      RETURNING * INTO v_loan;
    PERFORM public._loan_lifecycle_emit(v_loan.id,'loan.rejected',v_actor,
      jsonb_build_object('reason', _notes));
  ELSIF v_final THEN
    UPDATE public.employee_loans
      SET status='approved', approved_by=v_actor, approved_at=now(),
          notes = COALESCE(_notes, notes)
      WHERE id = v_loan.id
      RETURNING * INTO v_loan;
    PERFORM public._loan_lifecycle_emit(v_loan.id,'loan.approved',v_actor,
      jsonb_build_object('notes', _notes));
  ELSE
    -- Intermediate approval step — no loan status change yet
    PERFORM public._loan_lifecycle_emit(v_loan.id,'loan.approval_step',v_actor,
      jsonb_build_object('step', v_req.current_step, 'total', v_step_ct));
  END IF;

  RETURN v_loan;
END $$;

REVOKE ALL ON FUNCTION public.approve_employee_loan(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_employee_loan(uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_employee_loan(uuid,text,text) TO service_role;
