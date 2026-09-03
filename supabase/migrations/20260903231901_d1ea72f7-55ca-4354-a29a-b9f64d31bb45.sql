-- M8 reporting views: officer/branch collections, product performance, client exposure, PAR aging.
CREATE OR REPLACE VIEW public.mf_collections_by_officer
WITH (security_invoker = true) AS
SELECT r.business_id,
       r.branch_id,
       l.loan_officer_id,
       r.paid_on,
       count(*)::bigint            AS receipt_count,
       count(DISTINCT r.client_id)::bigint AS client_count,
       COALESCE(sum(r.amount), 0)  AS amount_collected,
       COALESCE(sum(r.amount) FILTER (WHERE r.method = 'cash'), 0)         AS cash_collected,
       COALESCE(sum(r.amount) FILTER (WHERE r.method = 'mobile_money'), 0) AS mobile_money_collected,
       COALESCE(sum(r.amount) FILTER (WHERE r.method NOT IN ('cash','mobile_money')), 0) AS other_collected
FROM public.mf_repayments r
JOIN public.mf_loans l ON l.id = r.loan_id
WHERE r.status = 'posted'
GROUP BY r.business_id, r.branch_id, l.loan_officer_id, r.paid_on;

CREATE OR REPLACE VIEW public.mf_collections_by_branch
WITH (security_invoker = true) AS
SELECT r.business_id,
       r.branch_id,
       r.paid_on,
       count(*)::bigint            AS receipt_count,
       count(DISTINCT r.client_id)::bigint AS client_count,
       COALESCE(sum(r.amount), 0)  AS amount_collected,
       COALESCE(sum(r.amount) FILTER (WHERE r.method = 'cash'), 0)         AS cash_collected,
       COALESCE(sum(r.amount) FILTER (WHERE r.method = 'mobile_money'), 0) AS mobile_money_collected,
       COALESCE(sum(r.amount) FILTER (WHERE r.method NOT IN ('cash','mobile_money')), 0) AS other_collected
FROM public.mf_repayments r
WHERE r.status = 'posted'
GROUP BY r.business_id, r.branch_id, r.paid_on;

CREATE OR REPLACE VIEW public.mf_product_performance
WITH (security_invoker = true) AS
WITH loan_stats AS (
  SELECT l.business_id,
         l.product_id,
         l.id AS loan_id,
         l.principal,
         l.status,
         b.total_outstanding,
         b.amount_overdue,
         b.days_past_due,
         d.disbursed_amount
  FROM public.mf_loans l
  LEFT JOIN public.mf_loan_balances b ON b.loan_id = l.id
  LEFT JOIN (
    SELECT loan_id, COALESCE(sum(amount), 0) AS disbursed_amount
    FROM public.mf_loan_disbursements
    GROUP BY loan_id
  ) d ON d.loan_id = l.id
)
SELECT s.business_id,
       s.product_id,
       p.code  AS product_code,
       p.name  AS product_name,
       count(*)::bigint AS loan_count,
       count(*) FILTER (WHERE s.status IN ('active','disbursed','overdue','restructured'))::bigint AS active_loan_count,
       count(*) FILTER (WHERE s.status = 'closed')::bigint      AS closed_loan_count,
       count(*) FILTER (WHERE s.status = 'written_off')::bigint  AS written_off_loan_count,
       COALESCE(sum(s.principal), 0)          AS principal_contracted,
       COALESCE(sum(s.disbursed_amount), 0)   AS principal_disbursed,
       COALESCE(sum(s.total_outstanding), 0)  AS outstanding,
       COALESCE(sum(s.amount_overdue), 0)     AS amount_overdue,
       COALESCE(max(s.days_past_due), 0)      AS worst_days_past_due
FROM loan_stats s
JOIN public.mf_loan_products p ON p.id = s.product_id
GROUP BY s.business_id, s.product_id, p.code, p.name;

CREATE OR REPLACE VIEW public.mf_client_exposure
WITH (security_invoker = true) AS
SELECT c.business_id,
       c.branch_id,
       c.loan_officer_id,
       c.id AS client_id,
       c.client_number,
       c.full_name,
       c.status AS client_status,
       count(b.loan_id) FILTER (WHERE b.status IN ('active','disbursed','overdue','restructured'))::bigint AS active_loan_count,
       COALESCE(sum(b.principal_outstanding) FILTER (WHERE b.status IN ('active','disbursed','overdue','restructured')), 0) AS principal_outstanding,
       COALESCE(sum(b.interest_outstanding)  FILTER (WHERE b.status IN ('active','disbursed','overdue','restructured')), 0) AS interest_outstanding,
       COALESCE(sum(b.fees_outstanding)      FILTER (WHERE b.status IN ('active','disbursed','overdue','restructured')), 0) AS fees_outstanding,
       COALESCE(sum(b.total_outstanding)     FILTER (WHERE b.status IN ('active','disbursed','overdue','restructured')), 0) AS total_outstanding,
       COALESCE(sum(b.amount_overdue)        FILTER (WHERE b.status IN ('active','disbursed','overdue','restructured')), 0) AS amount_overdue,
       COALESCE(max(b.days_past_due)         FILTER (WHERE b.status IN ('active','disbursed','overdue','restructured')), 0) AS worst_days_past_due,
       min(b.next_due_date)                  FILTER (WHERE b.status IN ('active','disbursed','overdue','restructured')) AS next_due_date
FROM public.mf_clients c
LEFT JOIN public.mf_loan_balances b ON b.client_id = c.id
GROUP BY c.business_id, c.branch_id, c.loan_officer_id, c.id, c.client_number, c.full_name, c.status;

CREATE OR REPLACE VIEW public.mf_par_aging
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
  WHERE b.status IN ('active','disbursed','overdue','restructured')
  GROUP BY b.business_id, b.branch_id, b.loan_officer_id, b.loan_id, b.total_outstanding
)
SELECT business_id,
       branch_id,
       loan_officer_id,
       count(*)::bigint AS loan_count,
       COALESCE(sum(total_outstanding), 0) AS portfolio_outstanding,
       COALESCE(sum(total_outstanding) FILTER (WHERE days_past_due = 0), 0) AS current_outstanding,
       COALESCE(sum(total_outstanding) FILTER (WHERE days_past_due BETWEEN 1 AND 30), 0)  AS bucket_1_30,
       COALESCE(sum(total_outstanding) FILTER (WHERE days_past_due BETWEEN 31 AND 60), 0) AS bucket_31_60,
       COALESCE(sum(total_outstanding) FILTER (WHERE days_past_due BETWEEN 61 AND 90), 0) AS bucket_61_90,
       COALESCE(sum(total_outstanding) FILTER (WHERE days_past_due > 90), 0) AS bucket_90_plus,
       count(*) FILTER (WHERE days_past_due >= 1)::bigint AS loans_in_arrears
FROM loan_dpd
GROUP BY business_id, branch_id, loan_officer_id;

GRANT SELECT ON public.mf_collections_by_officer TO authenticated;
GRANT SELECT ON public.mf_collections_by_branch TO authenticated;
GRANT SELECT ON public.mf_product_performance TO authenticated;
GRANT SELECT ON public.mf_client_exposure TO authenticated;
GRANT SELECT ON public.mf_par_aging TO authenticated;
GRANT SELECT ON public.mf_collections_by_officer TO service_role;
GRANT SELECT ON public.mf_collections_by_branch TO service_role;
GRANT SELECT ON public.mf_product_performance TO service_role;
GRANT SELECT ON public.mf_client_exposure TO service_role;
GRANT SELECT ON public.mf_par_aging TO service_role;