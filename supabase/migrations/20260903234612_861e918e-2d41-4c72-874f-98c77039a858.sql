CREATE TABLE public.mf_loan_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid,
  loan_id uuid NOT NULL REFERENCES public.mf_loans(id) ON DELETE CASCADE,
  installment_no integer NOT NULL,
  kind text NOT NULL DEFAULT 'penalty',
  charged_on date NOT NULL DEFAULT CURRENT_DATE,
  amount numeric(18,2) NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'active',
  accrual_key text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mf_loan_charges_kind_chk CHECK (kind IN ('penalty','fee')),
  CONSTRAINT mf_loan_charges_status_chk CHECK (status IN ('active','reversed')),
  CONSTRAINT mf_loan_charges_amount_chk CHECK (amount > 0)
);

CREATE UNIQUE INDEX mf_loan_charges_accrual_uq
  ON public.mf_loan_charges (loan_id, installment_no, accrual_key)
  WHERE accrual_key IS NOT NULL AND status = 'active';
CREATE INDEX mf_loan_charges_loan_idx ON public.mf_loan_charges (loan_id, installment_no);

GRANT SELECT ON public.mf_loan_charges TO authenticated;
GRANT ALL ON public.mf_loan_charges TO service_role;

ALTER TABLE public.mf_loan_charges ENABLE ROW LEVEL SECURITY;

CREATE POLICY mf_loan_charges_read ON public.mf_loan_charges
FOR SELECT TO authenticated
USING (user_has_business_access(auth.uid(), business_id) AND mf_loan_in_scope(loan_id));

CREATE TRIGGER mf_loan_charges_touch
BEFORE UPDATE ON public.mf_loan_charges
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE VIEW public.mf_loan_penalty_status
WITH (security_invoker = true) AS
SELECT
  c.business_id,
  c.loan_id,
  c.installment_no,
  ROUND(SUM(c.amount), 2) AS penalty_charged,
  ROUND(COALESCE(a.penalty_paid, 0), 2) AS penalty_paid,
  ROUND(SUM(c.amount) - COALESCE(a.penalty_paid, 0), 2) AS penalty_outstanding
FROM public.mf_loan_charges c
LEFT JOIN LATERAL (
  SELECT COALESCE(SUM(al.amount), 0) AS penalty_paid
  FROM public.mf_repayment_allocations al
  JOIN public.mf_repayments r ON r.id = al.repayment_id
  WHERE al.loan_id = c.loan_id
    AND al.installment_no = c.installment_no
    AND al.component = 'penalty'
    AND r.status <> 'reversed'
) a ON true
WHERE c.status = 'active' AND c.kind = 'penalty'
GROUP BY c.business_id, c.loan_id, c.installment_no, a.penalty_paid;

GRANT SELECT ON public.mf_loan_penalty_status TO authenticated;