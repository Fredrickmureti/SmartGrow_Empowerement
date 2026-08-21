DO $mig$
DECLARE
  spec jsonb;
  v_def text;
  v_new text;
  v_specs jsonb := jsonb_build_array(
    jsonb_build_object('fn','_landed_cost_post_apply','pat','''main''\s*,\s*v\.branch_id\s*\)','repl','''main'', v.branch_id, false, false)'),
    jsonb_build_object('fn','landed_cost_reverse_voucher','pat','''reversal''\s*,\s*v\.branch_id\s*\)','repl','''reversal'', v.branch_id, false, false)'),
    jsonb_build_object('fn','expense_reimburse_direct','pat','''reimbursement''\s*,\s*r\.branch_id','repl','''reimbursement'', r.branch_id, false, false'),
    jsonb_build_object('fn','bank_match_confirm','pat','''clearing''\s*,\s*_txn\.branch_id','repl','''clearing'', _txn.branch_id, false, false'),
    jsonb_build_object('fn','bank_reconciliation_session_complete','pat','''service_charge''\s*,\s*a\.branch_id\s*\)','repl','''service_charge'', a.branch_id, false, false)'),
    jsonb_build_object('fn','bank_reconciliation_session_writeoff','pat','''writeoff''\s*,\s*a\.branch_id\s*\)','repl','''writeoff'', a.branch_id, false, false)'),
    jsonb_build_object('fn','record_multi_bill_payment','pat','v_currency\s*,\s*v_settle_rate\s*,\s*NULL\s*,\s*_branch_id','repl','v_currency, v_settle_rate, NULL, _branch_id, false, false'),
    jsonb_build_object('fn','record_multi_invoice_payment','pat','v_currency\s*,\s*v_settle_rate\s*,\s*NULL\s*,\s*_branch_id','repl','v_currency, v_settle_rate, NULL, _branch_id, false, false'),
    jsonb_build_object('fn','_bank_account_post_opening_balance','pat','''main''\s*,\s*a\.branch_id\s*,\s*true','repl','''main'', a.branch_id, true, true')
  );
BEGIN
  FOR spec IN SELECT * FROM jsonb_array_elements(v_specs) LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = (spec->>'fn');
    IF v_def IS NULL THEN RAISE EXCEPTION 'function % not found', spec->>'fn'; END IF;
    v_new := regexp_replace(v_def, spec->>'pat', spec->>'repl');
    IF v_new = v_def THEN
      RAISE EXCEPTION 'call fragment not matched in %', spec->>'fn';
    END IF;
    EXECUTE v_new;
  END LOOP;
END
$mig$;