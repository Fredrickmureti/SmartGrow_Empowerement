-- Phase 3.4 (Correction Delta Engine) — functional test for the
-- inversion RPC `payroll_invert_correction_adjustments` and the
-- ledger UPSERT idempotency that the engine in
-- `supabase/functions/compute-payroll/index.ts` relies on.
--
-- Functional, not structural: it seeds two payroll runs (original
-- correction + its reversal), a garnishment, and forward ledger rows,
-- then calls the RPC and asserts:
--   (1) the RPC inserts negated ledger rows on the reversal run,
--   (2) calling it twice does not double-invert (ON CONFLICT DO NOTHING),
--   (3) garnishments.total_paid is decremented by the forward delta and
--       clamped at zero (never negative).
--
-- Wrapped in BEGIN/ROLLBACK — no rows persist after the run.

BEGIN;
SELECT plan(7);

DO $seed$
DECLARE
  v_org uuid;
  v_biz uuid;
  v_emp uuid := gen_random_uuid();
  v_orig_run uuid := gen_random_uuid();
  v_rev_run uuid := gen_random_uuid();
  v_garn uuid := gen_random_uuid();
BEGIN
  -- Reuse an existing organization + business so we do not have to satisfy
  -- their full NOT NULL surface; the test only needs FK targets.
  SELECT o.id, b.id INTO v_org, v_biz
  FROM public.organizations o
  JOIN public.businesses b ON b.organization_id = o.id
  LIMIT 1;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'fixture requires at least one organization+business';
  END IF;

  INSERT INTO public.employees (
    id, organization_id, business_id, employee_number,
    first_name, last_name, hire_date
  ) VALUES (
    v_emp, v_org, v_biz, 'TEST-INV-' || substr(v_emp::text, 1, 8),
    'Invert', 'Fixture', CURRENT_DATE - 30
  );

  INSERT INTO public.payroll_runs (
    id, organization_id, business_id, payroll_number,
    pay_period_start, pay_period_end, currency
  ) VALUES
    (v_orig_run, v_org, v_biz, 'TEST-ORIG-' || substr(v_orig_run::text,1,8),
     CURRENT_DATE - 30, CURRENT_DATE - 1, 'USD'),
    (v_rev_run,  v_org, v_biz, 'TEST-REV-'  || substr(v_rev_run::text, 1,8),
     CURRENT_DATE - 30, CURRENT_DATE - 1, 'USD');

  INSERT INTO public.employee_garnishments (
    id, organization_id, business_id, employee_id,
    kind, start_date, total_amount, total_paid
  ) VALUES (
    v_garn, v_org, v_biz, v_emp,
    'court_order', CURRENT_DATE - 30, 1000.00, 250.00
  );

  -- Forward ledger row: engine recorded +100 garnishment delta on
  -- the original correction run.
  INSERT INTO public.payroll_correction_adjustments (
    organization_id, business_id, payroll_run_id, parent_run_id,
    employee_id, source_kind, source_id, signed_amount, notes
  ) VALUES (
    v_org, v_biz, v_orig_run, v_orig_run,
    v_emp, 'garnishment', v_garn, 100.00, 'forward delta'
  );

  PERFORM set_config('test.org',      v_org::text,      true);
  PERFORM set_config('test.biz',      v_biz::text,      true);
  PERFORM set_config('test.emp',      v_emp::text,      true);
  PERFORM set_config('test.orig_run', v_orig_run::text, true);
  PERFORM set_config('test.rev_run',  v_rev_run::text,  true);
  PERFORM set_config('test.garn',     v_garn::text,     true);
END
$seed$;

-- (1) First invocation: one negated ledger row written, garnishment decremented.
SELECT is(
  (SELECT (public.payroll_invert_correction_adjustments(
            current_setting('test.orig_run')::uuid,
            current_setting('test.rev_run')::uuid,
            NULL
          ) ->> 'inverted')::int),
  1,
  'RPC reports one inverted row on first call'
);

SELECT is(
  (SELECT count(*)::int FROM public.payroll_correction_adjustments
    WHERE payroll_run_id = current_setting('test.rev_run')::uuid
      AND signed_amount = -100.00),
  1,
  'a negated ledger row exists on the reversal run'
);

SELECT is(
  (SELECT total_paid FROM public.employee_garnishments
    WHERE id = current_setting('test.garn')::uuid),
  150.00::numeric,
  'garnishment total_paid decremented by forward delta (250 - 100)'
);

-- (2) Idempotency: a second call must not double-invert the ledger.
SELECT is(
  (SELECT (public.payroll_invert_correction_adjustments(
            current_setting('test.orig_run')::uuid,
            current_setting('test.rev_run')::uuid,
            NULL
          ) ->> 'inverted')::int),
  0,
  'second invocation inserts zero ledger rows (ON CONFLICT DO NOTHING)'
);

SELECT is(
  (SELECT count(*)::int FROM public.payroll_correction_adjustments
    WHERE payroll_run_id = current_setting('test.rev_run')::uuid),
  1,
  'reversal run still has exactly one inverted ledger row after replay'
);

-- (3) Clamp: an oversized forward delta must not drive total_paid negative.
DO $clamp$
DECLARE
  v_org uuid := current_setting('test.org')::uuid;
  v_biz uuid := current_setting('test.biz')::uuid;
  v_emp uuid := current_setting('test.emp')::uuid;
  v_garn2 uuid := gen_random_uuid();
  v_orig2 uuid := gen_random_uuid();
  v_rev2  uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.employee_garnishments (
    id, organization_id, business_id, employee_id,
    kind, start_date, total_amount, total_paid
  ) VALUES (
    v_garn2, v_org, v_biz, v_emp,
    'court_order', CURRENT_DATE - 30, 1000.00, 50.00
  );

  INSERT INTO public.payroll_runs (
    id, organization_id, business_id, payroll_number,
    pay_period_start, pay_period_end, currency
  ) VALUES
    (v_orig2, v_org, v_biz, 'TEST-ORIG2-' || substr(v_orig2::text,1,8),
     CURRENT_DATE - 30, CURRENT_DATE - 1, 'USD'),
    (v_rev2,  v_org, v_biz, 'TEST-REV2-'  || substr(v_rev2::text, 1,8),
     CURRENT_DATE - 30, CURRENT_DATE - 1, 'USD');

  INSERT INTO public.payroll_correction_adjustments (
    organization_id, business_id, payroll_run_id, parent_run_id,
    employee_id, source_kind, source_id, signed_amount, notes
  ) VALUES (
    v_org, v_biz, v_orig2, v_orig2,
    v_emp, 'garnishment', v_garn2, 500.00, 'oversize forward delta'
  );

  PERFORM public.payroll_invert_correction_adjustments(v_orig2, v_rev2, NULL);
  PERFORM set_config('test.garn2', v_garn2::text, true);
END
$clamp$;

SELECT cmp_ok(
  (SELECT total_paid FROM public.employee_garnishments
    WHERE id = current_setting('test.garn2')::uuid),
  '>=',
  0::numeric,
  'oversized inverse delta is clamped — total_paid never goes negative'
);

-- (4) BAD_INPUT contract: NULL original_run_id must raise.
SELECT throws_ok(
  $$SELECT public.payroll_invert_correction_adjustments(NULL, NULL, NULL)$$,
  NULL, 'original_run_id required',
  'RPC rejects NULL original_run_id with the documented message'
);

SELECT * FROM finish();
ROLLBACK;
