
-- ============ mf_loans ============
CREATE TABLE public.mf_loans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid,
  loan_number text NOT NULL,
  application_id uuid NOT NULL REFERENCES public.mf_loan_applications(id),
  client_id uuid NOT NULL REFERENCES public.mf_clients(id),
  group_id uuid REFERENCES public.mf_groups(id),
  product_id uuid NOT NULL REFERENCES public.mf_loan_products(id),
  product_version_id uuid NOT NULL REFERENCES public.mf_loan_product_versions(id),
  loan_officer_id uuid,
  currency_code text NOT NULL,
  principal numeric(18,2) NOT NULL CHECK (principal > 0),
  term_installments integer NOT NULL CHECK (term_installments > 0),
  repayment_frequency text NOT NULL,
  interest_method text NOT NULL,
  interest_rate numeric(9,4) NOT NULL DEFAULT 0,
  interest_rate_period text NOT NULL,
  grace_period_installments integer NOT NULL DEFAULT 0,
  fees jsonb NOT NULL DEFAULT '[]'::jsonb,
  penalty_rate numeric(9,4) NOT NULL DEFAULT 0,
  penalty_basis text,
  expected_disbursement_date date,
  first_installment_date date,
  status text NOT NULL DEFAULT 'pending_disbursement',
  disbursed_at timestamptz,
  closed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mf_loans_number_uniq UNIQUE (business_id, loan_number),
  CONSTRAINT mf_loans_application_uniq UNIQUE (application_id),
  CONSTRAINT mf_loans_status_chk CHECK (status IN ('pending_disbursement','active','closed','written_off','cancelled'))
);
CREATE INDEX mf_loans_client_idx ON public.mf_loans(business_id, client_id);
CREATE INDEX mf_loans_officer_idx ON public.mf_loans(business_id, loan_officer_id);
CREATE INDEX mf_loans_status_idx ON public.mf_loans(business_id, status);

GRANT SELECT, INSERT, UPDATE ON public.mf_loans TO authenticated;
GRANT ALL ON public.mf_loans TO service_role;
ALTER TABLE public.mf_loans ENABLE ROW LEVEL SECURITY;

CREATE POLICY mf_loans_read ON public.mf_loans FOR SELECT TO authenticated
  USING (user_has_business_access(auth.uid(), business_id));
CREATE POLICY mf_loans_insert ON public.mf_loans FOR INSERT TO authenticated
  WITH CHECK (user_has_business_access(auth.uid(), business_id)
    AND (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin')
      OR has_role(auth.uid(),'branch_manager') OR has_role(auth.uid(),'credit_officer')));
CREATE POLICY mf_loans_update ON public.mf_loans FOR UPDATE TO authenticated
  USING (user_has_business_access(auth.uid(), business_id)
    AND (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin')
      OR has_role(auth.uid(),'branch_manager') OR has_role(auth.uid(),'credit_officer')))
  WITH CHECK (user_has_business_access(auth.uid(), business_id));

-- ============ mf_loan_schedule ============
CREATE TABLE public.mf_loan_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  loan_id uuid NOT NULL REFERENCES public.mf_loans(id) ON DELETE CASCADE,
  installment_no integer NOT NULL CHECK (installment_no > 0),
  due_date date NOT NULL,
  opening_balance numeric(18,2) NOT NULL DEFAULT 0,
  principal_due numeric(18,2) NOT NULL DEFAULT 0,
  interest_due numeric(18,2) NOT NULL DEFAULT 0,
  fees_due numeric(18,2) NOT NULL DEFAULT 0,
  total_due numeric(18,2) NOT NULL DEFAULT 0,
  closing_balance numeric(18,2) NOT NULL DEFAULT 0,
  is_grace boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mf_loan_schedule_uniq UNIQUE (loan_id, installment_no)
);
CREATE INDEX mf_loan_schedule_due_idx ON public.mf_loan_schedule(business_id, due_date);

GRANT SELECT ON public.mf_loan_schedule TO authenticated;
GRANT ALL ON public.mf_loan_schedule TO service_role;
ALTER TABLE public.mf_loan_schedule ENABLE ROW LEVEL SECURITY;
CREATE POLICY mf_loan_schedule_read ON public.mf_loan_schedule FOR SELECT TO authenticated
  USING (user_has_business_access(auth.uid(), business_id));

-- ============ mf_loan_disbursements ============
CREATE TABLE public.mf_loan_disbursements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  loan_id uuid NOT NULL REFERENCES public.mf_loans(id),
  disbursed_on date NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  method text NOT NULL,
  reference text,
  source_account_id uuid,
  received_by_name text,
  notes text,
  disbursed_by uuid,
  reversed_at timestamptz,
  reversed_by uuid,
  reversal_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mf_loan_disbursements_one_active
  ON public.mf_loan_disbursements(loan_id) WHERE reversed_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON public.mf_loan_disbursements TO authenticated;
GRANT ALL ON public.mf_loan_disbursements TO service_role;
ALTER TABLE public.mf_loan_disbursements ENABLE ROW LEVEL SECURITY;
CREATE POLICY mf_loan_disb_read ON public.mf_loan_disbursements FOR SELECT TO authenticated
  USING (user_has_business_access(auth.uid(), business_id));

-- ============ mf_loan_events ============
CREATE TABLE public.mf_loan_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  loan_id uuid NOT NULL REFERENCES public.mf_loans(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  event_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid,
  amount numeric(18,2),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mf_loan_events_loan_idx ON public.mf_loan_events(loan_id, event_at);

GRANT SELECT ON public.mf_loan_events TO authenticated;
GRANT ALL ON public.mf_loan_events TO service_role;
ALTER TABLE public.mf_loan_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY mf_loan_events_read ON public.mf_loan_events FOR SELECT TO authenticated
  USING (user_has_business_access(auth.uid(), business_id));

-- ============ immutability guards ============
CREATE OR REPLACE FUNCTION public.mf_loans_freeze_terms()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.principal IS DISTINCT FROM NEW.principal
     OR OLD.term_installments IS DISTINCT FROM NEW.term_installments
     OR OLD.interest_rate IS DISTINCT FROM NEW.interest_rate
     OR OLD.interest_method IS DISTINCT FROM NEW.interest_method
     OR OLD.repayment_frequency IS DISTINCT FROM NEW.repayment_frequency
     OR OLD.product_version_id IS DISTINCT FROM NEW.product_version_id THEN
    IF OLD.status <> 'pending_disbursement' THEN
      RAISE EXCEPTION 'Contractual terms cannot be changed once the loan is disbursed';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END; $$;
CREATE TRIGGER mf_loans_freeze_terms BEFORE UPDATE ON public.mf_loans
  FOR EACH ROW EXECUTE FUNCTION public.mf_loans_freeze_terms();

CREATE OR REPLACE FUNCTION public.mf_loan_events_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'Loan events are append-only';
END; $$;
CREATE TRIGGER mf_loan_events_no_change BEFORE UPDATE OR DELETE ON public.mf_loan_events
  FOR EACH ROW EXECUTE FUNCTION public.mf_loan_events_append_only();

-- ============ schedule engine ============
CREATE OR REPLACE FUNCTION public.mf_add_period(p_date date, p_freq text, p_n integer)
RETURNS date LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE p_freq
    WHEN 'daily' THEN p_date + (p_n || ' days')::interval
    WHEN 'weekly' THEN p_date + (p_n * 7 || ' days')::interval
    WHEN 'biweekly' THEN p_date + (p_n * 14 || ' days')::interval
    WHEN 'monthly' THEN p_date + (p_n || ' months')::interval
    WHEN 'quarterly' THEN p_date + (p_n * 3 || ' months')::interval
    ELSE p_date + (p_n || ' months')::interval
  END::date
$$;

CREATE OR REPLACE FUNCTION public.mf_periods_per_year(p_freq text)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE p_freq
    WHEN 'daily' THEN 365 WHEN 'weekly' THEN 52 WHEN 'biweekly' THEN 26
    WHEN 'monthly' THEN 12 WHEN 'quarterly' THEN 4 ELSE 12 END::numeric
$$;

CREATE OR REPLACE FUNCTION public.mf_generate_schedule(p_loan_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  l public.mf_loans%ROWTYPE;
  v_rate numeric; v_ppy numeric; v_period_rate numeric;
  v_n integer; v_i integer; v_bal numeric; v_prin numeric; v_int numeric;
  v_flat_interest numeric; v_installment numeric; v_due date;
  v_upfront_fees numeric := 0; v_fee jsonb; v_paying integer;
BEGIN
  SELECT * INTO l FROM public.mf_loans WHERE id = p_loan_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found'; END IF;
  IF l.status <> 'pending_disbursement' THEN
    RAISE EXCEPTION 'Schedule can only be generated before disbursement';
  END IF;

  DELETE FROM public.mf_loan_schedule WHERE loan_id = p_loan_id;

  v_ppy := public.mf_periods_per_year(l.repayment_frequency);
  v_rate := COALESCE(l.interest_rate, 0) / 100.0;
  v_period_rate := CASE
    WHEN l.interest_rate_period = 'per_period' THEN v_rate
    WHEN l.interest_rate_period = 'per_month' THEN v_rate * 12 / v_ppy
    ELSE v_rate / v_ppy END;

  v_n := l.term_installments;
  v_paying := GREATEST(v_n - COALESCE(l.grace_period_installments,0), 1);
  v_bal := l.principal;

  FOR v_fee IN SELECT * FROM jsonb_array_elements(COALESCE(l.fees,'[]'::jsonb)) LOOP
    IF COALESCE(v_fee->>'timing','upfront') = 'upfront' THEN
      v_upfront_fees := v_upfront_fees + CASE
        WHEN COALESCE(v_fee->>'type','fixed') = 'percent'
          THEN l.principal * COALESCE((v_fee->>'value')::numeric,0) / 100.0
        ELSE COALESCE((v_fee->>'value')::numeric,0) END;
    END IF;
  END LOOP;

  IF l.interest_method = 'flat' THEN
    v_flat_interest := ROUND(l.principal * v_period_rate * v_n, 2);
  END IF;

  IF l.interest_method = 'declining_balance' THEN
    IF v_period_rate > 0 THEN
      v_installment := ROUND(l.principal * v_period_rate
        / (1 - POWER(1 + v_period_rate, -v_paying)), 2);
    ELSE
      v_installment := ROUND(l.principal / v_paying, 2);
    END IF;
  END IF;

  FOR v_i IN 1..v_n LOOP
    v_due := public.mf_add_period(
      COALESCE(l.first_installment_date, l.expected_disbursement_date, CURRENT_DATE),
      l.repayment_frequency, v_i - 1);

    IF v_i <= COALESCE(l.grace_period_installments,0) THEN
      v_prin := 0;
      v_int := CASE WHEN l.interest_method = 'declining_balance'
                 THEN ROUND(v_bal * v_period_rate, 2) ELSE 0 END;
    ELSIF l.interest_method = 'flat' THEN
      v_prin := ROUND(l.principal / v_paying, 2);
      v_int := ROUND(v_flat_interest / v_paying, 2);
      IF v_i = v_n THEN v_prin := v_bal; END IF;
    ELSE
      v_int := ROUND(v_bal * v_period_rate, 2);
      v_prin := LEAST(v_installment - v_int, v_bal);
      IF v_i = v_n THEN v_prin := v_bal; END IF;
      IF v_prin < 0 THEN v_prin := 0; END IF;
    END IF;

    INSERT INTO public.mf_loan_schedule (
      business_id, loan_id, installment_no, due_date, opening_balance,
      principal_due, interest_due, fees_due, total_due, closing_balance, is_grace)
    VALUES (l.business_id, l.id, v_i, v_due, v_bal, v_prin, v_int,
      CASE WHEN v_i = 1 THEN v_upfront_fees ELSE 0 END,
      v_prin + v_int + CASE WHEN v_i = 1 THEN v_upfront_fees ELSE 0 END,
      v_bal - v_prin, v_i <= COALESCE(l.grace_period_installments,0));

    v_bal := v_bal - v_prin;
  END LOOP;

  RETURN v_n;
END; $$;
REVOKE ALL ON FUNCTION public.mf_generate_schedule(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.mf_generate_schedule(uuid) TO authenticated, service_role;

-- ============ create loan from approved application ============
CREATE OR REPLACE FUNCTION public.mf_create_loan_from_application(
  p_application_id uuid,
  p_expected_disbursement_date date DEFAULT NULL,
  p_first_installment_date date DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a public.mf_loan_applications%ROWTYPE;
  v public.mf_loan_product_versions%ROWTYPE;
  v_loan_id uuid; v_number text; v_seq integer; v_first date;
BEGIN
  SELECT * INTO a FROM public.mf_loan_applications WHERE id = p_application_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Application not found'; END IF;
  IF NOT user_has_business_access(auth.uid(), a.business_id) THEN
    RAISE EXCEPTION 'Not authorised for this institution';
  END IF;
  IF NOT (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin')
       OR has_role(auth.uid(),'branch_manager') OR has_role(auth.uid(),'credit_officer')) THEN
    RAISE EXCEPTION 'You are not authorised to create loans';
  END IF;
  IF a.status NOT IN ('approved','ready_for_disbursement') THEN
    RAISE EXCEPTION 'Only an approved application can become a loan';
  END IF;
  IF EXISTS (SELECT 1 FROM public.mf_loans WHERE application_id = a.id) THEN
    RAISE EXCEPTION 'This application already has a loan';
  END IF;

  SELECT * INTO v FROM public.mf_loan_product_versions WHERE id = a.product_version_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product version missing on the application'; END IF;

  SELECT COALESCE(MAX(NULLIF(regexp_replace(loan_number,'\D','','g'),'')::integer),0) + 1
    INTO v_seq FROM public.mf_loans WHERE business_id = a.business_id;
  v_number := 'LN-' || to_char(v_seq, 'FM000000');

  v_first := COALESCE(p_first_installment_date,
    public.mf_add_period(COALESCE(p_expected_disbursement_date, CURRENT_DATE),
                         v.repayment_frequency, 1));

  INSERT INTO public.mf_loans (
    business_id, branch_id, loan_number, application_id, client_id, group_id,
    product_id, product_version_id, loan_officer_id, currency_code, principal,
    term_installments, repayment_frequency, interest_method, interest_rate,
    interest_rate_period, grace_period_installments, fees, penalty_rate,
    penalty_basis, expected_disbursement_date, first_installment_date, created_by)
  VALUES (
    a.business_id, a.branch_id, v_number, a.id, a.client_id, a.group_id,
    a.product_id, a.product_version_id, a.loan_officer_id, v.currency_code,
    COALESCE(a.approved_amount, a.requested_amount),
    COALESCE(a.approved_term_installments, a.requested_term_installments),
    v.repayment_frequency, v.interest_method, COALESCE(v.interest_rate,0),
    COALESCE(v.interest_rate_period,'per_year'), COALESCE(v.grace_period_installments,0),
    COALESCE(v.fees,'[]'::jsonb), COALESCE(v.penalty_rate,0), v.penalty_basis,
    COALESCE(p_expected_disbursement_date, CURRENT_DATE), v_first, auth.uid())
  RETURNING id INTO v_loan_id;

  PERFORM public.mf_generate_schedule(v_loan_id);

  INSERT INTO public.mf_loan_events (business_id, loan_id, event_type, actor_id, amount, payload)
  VALUES (a.business_id, v_loan_id, 'loan_created', auth.uid(),
          COALESCE(a.approved_amount, a.requested_amount),
          jsonb_build_object('application_id', a.id, 'loan_number', v_number));

  UPDATE public.mf_loan_applications SET status = 'ready_for_disbursement', updated_at = now()
   WHERE id = a.id AND status = 'approved';

  RETURN v_loan_id;
END; $$;
REVOKE ALL ON FUNCTION public.mf_create_loan_from_application(uuid, date, date) FROM public;
GRANT EXECUTE ON FUNCTION public.mf_create_loan_from_application(uuid, date, date) TO authenticated;

-- ============ disbursement ============
CREATE OR REPLACE FUNCTION public.mf_disburse_loan(
  p_loan_id uuid,
  p_disbursed_on date,
  p_amount numeric,
  p_method text,
  p_reference text DEFAULT NULL,
  p_source_account_id uuid DEFAULT NULL,
  p_received_by_name text DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l public.mf_loans%ROWTYPE; v_id uuid; v_shift integer;
BEGIN
  SELECT * INTO l FROM public.mf_loans WHERE id = p_loan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found'; END IF;
  IF NOT user_has_business_access(auth.uid(), l.business_id) THEN
    RAISE EXCEPTION 'Not authorised for this institution';
  END IF;
  IF NOT (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin')
       OR has_role(auth.uid(),'branch_manager') OR has_role(auth.uid(),'cashier')) THEN
    RAISE EXCEPTION 'You are not authorised to disburse loans';
  END IF;
  IF l.status <> 'pending_disbursement' THEN
    RAISE EXCEPTION 'This loan is not awaiting disbursement';
  END IF;
  IF EXISTS (SELECT 1 FROM public.mf_loan_disbursements
              WHERE loan_id = p_loan_id AND reversed_at IS NULL) THEN
    RAISE EXCEPTION 'This loan has already been disbursed';
  END IF;
  IF ROUND(p_amount,2) <> ROUND(l.principal,2) THEN
    RAISE EXCEPTION 'Disbursed amount must equal the approved principal';
  END IF;

  INSERT INTO public.mf_loan_disbursements (
    business_id, loan_id, disbursed_on, amount, method, reference,
    source_account_id, received_by_name, notes, disbursed_by)
  VALUES (l.business_id, l.id, p_disbursed_on, p_amount, p_method, p_reference,
          p_source_account_id, p_received_by_name, p_notes, auth.uid())
  RETURNING id INTO v_id;

  -- realign the contractual schedule to the actual disbursement date
  IF l.expected_disbursement_date IS DISTINCT FROM p_disbursed_on THEN
    v_shift := p_disbursed_on - l.expected_disbursement_date;
    UPDATE public.mf_loan_schedule SET due_date = due_date + v_shift, updated_at = now()
     WHERE loan_id = l.id;
  END IF;

  UPDATE public.mf_loans
     SET status = 'active', disbursed_at = now(),
         first_installment_date = (SELECT MIN(due_date) FROM public.mf_loan_schedule WHERE loan_id = l.id),
         updated_at = now()
   WHERE id = l.id;

  INSERT INTO public.mf_loan_events (business_id, loan_id, event_type, actor_id, amount, payload)
  VALUES (l.business_id, l.id, 'loan_disbursed', auth.uid(), p_amount,
          jsonb_build_object('method', p_method, 'reference', p_reference,
                             'disbursed_on', p_disbursed_on, 'disbursement_id', v_id));

  UPDATE public.mf_loan_applications SET status = 'disbursed', updated_at = now()
   WHERE id = l.application_id;

  RETURN v_id;
END; $$;
REVOKE ALL ON FUNCTION public.mf_disburse_loan(uuid, date, numeric, text, text, uuid, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.mf_disburse_loan(uuid, date, numeric, text, text, uuid, text, text) TO authenticated;

CREATE TRIGGER mf_loan_schedule_touch BEFORE UPDATE ON public.mf_loan_schedule
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
