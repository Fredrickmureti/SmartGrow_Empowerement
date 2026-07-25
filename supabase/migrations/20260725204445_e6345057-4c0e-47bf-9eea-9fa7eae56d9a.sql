-- =========================================================================
-- Phase L2 — Governance: Solo mode overrides stale explicit block policies
-- =========================================================================
CREATE OR REPLACE FUNCTION public.governance_assert_not_self(
  p_actor uuid, p_subject uuid, p_action text,
  p_org uuid DEFAULT NULL, p_entity_type text DEFAULT NULL, p_entity_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_mode          text;
  v_override      public.self_action_overrides;
  v_actor_role    public.app_role;
  v_org_mode      text;
  v_member_count  int;
  v_policy_exists boolean;
  v_solo_auto     boolean := false;
BEGIN
  IF p_actor IS NULL OR p_subject IS NULL THEN RETURN; END IF;
  IF p_actor <> p_subject THEN RETURN; END IF;

  IF p_org IS NOT NULL AND public._is_teardown_for_org(p_org) THEN
    RETURN;
  END IF;

  IF p_org IS NOT NULL THEN
    SELECT ur.role INTO v_actor_role
      FROM public.user_roles ur
     WHERE ur.user_id = p_actor
       AND ur.organization_id = p_org
       AND ur.is_active = true
     ORDER BY CASE ur.role
       WHEN 'super_admin' THEN 0
       WHEN 'owner'       THEN 1
       WHEN 'admin'       THEN 2
       ELSE 9
     END
     LIMIT 1;

    -- Solo-mode fast path: single-member orgs always auto-allow, even when a
    -- stale explicit self_action_policy row says otherwise. Prior behaviour
    -- let leftover "block" rows freeze one-person orgs out of their own
    -- lifecycle actions (authorize disbursement, write-off, restructure...).
    SELECT governance_mode INTO v_org_mode FROM public.organizations WHERE id = p_org;
    v_org_mode := COALESCE(v_org_mode, 'standard');

    IF v_org_mode = 'solo' THEN
      SELECT count(DISTINCT user_id) INTO v_member_count
        FROM public.user_roles
       WHERE organization_id = p_org AND is_active = true;
      IF v_member_count <= 1 THEN
        INSERT INTO public.audit_logs(organization_id, user_id, action, entity_type, entity_id, new_values)
        VALUES (p_org, p_actor, 'sod.self_action_auto_allowed',
                COALESCE(p_entity_type,'unknown'), p_entity_id,
                jsonb_build_object('action_key', p_action,
                                   'reason', 'solo_override_stale_policy',
                                   'governance_mode', v_org_mode));
        RETURN;
      END IF;
    END IF;

    -- Non-solo (or solo w/ multiple members): explicit policy wins if present.
    SELECT mode INTO v_mode
      FROM public.self_action_policy
     WHERE organization_id = p_org
       AND action_key = p_action
       AND (applies_to_role = v_actor_role OR applies_to_role IS NULL)
     ORDER BY (applies_to_role IS NULL) ASC
     LIMIT 1;

    v_policy_exists := v_mode IS NOT NULL;

    IF v_mode IS NULL THEN
      IF v_org_mode = 'standard' THEN
        IF v_actor_role IN ('owner','super_admin','admin') THEN
          v_mode := 'warn';
        ELSE
          v_mode := 'block';
        END IF;
      ELSE  -- strict
        v_mode := 'block';
      END IF;
    END IF;
  END IF;

  v_mode := COALESCE(v_mode, 'block');

  IF v_mode = 'allow' THEN RETURN; END IF;

  IF v_mode = 'warn' THEN
    IF p_org IS NOT NULL THEN
      INSERT INTO public.audit_logs(organization_id, user_id, action, entity_type, entity_id, new_values)
      VALUES (p_org, p_actor, 'sod.self_action_warn',
              COALESCE(p_entity_type,'unknown'), p_entity_id,
              jsonb_build_object('action_key', p_action, 'subject', p_subject,
                                 'source', CASE WHEN v_policy_exists THEN 'policy' ELSE 'mode_default' END));
    END IF;
    RETURN;
  END IF;

  -- block / require_cosign: look for a fresh, unconsumed override.
  IF p_org IS NOT NULL THEN
    SELECT * INTO v_override
      FROM public.self_action_overrides o
     WHERE o.organization_id = p_org
       AND o.actor_user_id   = p_actor
       AND o.subject_user_id = p_subject
       AND o.action_key      = p_action
       AND (p_entity_id IS NULL OR o.entity_id IS NULL OR o.entity_id = p_entity_id)
       AND o.expires_at > now()
       AND o.consumed_at IS NULL
     ORDER BY o.created_at DESC
     LIMIT 1
     FOR UPDATE;

    IF FOUND THEN
      PERFORM set_config('app.self_action_consume','true', true);
      UPDATE public.self_action_overrides
         SET consumed_at = now(),
             consumed_entity_id = p_entity_id
       WHERE id = v_override.id;
      PERFORM set_config('app.self_action_consume','false', true);

      INSERT INTO public.audit_logs(organization_id, user_id, action, entity_type, entity_id, new_values)
      VALUES (p_org, p_actor, 'sod.self_action_override_consumed',
              COALESCE(p_entity_type,'unknown'), p_entity_id,
              jsonb_build_object('action_key', p_action, 'override_id', v_override.id));
      RETURN;
    END IF;

    INSERT INTO public.audit_logs(organization_id, user_id, action, entity_type, entity_id, new_values)
    VALUES (p_org, p_actor, 'sod.self_action_blocked',
            COALESCE(p_entity_type,'unknown'), p_entity_id,
            jsonb_build_object('action_key', p_action, 'subject', p_subject));
  END IF;

  RAISE EXCEPTION 'Self-approval blocked for action "%".', p_action
    USING ERRCODE = '42501', HINT = 'GOV_SELF_ACTION';
END $function$;

-- =========================================================================
-- Phase L3 — Canonical loan finance posters (replaces the loan-gl edge fn)
-- =========================================================================

-- Small helper: resolve a loan GL account with the same 3-tier semantics
-- previously in the edge function: (1) override on loan_types, (2)
-- default_account_settings via resolve_default_account, (3) system_role match.
CREATE OR REPLACE FUNCTION public._loan_resolve_account(
  _org uuid,
  _business uuid,
  _branch uuid,
  _setting_key text,
  _override uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
  IF _override IS NOT NULL THEN RETURN _override; END IF;
  IF _business IS NOT NULL THEN
    v_id := public.resolve_default_account(_business, _setting_key, _branch);
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;
  SELECT id INTO v_id
    FROM public.accounts
   WHERE organization_id = _org
     AND system_role = _setting_key
     AND is_active = true
     AND (_business IS NULL OR business_id = _business OR business_id IS NULL)
   ORDER BY (business_id = _business) DESC NULLS LAST
   LIMIT 1;
  RETURN v_id;
END $$;

-- Disburse: awaiting_disbursement → active, posts Dr Loan Receivable / Cr Bank.
CREATE OR REPLACE FUNCTION public.employee_loan_disburse(
  _loan_id uuid,
  _bank_account_id uuid,
  _value_date date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  r public.employee_loans;
  v_receivable uuid;
  v_amount numeric;
  v_je_id uuid;
  v_entry_date date;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id = _loan_id FOR UPDATE;
  IF r.id IS NULL THEN
    RAISE EXCEPTION 'Loan not found.' USING ERRCODE='22023', HINT='LOAN_CONTEXT_NOT_FOUND';
  END IF;

  -- Idempotency: an existing disbursement JE short-circuits.
  IF r.disbursement_journal_entry_id IS NOT NULL THEN
    RETURN jsonb_build_object('journal_entry_id', r.disbursement_journal_entry_id,
                              'idempotent', true, 'status', r.status);
  END IF;

  IF r.status NOT IN ('awaiting_disbursement','approved') THEN
    RAISE EXCEPTION 'A loan in status "%" cannot be disbursed. Authorize disbursement first.', r.status
      USING ERRCODE='22023', HINT='LOAN_STATE_DISBURSE';
  END IF;

  IF _bank_account_id IS NULL THEN
    RAISE EXCEPTION 'Bank/cash account is required for disbursement.'
      USING ERRCODE='22023', HINT='LOAN_BANK_REQUIRED';
  END IF;

  -- Resolve the loan receivable account. Falls back through
  -- resolve_default_account then system_role.
  v_receivable := public._loan_resolve_account(
    r.organization_id, r.business_id, r.branch_id, 'loan_receivable',
    (SELECT gl_receivable_account_id FROM public.loan_types WHERE id = r.loan_type_id)
  );
  IF v_receivable IS NULL THEN
    RAISE EXCEPTION 'Loan Receivable account is not mapped. Configure it under Finance → Default Accounts (loan_receivable).'
      USING ERRCODE='22023', HINT='LOAN_ACCOUNT_UNMAPPED';
  END IF;

  v_amount := COALESCE(r.principal_amount, 0);
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Loan principal must be greater than zero.'
      USING ERRCODE='22023', HINT='LOAN_PRINCIPAL_INVALID';
  END IF;
  v_entry_date := COALESCE(_value_date, CURRENT_DATE);

  INSERT INTO public.journal_entries(
    organization_id, business_id, branch_id, entry_date,
    description, reference, status, posted_at, posted_by,
    source_type, source_id, total_debit, total_credit, created_by
  ) VALUES (
    r.organization_id, r.business_id, r.branch_id, v_entry_date,
    'Loan disbursement — ' || r.loan_number, r.loan_number,
    'posted', now(), auth.uid(),
    'loan_disbursement', r.id, v_amount, v_amount, auth.uid()
  ) RETURNING id INTO v_je_id;

  INSERT INTO public.journal_entry_lines(
    journal_entry_id, account_id, debit, credit, description,
    sort_order, business_id, branch_id
  ) VALUES
    (v_je_id, v_receivable, v_amount, 0,
     'Loan receivable — ' || r.loan_number, 1, r.business_id, r.branch_id),
    (v_je_id, _bank_account_id, 0, v_amount,
     'Bank disbursement — ' || r.loan_number, 2, r.business_id, r.branch_id);

  UPDATE public.employee_loans
     SET status = 'active',
         disbursed_at = COALESCE(disbursed_at, now()),
         disbursement_journal_entry_id = v_je_id,
         updated_at = now()
   WHERE id = r.id;

  PERFORM public.loan_log_event(
    r.id, 'disburse', r.status, 'active', v_amount, NULL,
    jsonb_build_object('journal_entry_id', v_je_id, 'bank_account_id', _bank_account_id));

  RETURN jsonb_build_object('journal_entry_id', v_je_id, 'idempotent', false, 'status', 'active');
END $$;

-- Settle: active/in_arrears with zero balance → settled. No JE required
-- because repayments already cleared the receivable; we just close the loan.
CREATE OR REPLACE FUNCTION public.employee_loan_settle(_loan_id uuid)
RETURNS public.employee_loans
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE r public.employee_loans; prior text;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  IF r.id IS NULL THEN
    RAISE EXCEPTION 'Loan not found.' USING ERRCODE='22023', HINT='LOAN_CONTEXT_NOT_FOUND';
  END IF;
  prior := r.status;
  IF prior NOT IN ('active','in_arrears') THEN
    RAISE EXCEPTION 'A loan in status "%" cannot be settled.', prior
      USING ERRCODE='22023', HINT='LOAN_STATE_SETTLE';
  END IF;
  IF r.outstanding_balance > 0.005 THEN
    RAISE EXCEPTION 'Loan still has an outstanding balance of %.', r.outstanding_balance
      USING ERRCODE='22023', HINT='LOAN_BALANCE_NONZERO';
  END IF;
  UPDATE public.employee_loans
     SET status='settled', end_date=COALESCE(end_date, CURRENT_DATE), updated_at=now()
   WHERE id=_loan_id RETURNING * INTO r;
  PERFORM public.loan_log_event(_loan_id,'settle',prior,'settled');
  RETURN r;
END $$;

GRANT EXECUTE ON FUNCTION public.employee_loan_disburse(uuid, uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee_loan_settle(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public._loan_resolve_account(uuid, uuid, uuid, text, uuid) TO authenticated;