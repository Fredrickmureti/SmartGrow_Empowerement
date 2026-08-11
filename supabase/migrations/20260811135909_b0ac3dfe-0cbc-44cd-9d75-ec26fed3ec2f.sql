DO $$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(format('%I', a.attname), ', ' ORDER BY a.attnum)
    INTO v_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.expenses'::regclass
     AND a.attnum > 0
     AND NOT a.attisdropped
     AND a.attname NOT IN (
       'status','base_amount','exchange_rate','tax_amount','expense_number',
       'journal_entry_id','approved_by','approved_at','submitted_at',
       'reimbursed_at','voided_at','voided_by','reimbursed_by',
       'reimbursed_payslip_id','reimbursed_run_id','reimbursement_queued_at'
     );

  EXECUTE 'REVOKE INSERT ON public.expenses FROM authenticated';
  EXECUTE format('GRANT INSERT (%s) ON public.expenses TO authenticated', v_cols);
END;
$$;

GRANT ALL ON public.expenses TO service_role;