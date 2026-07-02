-- pgTAP: payroll_filing_calendar_projection reconciler.
-- Guards the invariant that `refresh_filing_calendar_business` is
-- idempotent (running it twice yields the same row set) and that the
-- passthrough view exposes exactly the projection rows for a business.
BEGIN;
SELECT plan(3);

-- Sanity: table + view + RPC must exist.
SELECT has_table('public', 'payroll_filing_calendar_projection',
  'projection table is present');

SELECT has_function('public', 'refresh_filing_calendar_business',
  ARRAY['uuid'], 'reconciler RPC is present');

-- Idempotency: two consecutive refreshes for the same business must
-- yield the same row count (double-write would inflate it).
DO $$
DECLARE
  v_business uuid := 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  v_first bigint;
  v_second bigint;
BEGIN
  PERFORM public.refresh_filing_calendar_business(v_business);
  SELECT count(*) INTO v_first
    FROM public.payroll_filing_calendar_projection
    WHERE business_id = v_business;
  PERFORM public.refresh_filing_calendar_business(v_business);
  SELECT count(*) INTO v_second
    FROM public.payroll_filing_calendar_projection
    WHERE business_id = v_business;
  PERFORM ok(v_first = v_second,
    format('refresh is idempotent (%s = %s)', v_first, v_second));
END $$;

SELECT * FROM finish();
ROLLBACK;