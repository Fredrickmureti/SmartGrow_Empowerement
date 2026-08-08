-- Recurring invoicing test routines.
-- The billing logic lives in the database engine, so its behavioural tests live
-- there too. The engine suite performs real writes inside a subtransaction that
-- is always rolled back, so it consumes no invoice numbers and leaves no rows.

CREATE OR REPLACE FUNCTION public.test_recurring_calendar()
RETURNS TABLE(test_name text, passed boolean, detail text)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $fn$
  SELECT c.name,
         c.actual = c.expected,
         format('expected %s, got %s', c.expected, c.actual)
  FROM (
    VALUES
      ('monthly: Jan 31 clamps to Feb 28 in a common year',
        public.recurring_next_start('monthly', DATE '2026-01-31', 31), DATE '2026-02-28'),
      ('monthly: Feb 28 returns to the 31st (no permanent drift)',
        public.recurring_next_start('monthly', DATE '2026-02-28', 31), DATE '2026-03-31'),
      ('monthly: Jan 31 clamps to Feb 29 in a leap year',
        public.recurring_next_start('monthly', DATE '2024-01-31', 31), DATE '2024-02-29'),
      ('monthly: Apr 30 anchored on 31 goes to May 31',
        public.recurring_next_start('monthly', DATE '2026-04-30', 31), DATE '2026-05-31'),
      ('monthly: mid-month schedules keep their day',
        public.recurring_next_start('monthly', DATE '2026-03-15', 15), DATE '2026-04-15'),
      ('quarterly: Jan 31 clamps to Apr 30',
        public.recurring_next_start('quarterly', DATE '2026-01-31', 31), DATE '2026-04-30'),
      ('quarterly: Apr 30 anchored on 31 goes to Jul 31',
        public.recurring_next_start('quarterly', DATE '2026-04-30', 31), DATE '2026-07-31'),
      ('yearly: Feb 29 clamps to Feb 28 the next year',
        public.recurring_next_start('yearly', DATE '2024-02-29', 29), DATE '2025-02-28'),
      ('yearly: Feb 28 anchored on 29 reaches Feb 29 in the leap year',
        public.recurring_next_start('yearly', DATE '2027-02-28', 29), DATE '2028-02-29'),
      ('weekly: advances seven days across a month boundary',
        public.recurring_next_start('weekly', DATE '2026-01-31', 31), DATE '2026-02-07'),
      ('biweekly: advances fourteen days',
        public.recurring_next_start('biweekly', DATE '2026-01-31', 31), DATE '2026-02-14'),
      ('period end is the day before the next period starts',
        public.recurring_period_end('monthly', DATE '2026-01-31', 31), DATE '2026-02-27'),
      ('period end covers a full common month',
        public.recurring_period_end('monthly', DATE '2026-01-01', 1), DATE '2026-01-31')
  ) AS c(name, actual, expected);
$fn$;

CREATE OR REPLACE FUNCTION public._rtest(_name text, _passed boolean, _detail text DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT jsonb_build_array(jsonb_build_object(
    'test_name', _name, 'passed', COALESCE(_passed, false), 'detail', _detail));
$fn$;

CREATE OR REPLACE FUNCTION public._recurring_engine_scenarios()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  r jsonb := '[]'::jsonb;
  v_org uuid; v_biz uuid; v_cur text; v_cust uuid;
  t_dup uuid; t_fail uuid; t_end uuid; t_post uuid; t_ok uuid;
  res jsonb; res2 jsonb; res3 jsonb;
  v_int int; v_active boolean; v_completed timestamptz; v_next date;
  v_inv uuid; v_je uuid; v_ps date; v_pe date;
  v_debit numeric; v_credit numeric; v_ar uuid; v_ar_debit numeric;
  v_status text; v_reason text;
BEGIN
  SELECT b.id, b.organization_id, COALESCE(b.base_currency, 'KES')
    INTO v_biz, v_org, v_cur
    FROM public.businesses b ORDER BY b.created_at LIMIT 1;

  SELECT c.id INTO v_cust
    FROM public.contacts c
   WHERE c.business_id = v_biz AND c.type IN ('customer', 'both')
   ORDER BY c.created_at LIMIT 1;

  IF v_biz IS NULL OR v_cust IS NULL THEN
    RETURN public._rtest('fixtures', false, 'no business or customer available to test against');
  END IF;

  -- Structural guarantee behind concurrency safety: the occurrence key is unique,
  -- so two racing transactions cannot both insert a run for the same period.
  r := r || public._rtest(
    'concurrency: (template, period_start) is uniquely indexed',
    EXISTS (
      SELECT 1 FROM pg_index i
        JOIN pg_class c ON c.oid = i.indrelid
       WHERE c.relname = 'recurring_invoice_runs' AND i.indisunique
         AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
                FROM unnest(i.indkey) k JOIN pg_attribute a
                  ON a.attrelid = c.oid AND a.attnum = k)
             = ARRAY['period_start', 'recurring_invoice_id']),
    'unique index enforces one run row per billing period');

  ---------------------------------------------------------------- generation
  INSERT INTO public.recurring_invoices (
    organization_id, business_id, contact_id, template_name, frequency,
    start_date, next_run_date, days_before_due, currency, is_active,
    auto_confirm, auto_send)
  VALUES (v_org, v_biz, v_cust, 'TEST dedupe', 'monthly',
          DATE '2026-01-01', DATE '2026-01-01', 14, v_cur, true, false, false)
  RETURNING id INTO t_dup;

  INSERT INTO public.recurring_invoice_items (
    recurring_invoice_id, description, quantity, unit_price, tax_rate, sort_order)
  VALUES (t_dup, 'Monthly retainer', 1, 1000, 0, 0);

  res  := public.generate_recurring_invoice_occurrence(t_dup, DATE '2026-01-01', NULL, 'test');
  res2 := public.generate_recurring_invoice_occurrence(t_dup, DATE '2026-01-01', NULL, 'test');

  SELECT count(*) INTO v_int FROM public.invoices WHERE source_recurring_id = t_dup;

  r := r || public._rtest('generation: a due occurrence produces an invoice',
        res->>'status' = 'generated', res::text);

  r := r || public._rtest('idempotency: repeating the same period yields one invoice',
        v_int = 1 AND (res2->>'duplicate')::boolean
        AND res2->>'invoice_id' = res->>'invoice_id',
        format('invoices=%s, second call=%s', v_int, res2::text));

  SELECT billing_period_start, billing_period_end, due_date IS NOT NULL
    INTO v_ps, v_pe, v_active
    FROM public.invoices WHERE source_recurring_id = t_dup LIMIT 1;

  r := r || public._rtest('billing period: the invoice records the period it covers',
        v_ps = DATE '2026-01-01' AND v_pe = DATE '2026-01-31',
        format('period %s..%s', v_ps, v_pe));

  SELECT next_run_date, invoices_generated INTO v_next, v_int
    FROM public.recurring_invoices WHERE id = t_dup;

  r := r || public._rtest('schedule: advances exactly once for one occurrence',
        v_next = DATE '2026-02-01' AND v_int = 1,
        format('next_run_date=%s, invoices_generated=%s', v_next, v_int));

  -------------------------------------------------------------- crash-resume
  -- A crash before commit loses the invoice but the claimed run may survive a
  -- retry path; replaying the period must still leave exactly one invoice.
  UPDATE public.recurring_invoice_runs
     SET status = 'failed', invoice_id = NULL, invoice_number = NULL,
         failure_reason = 'simulated crash'
   WHERE recurring_invoice_id = t_dup;
  DELETE FROM public.invoice_items
   WHERE invoice_id IN (SELECT id FROM public.invoices WHERE source_recurring_id = t_dup);
  DELETE FROM public.invoices WHERE source_recurring_id = t_dup;

  res3 := public.generate_recurring_invoice_occurrence(t_dup, DATE '2026-01-01', NULL, 'test');
  SELECT count(*) INTO v_int FROM public.invoices WHERE source_recurring_id = t_dup;
  SELECT count(*) INTO v_active FROM public.recurring_invoice_runs
   WHERE recurring_invoice_id = t_dup AND period_start = DATE '2026-01-01';

  r := r || public._rtest('crash-resume: replaying an interrupted period does not duplicate',
        v_int = 1 AND res3->>'status' = 'generated',
        format('invoices=%s, result=%s', v_int, res3::text));

  ------------------------------------------------------------------- failure
  INSERT INTO public.recurring_invoices (
    organization_id, business_id, contact_id, template_name, frequency,
    start_date, next_run_date, currency, is_active, auto_confirm)
  VALUES (v_org, v_biz, v_cust, 'TEST broken', 'monthly',
          DATE '2026-01-01', DATE '2026-01-01', v_cur, true, false)
  RETURNING id INTO t_fail;

  res := public.generate_recurring_invoice_occurrence(t_fail, DATE '2026-01-01', NULL, 'test');
  SELECT next_run_date INTO v_next FROM public.recurring_invoices WHERE id = t_fail;
  SELECT status, failure_reason INTO v_status, v_reason
    FROM public.recurring_invoice_runs
   WHERE recurring_invoice_id = t_fail AND period_start = DATE '2026-01-01';

  r := r || public._rtest('failure: a broken template leaves the schedule untouched',
        res->>'status' = 'failed' AND v_next = DATE '2026-01-01',
        format('result=%s, next_run_date=%s', res->>'status', v_next));

  r := r || public._rtest('audit: the failure is recorded with a reason',
        v_status = 'failed' AND v_reason IS NOT NULL, COALESCE(v_reason, '<null>'));

  r := r || public._rtest('failure: no invoice is left behind',
        NOT EXISTS (SELECT 1 FROM public.invoices WHERE source_recurring_id = t_fail),
        'rolled back to the claim');

  ----------------------------------------------------------------- isolation
  INSERT INTO public.recurring_invoices (
    organization_id, business_id, contact_id, template_name, frequency,
    start_date, next_run_date, currency, is_active, auto_confirm)
  VALUES (v_org, v_biz, v_cust, 'TEST healthy neighbour', 'monthly',
          DATE '2026-01-01', DATE '2026-01-01', v_cur, true, false)
  RETURNING id INTO t_ok;
  INSERT INTO public.recurring_invoice_items (
    recurring_invoice_id, description, quantity, unit_price, tax_rate)
  VALUES (t_ok, 'Support plan', 2, 500, 0);

  res := public.generate_recurring_invoice_occurrence(t_ok, DATE '2026-01-01', NULL, 'test');
  r := r || public._rtest('isolation: one broken template does not block another',
        res->>'status' = 'generated', res->>'status');

  ------------------------------------------------------------------ end date
  INSERT INTO public.recurring_invoices (
    organization_id, business_id, contact_id, template_name, frequency,
    start_date, next_run_date, end_date, currency, is_active, auto_confirm)
  VALUES (v_org, v_biz, v_cust, 'TEST end date', 'monthly',
          DATE '2026-01-01', DATE '2026-01-01', DATE '2026-02-15', v_cur, true, false)
  RETURNING id INTO t_end;
  INSERT INTO public.recurring_invoice_items (
    recurring_invoice_id, description, quantity, unit_price, tax_rate)
  VALUES (t_end, 'Fixed term service', 1, 750, 0);

  res  := public.generate_recurring_invoice_occurrence(t_end, DATE '2026-01-01', NULL, 'test');
  SELECT is_active INTO v_active FROM public.recurring_invoices WHERE id = t_end;
  r := r || public._rtest('end date: the schedule stays active before the last period',
        res->>'status' = 'generated' AND v_active, format('active=%s', v_active));

  res2 := public.generate_recurring_invoice_occurrence(t_end, DATE '2026-02-01', NULL, 'test');
  SELECT is_active, completed_at INTO v_active, v_completed
    FROM public.recurring_invoices WHERE id = t_end;
  SELECT count(*) INTO v_int FROM public.invoices WHERE source_recurring_id = t_end;

  r := r || public._rtest('end date: the final due period is billed, then the schedule completes',
        res2->>'status' = 'generated' AND v_int = 2
        AND v_active IS FALSE AND v_completed IS NOT NULL,
        format('invoices=%s, active=%s, completed_at=%s', v_int, v_active, v_completed));

  res3 := public.generate_recurring_invoice_occurrence(t_end, DATE '2026-03-01', NULL, 'test');
  SELECT count(*) INTO v_int FROM public.invoices WHERE source_recurring_id = t_end;
  r := r || public._rtest('end date: periods past the end date are refused',
        res3->>'status' = 'failed' AND v_int = 2, res3->>'error');

  ----------------------------------------------------------------- accounting
  INSERT INTO public.recurring_invoices (
    organization_id, business_id, contact_id, template_name, frequency,
    start_date, next_run_date, currency, is_active, auto_confirm)
  VALUES (v_org, v_biz, v_cust, 'TEST auto post', 'monthly',
          DATE '2026-01-01', DATE '2026-01-01', v_cur, true, true)
  RETURNING id INTO t_post;
  INSERT INTO public.recurring_invoice_items (
    recurring_invoice_id, description, quantity, unit_price, tax_rate)
  VALUES (t_post, 'Hosting', 1, 10000, 16);

  res := public.generate_recurring_invoice_occurrence(t_post, DATE '2026-01-01', NULL, 'test');
  v_inv := NULLIF(res->>'invoice_id', '')::uuid;
  v_je  := NULLIF(res->>'journal_entry_id', '')::uuid;

  r := r || public._rtest('auto-confirm: the occurrence posts to the ledger',
        res->>'status' = 'posted' AND v_je IS NOT NULL, res::text);

  IF v_je IS NOT NULL THEN
    SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
      INTO v_debit, v_credit
      FROM public.journal_entry_lines WHERE journal_entry_id = v_je;

    v_ar := public.get_default_account_id(v_org, v_biz, 'accounts_receivable');
    SELECT COALESCE(SUM(debit), 0) INTO v_ar_debit
      FROM public.journal_entry_lines
     WHERE journal_entry_id = v_je AND account_id = v_ar;

    r := r || public._rtest('accounting: the journal entry balances',
          v_debit = v_credit AND v_debit > 0, format('dr=%s cr=%s', v_debit, v_credit));

    r := r || public._rtest('accounting: receivable equals the invoice total (11600 = 10000 + 16%)',
          v_ar_debit = 11600, format('AR debit=%s', v_ar_debit));

    r := r || public._rtest('accounting: the entry is sourced from the invoice like a manual one',
          EXISTS (SELECT 1 FROM public.journal_entries je
                   WHERE je.id = v_je AND je.source_type = 'invoice' AND je.source_id = v_inv),
          'source_type=invoice');

    SELECT status INTO v_status FROM public.invoices WHERE id = v_inv;
    r := r || public._rtest('auto-confirm: the invoice is confirmed and linked to its entry',
          v_status = 'confirmed'
          AND EXISTS (SELECT 1 FROM public.invoices WHERE id = v_inv AND journal_entry_id = v_je),
          COALESCE(v_status, '<null>'));
  END IF;

  ------------------------------------------------------------------ traceability
  r := r || public._rtest('traceability: every generated invoice points back to its template',
        NOT EXISTS (
          SELECT 1 FROM public.recurring_invoice_runs run
            JOIN public.invoices i ON i.id = run.invoice_id
           WHERE run.recurring_invoice_id IN (t_dup, t_ok, t_end, t_post)
             AND i.source_recurring_id IS DISTINCT FROM run.recurring_invoice_id),
        'source_recurring_id set on every run invoice');

  RETURN r;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.test_recurring_invoicing_engine()
RETURNS TABLE(test_name text, passed boolean, detail text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_results jsonb;
  v_detail text;
BEGIN
  -- Everything the scenarios write happens in this subtransaction and is undone
  -- by the deliberate exception, so the suite is safe to run against live data.
  BEGIN
    v_results := public._recurring_engine_scenarios();
    RAISE EXCEPTION 'recurring_test_rollback' USING DETAIL = v_results::text;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'recurring_test_rollback' THEN
      GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
      v_results := v_detail::jsonb;
    ELSE
      v_results := jsonb_build_array(jsonb_build_object(
        'test_name', 'harness', 'passed', false, 'detail', SQLERRM));
    END IF;
  END;

  RETURN QUERY
  SELECT x->>'test_name', (x->>'passed')::boolean, x->>'detail'
    FROM jsonb_array_elements(v_results) x;
END;
$fn$;

REVOKE ALL ON FUNCTION public._recurring_engine_scenarios() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.test_recurring_invoicing_engine() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.test_recurring_calendar() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._recurring_engine_scenarios() TO service_role;
GRANT EXECUTE ON FUNCTION public.test_recurring_invoicing_engine() TO service_role;
GRANT EXECUTE ON FUNCTION public.test_recurring_calendar() TO service_role;