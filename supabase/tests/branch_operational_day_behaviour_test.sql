-- Branch Operational Day — behavioural invariants (production-safe).
--
-- Companion to branch_operational_day_invariants_test.sql, which asserts
-- structure only. This one exercises the routines themselves: open, date
-- control at the ledger, close, reopen, branch isolation and the
-- zero-activity day.
--
-- SAFETY CONTRACT
--   * No pre-existing row is read-modify-written. Every fixture is new.
--   * Fixtures live under temporary branches named 'ZZTEST-DAY-%' inside the
--     one existing business. No second business, no tenant.
--   * The whole run is one transaction that is deliberately aborted by a
--     sentinel exception carrying the report, so nothing is ever committed.
--   * Protected production tables are digested (md5 over the full row text)
--     before the fixtures are created and again at the end; any drift fails
--     the run by name.
--
-- Run locally with:  supabase test db --file supabase/tests/branch_operational_day_behaviour_test.sql
-- The sentinel exception at the end is the expected outcome.

\set ON_ERROR_STOP on

DO $test$
DECLARE
  r            text[] := ARRAY[]::text[];
  v_org        uuid;
  v_biz        uuid;
  v_owner      uuid;
  v_cash       uuid;
  v_other      uuid;
  v_ctrl       date := CURRENT_DATE - 5;
  a_branch     uuid;
  b_branch     uuid;
  c_branch     uuid;
  a_day        uuid;
  b_day        uuid;
  c_day        uuid;
  v_tmp        uuid;
  v_num        numeric;
  v_txt        text;
  v_txt2       text;
  v_int        integer;
  d_before     jsonb;
  d_after      jsonb;
  v_drift      text := '';
  t            text;
  protected    text[] := ARRAY[
    'journal_entries','journal_entry_lines','accounts','mf_clients','mf_groups',
    'mf_group_meetings','mf_loan_applications','mf_client_charge_payments',
    'mf_fee_collections','mf_repayments','mf_repayment_batches',
    'mf_collection_bankings','branches','branch_operational_days','branch_day_events'];

  v_bool       boolean;
  v_num2       numeric;
BEGIN
  ---------------------------------------------------------------- fixtures ids
  SELECT b.id, b.organization_id, o.owner_user_id
    INTO v_biz, v_org, v_owner
    FROM public.businesses b JOIN public.organizations o ON o.id = b.organization_id
   LIMIT 1;

  SELECT id INTO v_cash FROM public.accounts WHERE code = '1111' AND business_id = v_biz;
  SELECT id INTO v_other FROM public.accounts WHERE code = '1370' AND business_id = v_biz;
  IF v_cash IS NULL OR v_other IS NULL THEN
    RAISE EXCEPTION 'ZZTEST setup: cash/receivable accounts not found';
  END IF;

  ------------------------------------------------------- 0. before-digest
  d_before := '{}'::jsonb;
  FOREACH t IN ARRAY protected LOOP
    EXECUTE format(
      'SELECT COALESCE(md5(string_agg(x.j, %L ORDER BY x.j)), %L) FROM (SELECT row_to_json(s)::text AS j FROM public.%I s) x',
      '|', 'EMPTY') INTO v_txt;
    d_before := d_before || jsonb_build_object(t, v_txt);
  END LOOP;

  ------------------------------------------------------- 1. temp branches
  INSERT INTO public.branches (business_id, organization_id, name, code, is_active, day_control_from, day_variance_tolerance)
  VALUES (v_biz, v_org, 'ZZTEST-DAY-A', 'ZZTA', true, v_ctrl, 0)
  RETURNING id INTO a_branch;
  INSERT INTO public.branches (business_id, organization_id, name, code, is_active, day_control_from, day_variance_tolerance)
  VALUES (v_biz, v_org, 'ZZTEST-DAY-B', 'ZZTB', true, v_ctrl, 0)
  RETURNING id INTO b_branch;
  INSERT INTO public.branches (business_id, organization_id, name, code, is_active, day_control_from, day_variance_tolerance)
  VALUES (v_biz, v_org, 'ZZTEST-DAY-C', 'ZZTC', true, v_ctrl, 100)
  RETURNING id INTO c_branch;

  r := r || format('FIXTURES branchA=%s branchB=%s branchC=%s', a_branch, b_branch, c_branch);

  -- act as the organization owner (claims only; no account row is touched)
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  ------------------------------------------------------- 2. ZERO-ACTIVITY DAY
  -- proven before any financial fixture exists anywhere in this run
  BEGIN
    b_day := public.open_branch_day(b_branch, CURRENT_DATE, 0, 'zzt zero activity');
    PERFORM public.close_branch_day(b_day, 0, NULL, 'zzt zero activity close');
    SELECT status, expected_cash INTO v_txt, v_num
      FROM public.branch_operational_days WHERE id = b_day;
    IF v_txt = 'closed' AND v_num = 0 THEN
      r := r || 'PASS zero-activity: branch with no loans/repayments/collections opened and closed cleanly';
    ELSE
      r := r || format('FAIL zero-activity: status=%s expected_cash=%s', v_txt, v_num);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    r := r || format('FAIL zero-activity: %s', SQLERRM);
  END;

  ------------------------------------------------------- 3. OPENING
  BEGIN
    a_day := public.open_branch_day(a_branch, CURRENT_DATE, 5000, 'zzt open');
    SELECT business_id::text, branch_id::text INTO v_txt, v_txt2 FROM public.branch_operational_days WHERE id = a_day;
    r := r || format('PASS open: day %s created, scope business=%s branch=%s', a_day, v_txt, v_txt2);
  EXCEPTION WHEN OTHERS THEN
    r := r || format('FAIL open: %s', SQLERRM);
  END;

  BEGIN
    PERFORM public.open_branch_day(a_branch, CURRENT_DATE - 1, 0, 'zzt second open');
    r := r || 'FAIL second-open: a second open day was allowed on the same branch';
  EXCEPTION WHEN OTHERS THEN
    r := r || format('PASS second-open refused: %s', SQLERRM);
  END;

  BEGIN
    PERFORM public.open_branch_day(c_branch, CURRENT_DATE + 1, 0, 'zzt future');
    r := r || 'FAIL future-open: a future day was allowed';
  EXCEPTION WHEN OTHERS THEN
    r := r || format('PASS future-open refused: %s', SQLERRM);
  END;

  BEGIN
    PERFORM public.open_branch_day(c_branch, v_ctrl - 1, 0, 'zzt before control');
    r := r || 'FAIL pre-control-open: a date before day control started was allowed';
  EXCEPTION WHEN OTHERS THEN
    r := r || format('PASS pre-control-open refused: %s', SQLERRM);
  END;

  -- unauthorised caller
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', '00000000-0000-4000-8000-000000000001', 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.open_branch_day(c_branch, CURRENT_DATE, 0, 'zzt unauthorised');
    r := r || 'FAIL unauthorised-open: a user without the capability opened a day';
  EXCEPTION WHEN OTHERS THEN
    r := r || format('PASS unauthorised-open refused: %s', SQLERRM);
  END;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  SELECT count(*) INTO v_int FROM public.branch_operational_days
   WHERE branch_id = c_branch;
  IF v_int = 0 THEN
    r := r || 'PASS isolation-open: opening/refusals on other branches left branch C with no day';
  ELSE
    r := r || format('FAIL isolation-open: branch C unexpectedly has %s day row(s)', v_int);
  END IF;

  ------------------------------------------------------- 4. DATING AT THE LEDGER
  -- direct insert into journal_entries: the lowest-level path a caller could
  -- reach, so the guard is proven at the authoritative boundary.
  BEGIN
    INSERT INTO public.journal_entries (organization_id, business_id, branch_id, entry_number,
      entry_date, status, currency, total_debit, total_credit, description)
    VALUES (v_org, v_biz, a_branch, 'ZZTEST-DAY-OK', CURRENT_DATE, 'posted', 'KES', 1200, 1200, 'zzt in-day posting')
    RETURNING id INTO v_tmp;
    INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit, business_id, organization_id, branch_id, description)
    VALUES (v_tmp, v_cash, 1200, 0, v_biz, v_org, a_branch, 'zzt cash in'),
           (v_tmp, v_other, 0, 1200, v_biz, v_org, a_branch, 'zzt contra');
    r := r || format('PASS in-day posting: entry %s accepted for the open day', v_tmp);
  EXCEPTION WHEN OTHERS THEN
    r := r || format('FAIL in-day posting: %s', SQLERRM);
  END;

  BEGIN
    INSERT INTO public.journal_entries (organization_id, business_id, branch_id, entry_number,
      entry_date, status, currency, total_debit, total_credit, description)
    VALUES (v_org, v_biz, a_branch, 'ZZTEST-DAY-NEVER', CURRENT_DATE - 2, 'posted', 'KES', 10, 10, 'zzt never-opened day');
    r := r || 'FAIL never-opened posting: a posting landed on a day that was never opened';
  EXCEPTION WHEN OTHERS THEN
    r := r || format('PASS never-opened posting refused: %s', SQLERRM);
  END;

  BEGIN
    INSERT INTO public.journal_entries (organization_id, business_id, branch_id, entry_number,
      entry_date, status, currency, total_debit, total_credit, description)
    VALUES (v_org, v_biz, c_branch, 'ZZTEST-DAY-XBRANCH', CURRENT_DATE, 'posted', 'KES', 10, 10, 'zzt cross-branch');
    r := r || 'FAIL cross-branch posting: branch C posted while only branch A had an open day';
  EXCEPTION WHEN OTHERS THEN
    r := r || format('PASS cross-branch posting refused: %s', SQLERRM);
  END;

  ------------------------------------------------------- 5. CLOSING
  v_num := public.branch_day_expected_cash(a_day);
  SELECT 5000 + COALESCE(SUM(l.debit - l.credit), 0) INTO v_num2
    FROM public.journal_entry_lines l
    JOIN public.journal_entries je ON je.id = l.journal_entry_id
   WHERE l.account_id = v_cash AND je.branch_id = a_branch
     AND je.entry_date = CURRENT_DATE AND je.status = 'posted';
  IF v_num = v_num2 THEN
    r := r || format('PASS expected-cash: %s = opening 5000 + ledger cash movement', v_num);
  ELSE
    r := r || format('FAIL expected-cash: routine says %s, ledger says %s', v_num, v_num2);
  END IF;

  BEGIN
    PERFORM public.close_branch_day(a_day, v_num - 300, NULL, 'zzt no reason');
    r := r || 'FAIL variance-reason: a cash difference was accepted without a reason';
  EXCEPTION WHEN OTHERS THEN
    r := r || format('PASS variance-reason enforced: %s', SQLERRM);
  END;

  BEGIN
    PERFORM public.close_branch_day(a_day, v_num, NULL, 'zzt clean close');
    SELECT status INTO v_txt
      FROM public.branch_operational_days WHERE id = a_day;
    SELECT count(*) INTO v_int FROM public.branch_day_events
     WHERE operational_day_id = a_day AND event_type = 'closed';
    r := r || format('PASS close: status=%s, close events recorded=%s', v_txt, v_int);
  EXCEPTION WHEN OTHERS THEN
    r := r || format('FAIL close: %s', SQLERRM);
  END;

  -- variance path on branch C (tolerance 100) — exercises the over/short posting
  BEGIN
    c_day := public.open_branch_day(c_branch, CURRENT_DATE, 1000, 'zzt variance day');
    PERFORM public.close_branch_day(c_day, 1050, 'zzt counted 50 over');
    SELECT variance, variance_journal_entry_id IS NOT NULL INTO v_num, v_bool
      FROM public.branch_operational_days WHERE id = c_day;
    r := r || format('PASS variance-close: variance=%s, over/short entry posted=%s', v_num, v_bool);
  EXCEPTION WHEN OTHERS THEN
    r := r || format('FAIL variance-close: %s', SQLERRM);
  END;

  SELECT status INTO v_txt FROM public.branch_operational_days WHERE id = b_day;
  r := r || format('CHECK isolation-close: branch B day still %s after A and C closed', v_txt);

  ------------------------------------------------------- 6. AFTER CLOSING
  BEGIN
    INSERT INTO public.journal_entries (organization_id, business_id, branch_id, entry_number,
      entry_date, status, currency, total_debit, total_credit, description)
    VALUES (v_org, v_biz, a_branch, 'ZZTEST-DAY-CLOSED', CURRENT_DATE, 'posted', 'KES', 10, 10, 'zzt closed-day posting');
    r := r || 'FAIL closed-day posting: a posting landed on a closed day';
  EXCEPTION WHEN OTHERS THEN
    r := r || format('PASS closed-day posting refused: %s', SQLERRM);
  END;

  ------------------------------------------------------- 7. REOPENING
  BEGIN
    PERFORM public.reopen_branch_day(a_day, '   ');
    r := r || 'FAIL reopen-reason: a closed day was reopened without a reason';
  EXCEPTION WHEN OTHERS THEN
    r := r || format('PASS reopen-reason enforced: %s', SQLERRM);
  END;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', '00000000-0000-4000-8000-000000000001', 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.reopen_branch_day(a_day, 'zzt unauthorised reopen');
    r := r || 'FAIL unauthorised-reopen: a user without the capability reopened a closed day';
  EXCEPTION WHEN OTHERS THEN
    r := r || format('PASS unauthorised-reopen refused: %s', SQLERRM);
  END;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  BEGIN
    PERFORM public.reopen_branch_day(a_day, 'zzt late receipt');
    SELECT status INTO v_txt FROM public.branch_operational_days WHERE id = a_day;
    SELECT count(*) INTO v_int FROM public.branch_day_events
     WHERE operational_day_id = a_day AND event_type = 'reopened' AND reason = 'zzt late receipt';
    r := r || format('PASS reopen: status=%s, audited reopen events=%s', v_txt, v_int);
  EXCEPTION WHEN OTHERS THEN
    r := r || format('FAIL reopen: %s', SQLERRM);
  END;

  BEGIN
    INSERT INTO public.journal_entries (organization_id, business_id, branch_id, entry_number,
      entry_date, status, currency, total_debit, total_credit, description)
    VALUES (v_org, v_biz, a_branch, 'ZZTEST-DAY-REOPENED', CURRENT_DATE, 'posted', 'KES', 10, 10, 'zzt after reopen');
    r := r || 'PASS post-reopen posting: the workflow works again after an authorised reopen';
  EXCEPTION WHEN OTHERS THEN
    r := r || format('FAIL post-reopen posting: %s', SQLERRM);
  END;

  SELECT status INTO v_txt FROM public.branch_operational_days WHERE id = b_day;
  r := r || format('CHECK isolation-reopen: branch B day still %s after A was reopened', v_txt);

  ------------------------------------------------------- 8. AFTER-DIGEST
  d_after := '{}'::jsonb;
  FOREACH t IN ARRAY protected LOOP
    IF t IN ('branches','branch_operational_days','branch_day_events') THEN
      EXECUTE format(
        'SELECT COALESCE(md5(string_agg(x.j, %L ORDER BY x.j)), %L) FROM (SELECT row_to_json(s)::text AS j FROM public.%I s WHERE %s) x',
        '|', 'EMPTY', t,
        CASE WHEN t = 'branches'
             THEN format('s.id NOT IN (%L::uuid,%L::uuid,%L::uuid)', a_branch, b_branch, c_branch)
             ELSE format('s.branch_id NOT IN (%L::uuid,%L::uuid,%L::uuid)', a_branch, b_branch, c_branch) END)
        INTO v_txt;
    ELSIF t IN ('journal_entries') THEN
      EXECUTE format(
        'SELECT COALESCE(md5(string_agg(x.j, %L ORDER BY x.j)), %L) FROM (SELECT row_to_json(s)::text AS j FROM public.journal_entries s WHERE s.branch_id IS DISTINCT FROM %L::uuid AND s.branch_id IS DISTINCT FROM %L::uuid AND s.branch_id IS DISTINCT FROM %L::uuid) x',
        '|', 'EMPTY', a_branch, b_branch, c_branch) INTO v_txt;
    ELSIF t = 'journal_entry_lines' THEN
      EXECUTE format(
        'SELECT COALESCE(md5(string_agg(x.j, %L ORDER BY x.j)), %L) FROM (SELECT row_to_json(s)::text AS j FROM public.journal_entry_lines s WHERE s.branch_id IS DISTINCT FROM %L::uuid AND s.branch_id IS DISTINCT FROM %L::uuid AND s.branch_id IS DISTINCT FROM %L::uuid) x',
        '|', 'EMPTY', a_branch, b_branch, c_branch) INTO v_txt;
    ELSE
      EXECUTE format(
        'SELECT COALESCE(md5(string_agg(x.j, %L ORDER BY x.j)), %L) FROM (SELECT row_to_json(s)::text AS j FROM public.%I s) x',
        '|', 'EMPTY', t) INTO v_txt;
    END IF;
    d_after := d_after || jsonb_build_object(t, v_txt);
    IF (d_before ->> t) IS DISTINCT FROM v_txt THEN
      v_drift := v_drift || t || ' ';
    END IF;
  END LOOP;

  IF v_drift = '' THEN
    r := r || 'PASS integrity: every protected production table digests identically before and after';
  ELSE
    r := r || format('FAIL integrity: production rows changed in %s', v_drift);
  END IF;

  ------------------------------------------------------- 9. abort
  RAISE EXCEPTION E'ZZTEST-BRANCH-DAY REPORT\n%', array_to_string(r, E'\n');
END
$test$;
