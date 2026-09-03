CREATE VIEW public.mf_client_statement
WITH (security_invoker = on) AS
SELECT
  d.id                                   AS entry_id,
  l.business_id,
  l.branch_id,
  l.client_id,
  l.id                                   AS loan_id,
  l.loan_number,
  l.currency_code,
  d.disbursed_on                         AS entry_date,
  'disbursement'::text                   AS entry_type,
  'Loan disbursed'::text                 AS description,
  d.method,
  d.reference,
  d.amount                               AS amount_out,
  0::numeric                             AS amount_in
FROM public.mf_loan_disbursements d
JOIN public.mf_loans l ON l.id = d.loan_id
WHERE d.reversed_at IS NULL

UNION ALL

SELECT
  r.id                                   AS entry_id,
  l.business_id,
  l.branch_id,
  l.client_id,
  l.id                                   AS loan_id,
  l.loan_number,
  l.currency_code,
  r.paid_on                              AS entry_date,
  'repayment'::text                      AS entry_type,
  'Repayment received'::text             AS description,
  r.method,
  COALESCE(r.reference, r.receipt_number) AS reference,
  0::numeric                             AS amount_out,
  r.amount                               AS amount_in
FROM public.mf_repayments r
JOIN public.mf_loans l ON l.id = r.loan_id
WHERE r.reversed_at IS NULL AND r.status <> 'reversed';

GRANT SELECT ON public.mf_client_statement TO authenticated;
GRANT SELECT ON public.mf_client_statement TO service_role;