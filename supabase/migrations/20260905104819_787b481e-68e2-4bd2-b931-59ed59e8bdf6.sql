DO $mig$
DECLARE
  d text;
  nd text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mf_post_event';
  IF d IS NULL THEN RAISE EXCEPTION 'mf_post_event not found'; END IF;

  nd := replace(
    d,
    'v_je := public.reverse_journal_entry_atomic(v_orig_je,',
    'v_je := public.void_journal_entry_atomic(v_orig_je,'
  );
  IF nd = d THEN RAISE EXCEPTION 'no reversal call found in mf_post_event'; END IF;

  -- add the remaining arguments of void_journal_entry_atomic to both call sites
  nd := replace(
    nd,
    'format(''Reversal of repayment %s'', COALESCE(ev.payload->>''receipt_number'','''')));',
    'format(''Reversal of repayment %s'', COALESCE(ev.payload->>''receipt_number'','''')),'
    || ' COALESCE(ev.actor_id, auth.uid()), NULL,'
    || ' COALESCE((ev.payload->>''effective_on'')::date, ev.event_at::date, CURRENT_DATE));'
  );
  nd := replace(
    nd,
    'format(''Reversal of disbursement of loan %s'', l.loan_number));',
    'format(''Reversal of disbursement of loan %s'', l.loan_number),'
    || ' COALESCE(ev.actor_id, auth.uid()), NULL,'
    || ' COALESCE((ev.payload->>''effective_on'')::date, ev.event_at::date, CURRENT_DATE));'
  );

  IF nd LIKE '%void_journal_entry_atomic(v_orig_je,%'
     AND nd NOT LIKE '%reverse_journal_entry_atomic%' THEN
    EXECUTE nd;
  ELSE
    RAISE EXCEPTION 'patch did not produce the expected definition';
  END IF;
END
$mig$;