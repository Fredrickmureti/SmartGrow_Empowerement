-- Presentational split of the contractual schedule.
--
-- For loans whose interest is withheld at disbursement the stored schedule
-- carries the gross instalment as principal and zero interest (that is the
-- cash contract). Statements and the schedule screen must still show the
-- borrower's principal/interest split, so it is derived here from the same
-- numbers the recognition engine uses: the withheld interest spread evenly
-- across the instalments with the residual on the last one.
--
-- Read-only. No posting, balance or stored row depends on this view.
CREATE OR REPLACE VIEW public.mf_loan_schedule_display
WITH (security_invoker = on) AS
SELECT
  s.id,
  s.business_id,
  s.loan_id,
  s.installment_no,
  s.due_date,
  s.opening_balance,
  s.principal_due,
  s.interest_due,
  s.fees_due,
  s.total_due,
  s.closing_balance,
  s.is_grace,
  ROUND(s.principal_due - slice.interest_component, 2) AS principal_component,
  ROUND(s.interest_due + slice.interest_component, 2)  AS interest_component,
  COALESCE(rel.recognised_amount, 0)::numeric(18,2)    AS interest_recognised,
  rel.recognised_amount IS NOT NULL                    AS is_interest_recognised
FROM public.mf_loan_schedule s
JOIN public.mf_loans l ON l.id = s.loan_id
LEFT JOIN LATERAL (
  SELECT ROUND(COALESCE(d.upfront_interest, 0), 2) AS total
    FROM public.mf_loan_disbursements d
   WHERE d.loan_id = s.loan_id AND d.reversed_at IS NULL
   ORDER BY d.disbursed_on DESC
   LIMIT 1
) disb ON TRUE
CROSS JOIN LATERAL (
  SELECT (SELECT COUNT(*) FROM public.mf_loan_schedule x WHERE x.loan_id = s.loan_id) AS terms
) t
CROSS JOIN LATERAL (
  SELECT CASE
           WHEN COALESCE(l.interest_collection, 'with_installments') <> 'deducted_upfront'
             OR COALESCE(disb.total, 0) <= 0
             OR t.terms = 0
           THEN 0::numeric
           WHEN s.installment_no = t.terms
           THEN ROUND(disb.total - ROUND(disb.total / t.terms, 2) * (t.terms - 1), 2)
           ELSE ROUND(disb.total / t.terms, 2)
         END AS interest_component
) slice
LEFT JOIN LATERAL (
  SELECT SUM(r.amount)::numeric(18,2) AS recognised_amount
    FROM public.mf_deferred_interest_releases r
   WHERE r.loan_id = s.loan_id
     AND r.installment_no = s.installment_no
     AND r.reversed_at IS NULL
  HAVING COUNT(*) > 0
) rel ON TRUE;

COMMENT ON VIEW public.mf_loan_schedule_display IS
  'Contractual schedule with the principal/interest split shown to borrowers on upfront-interest loans. Presentation only — never a posting source.';

GRANT SELECT ON public.mf_loan_schedule_display TO authenticated;
GRANT ALL ON public.mf_loan_schedule_display TO service_role;