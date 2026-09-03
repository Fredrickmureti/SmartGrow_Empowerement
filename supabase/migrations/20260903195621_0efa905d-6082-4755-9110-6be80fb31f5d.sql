CREATE OR REPLACE VIEW public.mf_par_summary
WITH (security_invoker = true) AS
WITH loan_dpd AS (
  SELECT b.business_id,
         b.branch_id,
         b.loan_officer_id,
         b.loan_id,
         b.total_outstanding,
         COALESCE(max(a.days_past_due), 0) AS days_past_due
    FROM public.mf_loan_balances b
    LEFT JOIN public.mf_loan_arrears a ON a.loan_id = b.loan_id
   WHERE b.status = ANY (ARRAY['active','disbursed','overdue','restructured'])
   GROUP BY b.business_id, b.branch_id, b.loan_officer_id, b.loan_id, b.total_outstanding
), agg AS (
  SELECT business_id,
         branch_id,
         loan_officer_id,
         count(*) AS loan_count,
         COALESCE(sum(total_outstanding), 0) AS portfolio_outstanding,
         COALESCE(sum(total_outstanding) FILTER (WHERE days_past_due >= 1), 0) AS par_1,
         COALESCE(sum(total_outstanding) FILTER (WHERE days_past_due >= 30), 0) AS par_30,
         COALESCE(sum(total_outstanding) FILTER (WHERE days_past_due >= 90), 0) AS par_90
    FROM loan_dpd
   GROUP BY business_id, branch_id, loan_officer_id
)
SELECT business_id,
       branch_id,
       loan_officer_id,
       loan_count,
       portfolio_outstanding,
       par_1,
       par_30,
       par_90,
       CASE WHEN portfolio_outstanding > 0
            THEN round((par_1  / portfolio_outstanding) * 100, 2) ELSE 0 END AS par_1_ratio,
       CASE WHEN portfolio_outstanding > 0
            THEN round((par_30 / portfolio_outstanding) * 100, 2) ELSE 0 END AS par_30_ratio,
       CASE WHEN portfolio_outstanding > 0
            THEN round((par_90 / portfolio_outstanding) * 100, 2) ELSE 0 END AS par_90_ratio
  FROM agg;

GRANT SELECT ON public.mf_par_summary TO authenticated;
GRANT ALL ON public.mf_par_summary TO service_role;