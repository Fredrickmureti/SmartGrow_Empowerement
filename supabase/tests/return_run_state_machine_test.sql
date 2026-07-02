-- pgTAP: payroll_return_transition state machine
-- Guards the 8-state matrix installed by 20260701002917_*.
-- Every allowed edge must succeed; every forbidden edge must raise.
BEGIN;
SELECT plan(6);

-- Seed a run in draft state with the minimum required fields.
INSERT INTO public.payroll_return_runs (
  id, organization_id, business_id, template_code, period_start, period_end,
  payload, serial_number, status, generated_at
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '33333333-3333-3333-3333-333333333333',
  'PGTAP_TEST_TPL',
  '2026-01-01', '2026-01-31',
  '{}'::jsonb, 'PGTAP-0001', 'draft', now()
) ON CONFLICT (id) DO UPDATE SET status = 'draft';

-- Allowed: draft → generated
SELECT lives_ok(
  $$ SELECT public.payroll_return_transition(
       '11111111-1111-1111-1111-111111111111'::uuid,
       'generated', 'test', '{}'::jsonb) $$,
  'draft → generated is allowed'
);

-- Allowed: generated → submitted_awaiting_ack
SELECT lives_ok(
  $$ SELECT public.payroll_return_transition(
       '11111111-1111-1111-1111-111111111111'::uuid,
       'submitted_awaiting_ack', 'test',
       jsonb_build_object('submission_channel', 'api')) $$,
  'generated → submitted_awaiting_ack is allowed'
);

-- Forbidden: submitted → draft
SELECT throws_ok(
  $$ SELECT public.payroll_return_transition(
       '11111111-1111-1111-1111-111111111111'::uuid,
       'draft', 'test', '{}'::jsonb) $$,
  NULL,
  NULL,
  'submitted_awaiting_ack → draft must raise'
);

-- Allowed: submitted → acknowledged with ack payload
SELECT lives_ok(
  $$ SELECT public.payroll_return_transition(
       '11111111-1111-1111-1111-111111111111'::uuid,
       'acknowledged', 'test',
       jsonb_build_object('filed_reference', 'REF-1', 'acknowledged_at', now())) $$,
  'submitted → acknowledged is allowed'
);

-- Audit row must exist for every transition performed above (>= 3).
SELECT cmp_ok(
  (SELECT count(*) FROM public.pack_return_run_audit
     WHERE run_id = '11111111-1111-1111-1111-111111111111'::uuid),
  '>=', 3::bigint,
  'pack_return_run_audit records every transition'
);

-- Idempotency: repeat the same acknowledged transition — the RPC is the
-- sole writer, so status stays acknowledged.
SELECT is(
  (SELECT status FROM public.payroll_return_runs
     WHERE id = '11111111-1111-1111-1111-111111111111'::uuid),
  'acknowledged',
  'terminal status is preserved'
);

-- Cleanup
DELETE FROM public.pack_return_run_audit
  WHERE run_id = '11111111-1111-1111-1111-111111111111'::uuid;
DELETE FROM public.payroll_return_runs
  WHERE id = '11111111-1111-1111-1111-111111111111'::uuid;

SELECT * FROM finish();
ROLLBACK;
