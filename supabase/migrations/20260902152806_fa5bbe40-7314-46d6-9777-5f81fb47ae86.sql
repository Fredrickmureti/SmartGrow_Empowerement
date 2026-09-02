CREATE OR REPLACE FUNCTION public.__v1_lifecycle_proof()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_biz uuid := 'cbc73525-f93c-4d79-9f9a-8d04e12c4f56';
  v_branch uuid := 'd6a52ce8-eab2-43ed-9ab1-aca45dfbd212';
  v_user uuid := '7dbc67b4-08f6-4da5-8311-9e459d8d9446';
  v_cash uuid := '1df3fdf1-bd50-4f35-a38f-cfb9d377172d';
  v_client uuid; v_prod uuid; v_ver uuid; v_app uuid; v_loan uuid; v_succ uuid;
  v_rep1 uuid; v_rep2 uuid; v_ctx text;
  v_log jsonb := '[]'::jsonb;
  v_step text := 'init';
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user::text, 'role','authenticated')::text, true);

  v_step := 'client';
  INSERT INTO mf_clients (business_id, branch_id, client_number, full_name, phone, status, loan_officer_id, created_by)
  VALUES (v_biz, v_branch, 'V1-CLI-001', 'V1 Proof Client', '0700000001', 'active', v_user, v_user)
  RETURNING id INTO v_client;

  v_step := 'product';
  INSERT INTO mf_loan_products (business_id, code, name, status, created_by)
  VALUES (v_biz, 'V1PROD', 'V1 Proof Product', 'active', v_user) RETURNING id INTO v_prod;

  INSERT INTO mf_loan_product_versions (business_id, product_id, version_no, min_amount, max_amount,
    min_term_installments, max_term_installments, repayment_frequency, interest_method,
    interest_rate, interest_rate_period, is_published, published_at, created_by)
  VALUES (v_biz, v_prod, 1, 1000, 500000, 1, 24, 'monthly', 'flat', 12, 'per_annum', true, now(), v_user)
  RETURNING id INTO v_ver;

  UPDATE mf_loan_products SET current_version_id = v_ver WHERE id = v_prod;

  v_step := 'application_draft';
  INSERT INTO mf_loan_applications (business_id, branch_id, application_number, client_id, product_id,
    product_version_id, loan_officer_id, requested_amount, requested_term_installments, purpose,
    status, created_by)
  VALUES (v_biz, v_branch, 'V1-APP-001', v_client, v_prod, v_ver, v_user, 60000, 4, 'V1 proof',
    'draft', v_user)
  RETURNING id INTO v_app;

  v_step := 'application_submit';
  UPDATE mf_loan_applications SET status = 'submitted' WHERE id = v_app;

  v_step := 'application_review';
  UPDATE mf_loan_applications SET status = 'under_review' WHERE id = v_app;

  v_step := 'assessment';
  INSERT INTO mf_application_assessments (business_id, application_id, assessed_by, monthly_income,
    monthly_expenses, recommended_amount, recommended_term_installments, recommendation, notes)
  VALUES (v_biz, v_app, v_user, 40000, 15000, 48000, 4, 'recommend', 'V1 proof assessment');

  v_step := 'application_approve';
  UPDATE mf_loan_applications
     SET status = 'approved', approved_amount = 48000, approved_term_installments = 4
   WHERE id = v_app;

  v_step := 'create_loan';
  v_loan := mf_create_loan_from_application(v_app, CURRENT_DATE, (CURRENT_DATE + 30));
  v_log := v_log || jsonb_build_object('loan', v_loan,
    'schedule_rows', (SELECT count(*) FROM mf_loan_schedule WHERE loan_id = v_loan));

  v_step := 'disburse';
  PERFORM mf_disburse_loan(v_loan, CURRENT_DATE, 48000, 'cash', 'V1-DISB-1', v_cash, 'V1 Proof Client', 'V1 proof');

  v_step := 'repay1';
  v_rep1 := mf_record_repayment(v_loan, CURRENT_DATE, 5000, 'cash', 'V1-RCT-1', NULL, 'partial');
  v_step := 'repay2';
  v_rep2 := mf_record_repayment(v_loan, CURRENT_DATE, 7000, 'cash', 'V1-RCT-2', NULL, 'second');

  v_step := 'reverse';
  PERFORM mf_reverse_repayment(v_rep2, 'V1 proof reversal');

  v_log := v_log || jsonb_build_object('balances_after_reversal',
    (SELECT to_jsonb(b) FROM mf_loan_balances b WHERE b.loan_id = v_loan));

  v_step := 'reissue';
  v_succ := mf_reissue_loan(v_loan, 'topup', 20000, 6, 12, CURRENT_DATE, (CURRENT_DATE + 30), 'V1 proof top-up');

  v_step := 'disburse_successor';
  PERFORM mf_disburse_loan(v_succ, CURRENT_DATE, (SELECT principal FROM mf_loans WHERE id = v_succ),
    'cash', 'V1-DISB-2', v_cash, 'V1 Proof Client', 'V1 proof top-up');

  v_step := 'assert';
  RETURN jsonb_build_object(
    'ok', true,
    'log', v_log,
    'predecessor_status', (SELECT status FROM mf_loans l WHERE l.id = v_loan),
    'successor_status', (SELECT status FROM mf_loans WHERE id = v_succ),
    'unbalanced_entries', (
      SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
        SELECT je.entry_number, SUM(jel.debit) AS line_debit, SUM(jel.credit) AS line_credit
        FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
        WHERE je.source_id IN (SELECT id FROM mf_loan_events WHERE loan_id IN (v_loan, v_succ))
        GROUP BY je.id, je.entry_number
        HAVING SUM(jel.debit) <> SUM(jel.credit)
      ) x),
    'events', (SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', e.event_type, 'posted', p.journal_entry_id IS NOT NULL) ORDER BY e.created_at), '[]'::jsonb)
               FROM mf_loan_events e LEFT JOIN mf_event_postings p ON p.loan_event_id = e.id
               WHERE e.loan_id IN (v_loan, v_succ)),
    'balances', (SELECT COALESCE(jsonb_agg(to_jsonb(b)), '[]'::jsonb) FROM mf_loan_balances b WHERE b.loan_id IN (v_loan, v_succ))
  );
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_ctx = PG_EXCEPTION_CONTEXT;
  RETURN jsonb_build_object('ok', false, 'failed_step', v_step, 'error', SQLERRM, 'sqlstate', SQLSTATE, 'context', v_ctx, 'log', v_log);
END;
$function$;