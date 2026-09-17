CREATE OR REPLACE VIEW public.mf_loan_balances AS
 SELECT l.id AS loan_id,
    l.business_id,
    l.branch_id,
    l.client_id,
    l.loan_officer_id,
    l.loan_number,
    l.status,
    l.currency_code,
    l.principal,
    COALESCE(sum(i.principal_outstanding) FILTER (WHERE (l.status = ANY (ARRAY['active'::text, 'pending_disbursement'::text])) AND l.settled_by_loan_id IS NULL), 0::numeric) AS principal_outstanding,
    COALESCE(sum(i.interest_outstanding) FILTER (WHERE (l.status = ANY (ARRAY['active'::text, 'pending_disbursement'::text])) AND l.settled_by_loan_id IS NULL), 0::numeric) AS interest_outstanding,
    COALESCE(sum(i.fees_outstanding) FILTER (WHERE (l.status = ANY (ARRAY['active'::text, 'pending_disbursement'::text])) AND l.settled_by_loan_id IS NULL), 0::numeric) AS fees_outstanding,
    COALESCE(sum(i.total_outstanding) FILTER (WHERE (l.status = ANY (ARRAY['active'::text, 'pending_disbursement'::text])) AND l.settled_by_loan_id IS NULL), 0::numeric) AS total_outstanding,
    COALESCE(sum(i.total_due), 0::numeric) AS total_contractual,
    COALESCE(sum(i.total_outstanding) FILTER (WHERE i.due_date < CURRENT_DATE AND (l.status = ANY (ARRAY['active'::text, 'pending_disbursement'::text])) AND l.settled_by_loan_id IS NULL), 0::numeric) AS amount_overdue,
    COALESCE(max(CURRENT_DATE - i.due_date) FILTER (WHERE i.due_date < CURRENT_DATE AND i.total_outstanding > 0::numeric AND (l.status = ANY (ARRAY['active'::text, 'pending_disbursement'::text])) AND l.settled_by_loan_id IS NULL), 0) AS days_past_due,
    min(i.due_date) FILTER (WHERE i.total_outstanding > 0::numeric AND (l.status = ANY (ARRAY['active'::text, 'pending_disbursement'::text])) AND l.settled_by_loan_id IS NULL) AS next_due_date,
    -- Interest withheld at payout that has not yet been earned. Zero for loans
    -- whose interest is collected with the instalments.
    u.unearned_interest,
    -- Contractual balance less the unearned slice: the borrower's obligation
    -- net of interest the institution has not yet earned.
    GREATEST(
      COALESCE(sum(i.principal_outstanding) FILTER (WHERE (l.status = ANY (ARRAY['active'::text, 'pending_disbursement'::text])) AND l.settled_by_loan_id IS NULL), 0::numeric)
      - u.unearned_interest, 0::numeric)::numeric(18,2) AS net_principal_outstanding
   FROM mf_loans l
     LEFT JOIN mf_loan_installment_status i ON i.loan_id = l.id
     CROSS JOIN LATERAL (
       SELECT GREATEST(
                ROUND(COALESCE((SELECT d.upfront_interest FROM mf_loan_disbursements d
                                 WHERE d.loan_id = l.id AND d.reversed_at IS NULL
                                 ORDER BY d.disbursed_on DESC LIMIT 1), 0::numeric), 2)
                - ROUND(COALESCE((SELECT sum(r.amount) FROM mf_deferred_interest_releases r
                                   WHERE r.loan_id = l.id AND r.reversed_at IS NULL), 0::numeric), 2),
                0::numeric)::numeric(18,2) AS unearned_interest
     ) u
  GROUP BY l.id, u.unearned_interest;