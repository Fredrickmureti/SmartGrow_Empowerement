
-- ============================================================
-- Employee Loans & Advances — Foundation
-- ============================================================

ALTER TABLE public.employee_loans DROP CONSTRAINT IF EXISTS employee_loans_status_check;
ALTER TABLE public.employee_loans
  ADD CONSTRAINT employee_loans_status_check CHECK (status = ANY (ARRAY[
    'requested','pending_approval','rejected','draft',
    'approved','awaiting_disbursement','disbursement_failed',
    'active','in_arrears','paused','restructured',
    'completed','written_off','defaulted',
    'closed_on_termination','cancelled','suspended','archived'
  ]));

ALTER TABLE public.employee_loans
  ADD COLUMN IF NOT EXISTS parent_loan_id uuid REFERENCES public.employee_loans(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS refinance_kind text CHECK (refinance_kind IN ('restructure','refinance','topup','consolidation')),
  ADD COLUMN IF NOT EXISTS writeoff_journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS writeoff_reason text,
  ADD COLUMN IF NOT EXISTS writeoff_at timestamptz,
  ADD COLUMN IF NOT EXISTS writeoff_by uuid,
  ADD COLUMN IF NOT EXISTS writeoff_cosigner_id uuid,
  ADD COLUMN IF NOT EXISTS arrears_since date,
  ADD COLUMN IF NOT EXISTS arrears_amount numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS consent_captured_at timestamptz,
  ADD COLUMN IF NOT EXISTS consent_captured_by uuid;

CREATE TABLE IF NOT EXISTS public.loan_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  loan_id uuid NOT NULL REFERENCES public.employee_loans(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  prior_status text,
  new_status text,
  amount numeric(18,2),
  reason text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid,
  cosigner_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.loan_lifecycle_events TO authenticated;
GRANT ALL ON public.loan_lifecycle_events TO service_role;
ALTER TABLE public.loan_lifecycle_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Org members read loan lifecycle events" ON public.loan_lifecycle_events;
CREATE POLICY "Org members read loan lifecycle events"
  ON public.loan_lifecycle_events FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_business_access WHERE user_id = auth.uid()));

CREATE OR REPLACE FUNCTION public.loan_lifecycle_events_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'loan_lifecycle_events is append-only'; END $$;
DROP TRIGGER IF EXISTS trg_loan_lifecycle_events_immutable_u ON public.loan_lifecycle_events;
CREATE TRIGGER trg_loan_lifecycle_events_immutable_u
  BEFORE UPDATE OR DELETE ON public.loan_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION public.loan_lifecycle_events_immutable();

CREATE INDEX IF NOT EXISTS idx_loan_lifecycle_events_loan ON public.loan_lifecycle_events(loan_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loan_lifecycle_events_org_type ON public.loan_lifecycle_events(organization_id, event_type, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_loan_repayments_loan_payslip
  ON public.loan_repayments(loan_id, payslip_id) WHERE payslip_id IS NOT NULL;

ALTER TABLE public.loan_repayments
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'payroll' CHECK (kind IN ('payroll','manual','external','reversal','writeoff')),
  ADD COLUMN IF NOT EXISTS reversal_of_id uuid REFERENCES public.loan_repayments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by uuid;

ALTER TABLE public.loan_types
  ADD COLUMN IF NOT EXISTS interest_method text NOT NULL DEFAULT 'flat'
    CHECK (interest_method IN ('none','flat','reducing_balance','apr')),
  ADD COLUMN IF NOT EXISTS deduction_priority integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS max_exposure_pct_of_net numeric(5,2),
  ADD COLUMN IF NOT EXISTS max_tenure_months integer,
  ADD COLUMN IF NOT EXISTS min_tenure_months integer,
  ADD COLUMN IF NOT EXISTS requires_collateral boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS requires_consent boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_topup boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_restructure boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS dual_control_writeoff boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS interest_income_account_id uuid REFERENCES public.accounts(id),
  ADD COLUMN IF NOT EXISTS writeoff_account_id uuid REFERENCES public.accounts(id),
  ADD COLUMN IF NOT EXISTS clearing_account_id uuid REFERENCES public.accounts(id);

CREATE TABLE IF NOT EXISTS public.payroll_loan_recovery_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  global_min_net_floor numeric(18,2) NOT NULL DEFAULT 0,
  global_max_total_pct_of_net numeric(5,2) NOT NULL DEFAULT 50,
  multi_loan_strategy text NOT NULL DEFAULT 'priority_then_oldest'
    CHECK (multi_loan_strategy IN ('priority_then_oldest','pro_rata','oldest_first','smallest_first')),
  supplemental_run_behaviour text NOT NULL DEFAULT 'skip'
    CHECK (supplemental_run_behaviour IN ('skip','recover','recover_if_arrears')),
  offcycle_run_behaviour text NOT NULL DEFAULT 'skip'
    CHECK (offcycle_run_behaviour IN ('skip','recover','recover_if_arrears')),
  unpaid_leave_auto_pause boolean NOT NULL DEFAULT true,
  termination_auto_settle boolean NOT NULL DEFAULT true,
  arrears_grace_days integer NOT NULL DEFAULT 7,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, business_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll_loan_recovery_policy TO authenticated;
GRANT ALL ON public.payroll_loan_recovery_policy TO service_role;
ALTER TABLE public.payroll_loan_recovery_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Org members manage loan recovery policy" ON public.payroll_loan_recovery_policy;
CREATE POLICY "Org members manage loan recovery policy"
  ON public.payroll_loan_recovery_policy FOR ALL TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_business_access WHERE user_id = auth.uid()))
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_business_access WHERE user_id = auth.uid()));

CREATE OR REPLACE FUNCTION public.touch_payroll_loan_recovery_policy()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS trg_touch_payroll_loan_recovery_policy ON public.payroll_loan_recovery_policy;
CREATE TRIGGER trg_touch_payroll_loan_recovery_policy
  BEFORE UPDATE ON public.payroll_loan_recovery_policy
  FOR EACH ROW EXECUTE FUNCTION public.touch_payroll_loan_recovery_policy();

CREATE OR REPLACE FUNCTION public.loan_log_event(
  _loan_id uuid, _event_type text, _prior_status text, _new_status text,
  _amount numeric DEFAULT NULL, _reason text DEFAULT NULL,
  _payload jsonb DEFAULT '{}'::jsonb, _cosigner uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid; _id uuid;
BEGIN
  SELECT organization_id INTO _org FROM public.employee_loans WHERE id = _loan_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'loan not found: %', _loan_id; END IF;
  INSERT INTO public.loan_lifecycle_events(organization_id, loan_id, event_type, prior_status, new_status, amount, reason, payload, actor_user_id, cosigner_user_id)
  VALUES (_org, _loan_id, _event_type, _prior_status, _new_status, _amount, _reason, COALESCE(_payload,'{}'::jsonb), auth.uid(), _cosigner)
  RETURNING id INTO _id;
  RETURN _id;
END $$;

CREATE OR REPLACE FUNCTION public.employee_loan_submit(_loan_id uuid)
RETURNS public.employee_loans LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.employee_loans; prior text;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id = _loan_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'loan not found'; END IF;
  prior := r.status;
  IF prior NOT IN ('draft','requested','rejected') THEN RAISE EXCEPTION 'cannot submit loan in status %', prior; END IF;
  UPDATE public.employee_loans SET status='pending_approval', requested_at=COALESCE(requested_at, now()), requested_by=COALESCE(requested_by, auth.uid()), updated_at=now()
    WHERE id=_loan_id RETURNING * INTO r;
  PERFORM public.loan_log_event(_loan_id,'submit',prior,'pending_approval');
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.employee_loan_lifecycle_approve(_loan_id uuid)
RETURNS public.employee_loans LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.employee_loans; prior text;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'loan not found'; END IF;
  prior := r.status;
  IF prior NOT IN ('pending_approval','requested','draft') THEN RAISE EXCEPTION 'cannot approve loan in status %', prior; END IF;
  PERFORM public.governance_assert_not_self('loan.approve','employee_loan',_loan_id, r.created_by);
  PERFORM public.governance_assert_not_subject('loan.approve_self_benefit','employee_loan',_loan_id);
  UPDATE public.employee_loans SET status='approved', approved_by=auth.uid(), approved_at=now(), updated_at=now()
    WHERE id=_loan_id RETURNING * INTO r;
  PERFORM public.loan_log_event(_loan_id,'approve',prior,'approved');
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.employee_loan_lifecycle_reject(_loan_id uuid, _reason text)
RETURNS public.employee_loans LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.employee_loans; prior text;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  prior := r.status;
  IF prior NOT IN ('pending_approval','requested','draft','approved') THEN RAISE EXCEPTION 'cannot reject loan in status %', prior; END IF;
  UPDATE public.employee_loans SET status='rejected', rejected_by=auth.uid(), rejected_at=now(), rejection_reason=_reason, updated_at=now()
    WHERE id=_loan_id RETURNING * INTO r;
  PERFORM public.loan_log_event(_loan_id,'reject',prior,'rejected',NULL,_reason);
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.employee_loan_authorize_disbursement(_loan_id uuid)
RETURNS public.employee_loans LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.employee_loans; prior text;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  prior := r.status;
  IF prior <> 'approved' THEN RAISE EXCEPTION 'cannot authorize disbursement in status %', prior; END IF;
  PERFORM public.governance_assert_not_self('employee_loan.authorize_disbursement','employee_loan',_loan_id, r.approved_by);
  UPDATE public.employee_loans SET status='awaiting_disbursement', updated_at=now()
    WHERE id=_loan_id RETURNING * INTO r;
  PERFORM public.loan_log_event(_loan_id,'authorize_disbursement',prior,'awaiting_disbursement');
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.employee_loan_mark_disbursed(_loan_id uuid, _je_id uuid)
RETURNS public.employee_loans LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.employee_loans; prior text;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  prior := r.status;
  IF prior NOT IN ('awaiting_disbursement','approved','disbursement_failed') THEN RAISE EXCEPTION 'cannot mark disbursed in status %', prior; END IF;
  UPDATE public.employee_loans
    SET status='active', disbursed_at=COALESCE(disbursed_at, now()),
        disbursement_journal_entry_id = COALESCE(disbursement_journal_entry_id, _je_id), updated_at=now()
    WHERE id=_loan_id RETURNING * INTO r;
  PERFORM public.loan_log_event(_loan_id,'mark_disbursed',prior,'active',NULL,NULL,jsonb_build_object('journal_entry_id',_je_id));
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.employee_loan_mark_disbursement_failed(_loan_id uuid, _reason text)
RETURNS public.employee_loans LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.employee_loans; prior text;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  prior := r.status;
  IF prior NOT IN ('awaiting_disbursement','approved') THEN RAISE EXCEPTION 'cannot mark disbursement failed in status %', prior; END IF;
  UPDATE public.employee_loans SET status='disbursement_failed', updated_at=now()
    WHERE id=_loan_id RETURNING * INTO r;
  PERFORM public.loan_log_event(_loan_id,'mark_disbursement_failed',prior,'disbursement_failed',NULL,_reason);
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.employee_loan_pause(_loan_id uuid, _until date, _reason text DEFAULT NULL)
RETURNS public.employee_loans LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.employee_loans; prior text;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  prior := r.status;
  IF prior NOT IN ('active','in_arrears') THEN RAISE EXCEPTION 'cannot pause loan in status %', prior; END IF;
  UPDATE public.employee_loans SET status='paused', paused_until=_until, updated_at=now()
    WHERE id=_loan_id RETURNING * INTO r;
  PERFORM public.loan_log_event(_loan_id,'pause',prior,'paused',NULL,_reason,jsonb_build_object('until',_until));
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.employee_loan_resume(_loan_id uuid)
RETURNS public.employee_loans LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.employee_loans; prior text;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  prior := r.status;
  IF prior <> 'paused' THEN RAISE EXCEPTION 'cannot resume loan in status %', prior; END IF;
  UPDATE public.employee_loans SET status='active', paused_until=NULL, updated_at=now()
    WHERE id=_loan_id RETURNING * INTO r;
  PERFORM public.loan_log_event(_loan_id,'resume',prior,'active');
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.employee_loan_skip_installment(_loan_id uuid, _schedule_id uuid, _reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.loan_repayment_schedule SET status='skipped', notes=COALESCE(notes,'')||' [skip: '||_reason||']', updated_at=now()
    WHERE id=_schedule_id AND loan_id=_loan_id AND status IN ('pending','partial');
  IF NOT FOUND THEN RAISE EXCEPTION 'schedule row not found or not skippable'; END IF;
  PERFORM public.loan_log_event(_loan_id,'skip_installment',NULL,NULL,NULL,_reason,jsonb_build_object('schedule_id',_schedule_id));
  RETURN _schedule_id;
END $$;

CREATE OR REPLACE FUNCTION public.employee_loan_record_manual_repayment(
  _loan_id uuid, _amount numeric, _repayment_date date, _notes text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.employee_loans; rep_id uuid; next_seq integer;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'loan not found'; END IF;
  IF r.status NOT IN ('active','in_arrears','paused','restructured') THEN RAISE EXCEPTION 'cannot record repayment in status %', r.status; END IF;
  IF _amount <= 0 THEN RAISE EXCEPTION 'amount must be positive'; END IF;
  PERFORM public.governance_assert_not_self('employee_loan.record_manual_repayment','employee_loan',_loan_id, r.created_by);
  SELECT COALESCE(MAX(installment_number),0)+1 INTO next_seq FROM public.loan_repayments WHERE loan_id=_loan_id;
  INSERT INTO public.loan_repayments(loan_id, amount, repayment_date, installment_number, notes, kind, created_by)
    VALUES (_loan_id, _amount, _repayment_date, next_seq, _notes, 'manual', auth.uid())
    RETURNING id INTO rep_id;
  UPDATE public.employee_loans
    SET amount_repaid = amount_repaid + _amount,
        outstanding_balance = GREATEST(0, outstanding_balance - _amount),
        installments_paid = installments_paid + 1, updated_at = now()
    WHERE id = _loan_id;
  PERFORM public.loan_log_event(_loan_id,'record_manual_repayment',r.status,r.status,_amount,_notes,jsonb_build_object('repayment_id',rep_id));
  RETURN rep_id;
END $$;

CREATE OR REPLACE FUNCTION public.employee_loan_reverse_repayment(_repayment_id uuid, _reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE orig public.loan_repayments; rev_id uuid;
BEGIN
  SELECT * INTO orig FROM public.loan_repayments WHERE id=_repayment_id FOR UPDATE;
  IF orig.id IS NULL THEN RAISE EXCEPTION 'repayment not found'; END IF;
  IF orig.kind = 'reversal' THEN RAISE EXCEPTION 'cannot reverse a reversal'; END IF;
  INSERT INTO public.loan_repayments(loan_id, amount, repayment_date, installment_number, notes, kind, reversal_of_id, created_by)
    VALUES (orig.loan_id, -orig.amount, CURRENT_DATE, 0, COALESCE(_reason,'reversal'), 'reversal', orig.id, auth.uid())
    RETURNING id INTO rev_id;
  UPDATE public.employee_loans
    SET amount_repaid = GREATEST(0, amount_repaid - orig.amount),
        outstanding_balance = outstanding_balance + orig.amount,
        installments_paid = GREATEST(0, installments_paid - 1), updated_at = now()
    WHERE id = orig.loan_id;
  IF orig.payslip_id IS NOT NULL THEN
    UPDATE public.loan_repayment_schedule
      SET status='pending', paid_amount=0, payslip_id=NULL, repayment_id=NULL, updated_at=now()
      WHERE loan_id=orig.loan_id AND repayment_id=orig.id;
  END IF;
  PERFORM public.loan_log_event(orig.loan_id,'reverse_repayment',NULL,NULL,orig.amount,_reason,jsonb_build_object('repayment_id',orig.id,'reversal_id',rev_id));
  RETURN rev_id;
END $$;

CREATE OR REPLACE FUNCTION public.employee_loan_write_off(_loan_id uuid, _reason text, _cosigner uuid)
RETURNS public.employee_loans LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.employee_loans; prior text; lt public.loan_types;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'loan not found'; END IF;
  prior := r.status;
  IF prior NOT IN ('active','in_arrears','paused','restructured','defaulted','closed_on_termination') THEN
    RAISE EXCEPTION 'cannot write-off loan in status %', prior;
  END IF;
  IF _cosigner IS NULL OR _cosigner = auth.uid() THEN
    RAISE EXCEPTION 'write-off requires a distinct co-signer (dual control)';
  END IF;
  PERFORM public.governance_assert_not_self('employee_loan.write_off','employee_loan',_loan_id, r.created_by);
  SELECT * INTO lt FROM public.loan_types WHERE id=r.loan_type_id;
  IF COALESCE(lt.dual_control_writeoff, true) AND _cosigner = r.approved_by THEN
    RAISE EXCEPTION 'co-signer must differ from approver under dual control';
  END IF;
  UPDATE public.employee_loans
    SET status='written_off', writeoff_at=now(), writeoff_by=auth.uid(),
        writeoff_cosigner_id=_cosigner, writeoff_reason=_reason, updated_at=now()
    WHERE id=_loan_id RETURNING * INTO r;
  PERFORM public.loan_log_event(_loan_id,'write_off',prior,'written_off',r.outstanding_balance,_reason,jsonb_build_object('cosigner',_cosigner),_cosigner);
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.employee_loan_restructure(
  _loan_id uuid, _kind text, _new_principal numeric, _new_installments integer,
  _new_start_date date, _new_monthly numeric DEFAULT NULL, _reason text DEFAULT NULL
) RETURNS public.employee_loans LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.employee_loans; nl public.employee_loans; prior text; new_no text;
BEGIN
  IF _kind NOT IN ('restructure','refinance','topup','consolidation') THEN RAISE EXCEPTION 'invalid kind %', _kind; END IF;
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'loan not found'; END IF;
  prior := r.status;
  IF prior NOT IN ('active','in_arrears','paused') THEN RAISE EXCEPTION 'cannot restructure in status %', prior; END IF;
  PERFORM public.governance_assert_not_self('employee_loan.restructure','employee_loan',_loan_id, r.created_by);
  SELECT public.get_next_loan_number(r.organization_id) INTO new_no;
  INSERT INTO public.employee_loans(
    organization_id, business_id, employee_id, loan_number, loan_type, loan_type_id,
    description, principal_amount, interest_rate, total_amount, amount_repaid,
    outstanding_balance, monthly_deduction, total_installments, installments_paid,
    start_date, status, repayment_method, parent_loan_id, refinance_kind, notes, created_by
  ) VALUES (
    r.organization_id, r.business_id, r.employee_id, new_no, r.loan_type, r.loan_type_id,
    COALESCE(_reason, r.description), _new_principal, r.interest_rate, _new_principal, 0,
    _new_principal, COALESCE(_new_monthly, _new_principal/GREATEST(_new_installments,1)),
    _new_installments, 0, _new_start_date, 'approved', r.repayment_method, r.id, _kind,
    COALESCE(_reason,'restructured from '||r.loan_number), auth.uid()
  ) RETURNING * INTO nl;
  UPDATE public.employee_loans SET status='restructured', updated_at=now() WHERE id=_loan_id;
  PERFORM public.loan_log_event(_loan_id,'restructure',prior,'restructured',_new_principal,_reason,jsonb_build_object('new_loan_id',nl.id,'kind',_kind));
  PERFORM public.loan_log_event(nl.id,'submit',NULL,'approved',NULL,'spawned from '||r.loan_number,jsonb_build_object('parent_loan_id',r.id));
  RETURN nl;
END $$;

CREATE OR REPLACE FUNCTION public.employee_loan_settle_early(_loan_id uuid)
RETURNS public.employee_loans LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.employee_loans; prior text;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  prior := r.status;
  IF prior NOT IN ('active','in_arrears','paused') THEN RAISE EXCEPTION 'cannot settle in status %', prior; END IF;
  IF r.outstanding_balance > 0.005 THEN RAISE EXCEPTION 'outstanding balance must be zero (currently %)', r.outstanding_balance; END IF;
  UPDATE public.employee_loans SET status='completed', end_date=COALESCE(end_date, CURRENT_DATE), updated_at=now()
    WHERE id=_loan_id RETURNING * INTO r;
  PERFORM public.loan_log_event(_loan_id,'settle_early',prior,'completed');
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.employee_loan_close_on_termination(_loan_id uuid, _final_settlement_amount numeric, _reason text)
RETURNS public.employee_loans LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.employee_loans; prior text;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  prior := r.status;
  IF prior NOT IN ('active','in_arrears','paused','restructured','disbursement_failed') THEN
    RAISE EXCEPTION 'cannot close-on-termination in status %', prior;
  END IF;
  IF _final_settlement_amount > 0 THEN
    INSERT INTO public.loan_repayments(loan_id, amount, repayment_date, installment_number, notes, kind, created_by)
      VALUES (_loan_id, _final_settlement_amount, CURRENT_DATE,
              (SELECT COALESCE(MAX(installment_number),0)+1 FROM public.loan_repayments WHERE loan_id=_loan_id),
              'Final settlement on termination: '||COALESCE(_reason,''), 'manual', auth.uid());
    UPDATE public.employee_loans
      SET amount_repaid = amount_repaid + _final_settlement_amount,
          outstanding_balance = GREATEST(0, outstanding_balance - _final_settlement_amount)
      WHERE id=_loan_id;
  END IF;
  UPDATE public.employee_loans SET status='closed_on_termination', end_date=COALESCE(end_date,CURRENT_DATE), updated_at=now()
    WHERE id=_loan_id RETURNING * INTO r;
  PERFORM public.loan_log_event(_loan_id,'close_on_termination',prior,'closed_on_termination',_final_settlement_amount,_reason);
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.employee_loan_cancel(_loan_id uuid, _reason text)
RETURNS public.employee_loans LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.employee_loans; prior text;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  prior := r.status;
  IF prior IN ('completed','written_off','closed_on_termination','cancelled','archived','restructured') THEN
    RAISE EXCEPTION 'cannot cancel loan in terminal status %', prior;
  END IF;
  IF r.amount_repaid > 0 OR r.disbursement_journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'cannot cancel loan with activity; use restructure or write-off';
  END IF;
  UPDATE public.employee_loans SET status='cancelled', updated_at=now()
    WHERE id=_loan_id RETURNING * INTO r;
  PERFORM public.loan_log_event(_loan_id,'cancel',prior,'cancelled',NULL,_reason);
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.employee_loan_mark_arrears(_loan_id uuid, _amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.employee_loans; prior text;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  prior := r.status;
  IF prior = 'active' THEN
    UPDATE public.employee_loans SET status='in_arrears', arrears_since=COALESCE(arrears_since,CURRENT_DATE), arrears_amount=_amount, updated_at=now() WHERE id=_loan_id;
    PERFORM public.loan_log_event(_loan_id,'enter_arrears',prior,'in_arrears',_amount);
  ELSIF prior = 'in_arrears' THEN
    UPDATE public.employee_loans SET arrears_amount=_amount, updated_at=now() WHERE id=_loan_id;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.employee_loan_clear_arrears(_loan_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.employee_loans; prior text;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  prior := r.status;
  IF prior = 'in_arrears' THEN
    UPDATE public.employee_loans SET status='active', arrears_since=NULL, arrears_amount=0, updated_at=now() WHERE id=_loan_id;
    PERFORM public.loan_log_event(_loan_id,'exit_arrears',prior,'active');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.employee_loan_check_eligibility(
  _employee_id uuid, _loan_type_id uuid, _principal numeric, _installments integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  lt public.loan_types; v_net numeric; v_open_count integer; v_open_exposure numeric;
  v_monthly_estimate numeric; v_dti_ratio numeric; v_violations text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO lt FROM public.loan_types WHERE id=_loan_type_id;
  IF lt.id IS NULL THEN RAISE EXCEPTION 'loan type not found'; END IF;
  v_monthly_estimate := CASE WHEN _installments > 0 THEN _principal / _installments ELSE _principal END;
  SELECT COUNT(*), COALESCE(SUM(outstanding_balance),0) INTO v_open_count, v_open_exposure
    FROM public.employee_loans WHERE employee_id=_employee_id
      AND status IN ('active','in_arrears','paused','awaiting_disbursement','approved','restructured');
  SELECT net_pay INTO v_net FROM public.payslips WHERE employee_id=_employee_id ORDER BY created_at DESC LIMIT 1;
  IF lt.max_tenure_months IS NOT NULL AND _installments > lt.max_tenure_months THEN
    v_violations := v_violations || format('Tenure %s exceeds max %s', _installments, lt.max_tenure_months);
  END IF;
  IF lt.min_tenure_months IS NOT NULL AND _installments < lt.min_tenure_months THEN
    v_violations := v_violations || format('Tenure %s below min %s', _installments, lt.min_tenure_months);
  END IF;
  IF lt.max_exposure_pct_of_net IS NOT NULL AND v_net IS NOT NULL AND v_net > 0 THEN
    v_dti_ratio := (v_monthly_estimate / v_net) * 100;
    IF v_dti_ratio > lt.max_exposure_pct_of_net THEN
      v_violations := v_violations || format('Monthly recovery %s%% of net exceeds cap %s%%', round(v_dti_ratio,2), lt.max_exposure_pct_of_net);
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'eligible', array_length(v_violations,1) IS NULL,
    'violations', to_jsonb(v_violations),
    'open_loan_count', v_open_count,
    'open_exposure', v_open_exposure,
    'monthly_estimate', v_monthly_estimate,
    'latest_net_pay', v_net,
    'dti_ratio', v_dti_ratio
  );
END $$;

GRANT EXECUTE ON FUNCTION public.employee_loan_submit(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee_loan_lifecycle_approve(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee_loan_lifecycle_reject(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee_loan_authorize_disbursement(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee_loan_mark_disbursed(uuid,uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.employee_loan_mark_disbursement_failed(uuid,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.employee_loan_pause(uuid,date,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee_loan_resume(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee_loan_skip_installment(uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee_loan_record_manual_repayment(uuid,numeric,date,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee_loan_reverse_repayment(uuid,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.employee_loan_write_off(uuid,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee_loan_restructure(uuid,text,numeric,integer,date,numeric,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee_loan_settle_early(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee_loan_close_on_termination(uuid,numeric,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.employee_loan_cancel(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee_loan_mark_arrears(uuid,numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.employee_loan_clear_arrears(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.employee_loan_check_eligibility(uuid,uuid,numeric,integer) TO authenticated;

INSERT INTO public.self_action_policy(organization_id, action_key, mode, created_at, updated_at)
SELECT o.id, k.action_key, 'block', now(), now()
FROM public.organizations o
CROSS JOIN (VALUES
  ('employee_loan.authorize_disbursement'),
  ('employee_loan.write_off'),
  ('employee_loan.restructure'),
  ('employee_loan.refinance'),
  ('employee_loan.record_manual_repayment')
) k(action_key)
ON CONFLICT (organization_id, action_key) WHERE applies_to_role IS NULL DO NOTHING;

CREATE OR REPLACE VIEW public.v_loan_portfolio_aging AS
SELECT l.organization_id, l.business_id, l.id AS loan_id, l.loan_number, l.employee_id,
       l.loan_type_id, lt.name AS loan_type_name,
       l.status, l.principal_amount, l.outstanding_balance, l.arrears_amount, l.arrears_since,
       CASE WHEN l.arrears_since IS NULL THEN 'current'
            WHEN CURRENT_DATE - l.arrears_since <= 30 THEN '1-30'
            WHEN CURRENT_DATE - l.arrears_since <= 60 THEN '31-60'
            WHEN CURRENT_DATE - l.arrears_since <= 90 THEN '61-90'
            ELSE '90+' END AS aging_bucket,
       l.created_at, l.updated_at
FROM public.employee_loans l LEFT JOIN public.loan_types lt ON lt.id = l.loan_type_id;
GRANT SELECT ON public.v_loan_portfolio_aging TO authenticated;

CREATE OR REPLACE VIEW public.v_loan_exposure_by_dimension AS
SELECT l.organization_id, l.business_id, l.loan_type_id, lt.name AS loan_type_name,
       e.department_id, e.branch_id,
       COUNT(*)::integer AS loan_count,
       SUM(l.outstanding_balance)::numeric(18,2) AS exposure,
       SUM(l.monthly_deduction)::numeric(18,2) AS monthly_recovery,
       SUM(l.arrears_amount)::numeric(18,2) AS arrears_total
FROM public.employee_loans l
LEFT JOIN public.loan_types lt ON lt.id = l.loan_type_id
LEFT JOIN public.employees e ON e.id = l.employee_id
WHERE l.status IN ('active','in_arrears','paused','restructured','awaiting_disbursement')
GROUP BY l.organization_id, l.business_id, l.loan_type_id, lt.name, e.department_id, e.branch_id;
GRANT SELECT ON public.v_loan_exposure_by_dimension TO authenticated;

CREATE OR REPLACE VIEW public.v_loan_recovery_rate AS
SELECT l.organization_id, l.business_id,
       date_trunc('month', r.repayment_date)::date AS period_month,
       SUM(CASE WHEN r.kind <> 'reversal' THEN r.amount ELSE 0 END)::numeric(18,2) AS recovered,
       SUM(CASE WHEN r.kind = 'reversal' THEN -r.amount ELSE 0 END)::numeric(18,2) AS reversed,
       SUM(r.amount)::numeric(18,2) AS net_recovered
FROM public.loan_repayments r JOIN public.employee_loans l ON l.id = r.loan_id
GROUP BY l.organization_id, l.business_id, date_trunc('month', r.repayment_date);
GRANT SELECT ON public.v_loan_recovery_rate TO authenticated;

CREATE OR REPLACE VIEW public.v_loan_writeoffs AS
SELECT l.organization_id, l.business_id, l.id AS loan_id, l.loan_number,
       l.employee_id, l.outstanding_balance AS amount_written_off,
       l.writeoff_at, l.writeoff_by, l.writeoff_cosigner_id, l.writeoff_reason
FROM public.employee_loans l WHERE l.status = 'written_off';
GRANT SELECT ON public.v_loan_writeoffs TO authenticated;

CREATE OR REPLACE VIEW public.v_loan_vintage AS
SELECT l.organization_id, l.business_id,
       date_trunc('month', l.start_date)::date AS vintage_month,
       COUNT(*)::integer AS originated_count,
       SUM(l.principal_amount)::numeric(18,2) AS originated_amount,
       SUM(CASE WHEN l.status='written_off' THEN l.principal_amount ELSE 0 END)::numeric(18,2) AS written_off_amount,
       SUM(CASE WHEN l.status='completed' THEN l.principal_amount ELSE 0 END)::numeric(18,2) AS completed_amount
FROM public.employee_loans l
GROUP BY l.organization_id, l.business_id, date_trunc('month', l.start_date);
GRANT SELECT ON public.v_loan_vintage TO authenticated;
