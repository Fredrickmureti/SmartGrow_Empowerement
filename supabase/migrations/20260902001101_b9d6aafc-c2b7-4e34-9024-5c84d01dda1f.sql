
-- 1. Portfolio scoping helpers -------------------------------------------------
CREATE OR REPLACE FUNCTION public.mf_is_portfolio_restricted(p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT (
    public.has_role(p_user, 'super_admin')
    OR public.has_role(p_user, 'admin')
    OR public.has_role(p_user, 'branch_manager')
    OR public.has_role(p_user, 'accountant')
    OR public.has_role(p_user, 'auditor')
  )
  AND (
    public.has_role(p_user, 'loan_officer')
    OR public.has_role(p_user, 'collections_officer')
  )
$$;

CREATE OR REPLACE FUNCTION public.mf_officer_in_scope(p_officer_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT public.mf_is_portfolio_restricted(auth.uid())
      OR p_officer_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION public.mf_loan_in_scope(p_loan_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT public.mf_is_portfolio_restricted(auth.uid())
      OR EXISTS (
        SELECT 1 FROM public.mf_loans l
        WHERE l.id = p_loan_id AND l.loan_officer_id = auth.uid()
      )
$$;

-- 2. Arrears -------------------------------------------------------------------
CREATE OR REPLACE VIEW public.mf_loan_arrears
WITH (security_invoker = true) AS
SELECT
  s.business_id,
  l.branch_id,
  l.loan_officer_id,
  l.client_id,
  s.loan_id,
  l.loan_number,
  s.installment_no,
  s.due_date,
  s.principal_due,
  s.interest_due,
  s.fees_due,
  s.total_due,
  COALESCE(p.paid, 0)                                        AS total_paid,
  GREATEST(s.total_due - COALESCE(p.paid, 0), 0)             AS balance_due,
  CASE WHEN s.due_date < CURRENT_DATE
       THEN GREATEST(s.total_due - COALESCE(p.paid, 0), 0)
       ELSE 0 END                                            AS arrears_amount,
  CASE WHEN s.due_date < CURRENT_DATE
        AND s.total_due - COALESCE(p.paid, 0) > 0.005
       THEN (CURRENT_DATE - s.due_date)
       ELSE 0 END                                            AS days_past_due
FROM public.mf_loan_schedule s
JOIN public.mf_loans l ON l.id = s.loan_id
LEFT JOIN LATERAL (
  SELECT SUM(a.amount) AS paid
  FROM public.mf_repayment_allocations a
  JOIN public.mf_repayments r ON r.id = a.repayment_id
  WHERE a.loan_id = s.loan_id
    AND a.installment_no = s.installment_no
    AND r.status <> 'reversed'
    AND a.component <> 'advance'
) p ON TRUE
WHERE l.status IN ('active', 'disbursed', 'overdue', 'restructured');

GRANT SELECT ON public.mf_loan_arrears TO authenticated;
GRANT SELECT ON public.mf_loan_arrears TO service_role;

CREATE OR REPLACE VIEW public.mf_par_summary
WITH (security_invoker = true) AS
WITH loan_dpd AS (
  SELECT
    b.business_id,
    b.branch_id,
    b.loan_officer_id,
    b.loan_id,
    b.total_outstanding,
    COALESCE(MAX(a.days_past_due), 0) AS days_past_due
  FROM public.mf_loan_balances b
  LEFT JOIN public.mf_loan_arrears a ON a.loan_id = b.loan_id
  WHERE b.status IN ('active', 'disbursed', 'overdue', 'restructured')
  GROUP BY b.business_id, b.branch_id, b.loan_officer_id, b.loan_id, b.total_outstanding
)
SELECT
  business_id,
  branch_id,
  loan_officer_id,
  COUNT(*)                                                                  AS loan_count,
  SUM(total_outstanding)                                                    AS portfolio_outstanding,
  SUM(total_outstanding) FILTER (WHERE days_past_due >= 1)                  AS par_1,
  SUM(total_outstanding) FILTER (WHERE days_past_due >= 30)                 AS par_30,
  SUM(total_outstanding) FILTER (WHERE days_past_due >= 90)                 AS par_90
FROM loan_dpd
GROUP BY business_id, branch_id, loan_officer_id;

GRANT SELECT ON public.mf_par_summary TO authenticated;
GRANT SELECT ON public.mf_par_summary TO service_role;

-- 3. Collection activities -----------------------------------------------------
CREATE TABLE public.mf_collection_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id),
  loan_id uuid NOT NULL REFERENCES public.mf_loans(id),
  client_id uuid NOT NULL REFERENCES public.mf_clients(id),
  officer_id uuid NOT NULL DEFAULT auth.uid(),
  activity_type text NOT NULL CHECK (activity_type IN ('call','visit','sms','letter','promise_to_pay','field_follow_up','legal_notice','other')),
  activity_at timestamptz NOT NULL DEFAULT now(),
  outcome text CHECK (outcome IS NULL OR outcome IN ('contacted','not_reached','promised','paid','partial','refused','disputed','unreachable','other')),
  promise_amount numeric(18,2) CHECK (promise_amount IS NULL OR promise_amount > 0),
  promise_date date,
  amount_collected numeric(18,2) CHECK (amount_collected IS NULL OR amount_collected >= 0),
  notes text,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancellation_reason text,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mf_collection_activities_loan_idx ON public.mf_collection_activities (loan_id, activity_at DESC);
CREATE INDEX mf_collection_activities_officer_idx ON public.mf_collection_activities (officer_id, activity_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.mf_collection_activities TO authenticated;
GRANT ALL ON public.mf_collection_activities TO service_role;

ALTER TABLE public.mf_collection_activities ENABLE ROW LEVEL SECURITY;

CREATE POLICY mf_collection_activities_read ON public.mf_collection_activities
FOR SELECT USING (
  public.user_has_business_access(auth.uid(), business_id)
  AND public.mf_officer_in_scope(officer_id)
);

CREATE POLICY mf_collection_activities_insert ON public.mf_collection_activities
FOR INSERT WITH CHECK (
  public.user_has_business_access(auth.uid(), business_id)
  AND officer_id = auth.uid()
  AND public.mf_loan_in_scope(loan_id)
);

-- Append-only: the only permitted update is a cancellation by a manager.
CREATE POLICY mf_collection_activities_cancel ON public.mf_collection_activities
FOR UPDATE USING (
  public.user_has_business_access(auth.uid(), business_id)
  AND (
    public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'branch_manager')
  )
) WITH CHECK (
  public.user_has_business_access(auth.uid(), business_id)
);

CREATE OR REPLACE FUNCTION public.mf_collection_activities_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.loan_id IS DISTINCT FROM OLD.loan_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.officer_id IS DISTINCT FROM OLD.officer_id
     OR NEW.activity_type IS DISTINCT FROM OLD.activity_type
     OR NEW.activity_at IS DISTINCT FROM OLD.activity_at
     OR NEW.outcome IS DISTINCT FROM OLD.outcome
     OR NEW.promise_amount IS DISTINCT FROM OLD.promise_amount
     OR NEW.promise_date IS DISTINCT FROM OLD.promise_date
     OR NEW.amount_collected IS DISTINCT FROM OLD.amount_collected
     OR NEW.notes IS DISTINCT FROM OLD.notes
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Collection activities are append-only; record a new activity or cancel this one';
  END IF;
  NEW.updated_at := now();
  IF NEW.cancelled_at IS NOT NULL AND OLD.cancelled_at IS NULL THEN
    NEW.cancelled_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mf_collection_activities_append_only
BEFORE UPDATE ON public.mf_collection_activities
FOR EACH ROW EXECUTE FUNCTION public.mf_collection_activities_append_only();

-- 4. Portfolio scope on existing reads ----------------------------------------
DROP POLICY IF EXISTS mf_loans_read ON public.mf_loans;
CREATE POLICY mf_loans_read ON public.mf_loans
FOR SELECT USING (
  public.user_has_business_access(auth.uid(), business_id)
  AND public.mf_officer_in_scope(loan_officer_id)
);

DROP POLICY IF EXISTS mf_clients_read ON public.mf_clients;
CREATE POLICY mf_clients_read ON public.mf_clients
FOR SELECT USING (
  public.user_has_business_access(auth.uid(), business_id)
  AND public.mf_officer_in_scope(loan_officer_id)
);

DROP POLICY IF EXISTS mf_repayments_read ON public.mf_repayments;
CREATE POLICY mf_repayments_read ON public.mf_repayments
FOR SELECT USING (
  public.user_has_business_access(auth.uid(), business_id)
  AND public.mf_loan_in_scope(loan_id)
);
