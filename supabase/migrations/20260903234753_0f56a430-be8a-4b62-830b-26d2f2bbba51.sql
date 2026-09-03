CREATE OR REPLACE FUNCTION public.mf_accrue_penalties(p_business_id uuid, p_as_of date DEFAULT CURRENT_DATE)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_as_of date := COALESCE(p_as_of, CURRENT_DATE);
  v_key text;
  v_count integer := 0;
  r RECORD;
  v_base numeric(18,2);
  v_amount numeric(18,2);
BEGIN
  IF NOT user_has_business_access(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'You do not have permission to perform this action.';
  END IF;
  v_key := 'accrual:' || to_char(v_as_of, 'YYYY-MM-DD');

  FOR r IN
    SELECT s.loan_id, s.installment_no, s.total_outstanding, s.principal_outstanding,
           l.branch_id, l.penalty_rate, l.penalty_basis,
           (SELECT COALESCE(SUM(x.total_outstanding), 0)
              FROM public.mf_loan_installment_status x
             WHERE x.loan_id = s.loan_id) AS loan_outstanding
      FROM public.mf_loan_installment_status s
      JOIN public.mf_loans l ON l.id = s.loan_id
     WHERE l.business_id = p_business_id
       AND l.status = 'active'
       AND COALESCE(l.penalty_rate, 0) > 0
       AND s.due_date < v_as_of
       AND s.total_outstanding > 0
  LOOP
    v_base := CASE COALESCE(r.penalty_basis, 'overdue_installment')
                WHEN 'overdue_principal'   THEN r.principal_outstanding
                WHEN 'outstanding_balance' THEN r.loan_outstanding
                ELSE r.total_outstanding
              END;
    v_amount := ROUND(COALESCE(v_base, 0) * r.penalty_rate / 100.0, 2);
    IF v_amount <= 0 THEN CONTINUE; END IF;

    INSERT INTO public.mf_loan_charges (
      business_id, branch_id, loan_id, installment_no, kind, charged_on,
      amount, reason, accrual_key, created_by
    ) VALUES (
      p_business_id, r.branch_id, r.loan_id, r.installment_no, 'penalty', v_as_of,
      v_amount,
      format('Late payment penalty (%s%% of %s)', r.penalty_rate, COALESCE(r.penalty_basis, 'overdue_installment')),
      v_key, auth.uid()
    )
    ON CONFLICT DO NOTHING;

    IF FOUND THEN v_count := v_count + 1; END IF;
  END LOOP;

  RETURN v_count;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.mf_accrue_penalties(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mf_accrue_penalties(uuid, date) TO authenticated;