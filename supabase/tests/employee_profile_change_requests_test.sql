-- Schema-shape guard for the ESS profile change-request pipeline.
-- Only checks structural invariants, does not exercise runtime behaviour.
BEGIN;
SELECT plan(18);

-- 1. Table + RLS
SELECT has_table('public', 'employee_profile_change_requests',
  'change-request table exists');

SELECT ok(
  (SELECT relrowsecurity FROM pg_class
    WHERE oid = 'public.employee_profile_change_requests'::regclass),
  'RLS enabled on employee_profile_change_requests'
);

SELECT isnt_empty(
  $$SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='employee_profile_change_requests'
       AND policyname='epcr_no_direct_insert'$$,
  'INSERT is blocked at the RLS layer (RPC-only)'
);

SELECT isnt_empty(
  $$SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='employee_profile_change_requests'
       AND policyname='epcr_select_own'$$,
  'Employee can read their own requests'
);

SELECT isnt_empty(
  $$SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='employee_profile_change_requests'
       AND policyname='epcr_update_cancel_own'$$,
  'Employee can cancel their own pending requests'
);

-- 2. Own-profile view: security_invoker + masking
SELECT has_view('public','v_my_employee_profile','own-profile view exists');

SELECT is(
  (SELECT (reloptions::text) FROM pg_class
     WHERE oid='public.v_my_employee_profile'::regclass) LIKE '%security_invoker=true%',
  true,
  'v_my_employee_profile is security_invoker'
);

SELECT isnt_empty(
  $$SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='v_my_employee_profile'
       AND column_name='national_id_masked'$$,
  'national_id is exposed only in masked form'
);

SELECT isnt_empty(
  $$SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='v_my_employee_profile'
       AND column_name='bank_account_masked'$$,
  'bank_account_number is exposed only in masked form'
);

-- 3. RPC signatures + security posture
SELECT has_function('public','update_own_employee_personal', ARRAY['jsonb']);
SELECT has_function('public','submit_profile_change_request', ARRAY['text','jsonb','text']);
SELECT has_function('public','review_profile_change_request', ARRAY['uuid','text','text']);
SELECT has_function('public','log_identity_email_change_intent', ARRAY['text','text']);
SELECT has_function('public','record_mfa_lifecycle_event', ARRAY['text','text']);

SELECT ok(
  (SELECT prosecdef FROM pg_proc
    WHERE proname='submit_profile_change_request'
      AND pronamespace='public'::regnamespace),
  'submit_profile_change_request is SECURITY DEFINER'
);

SELECT ok(
  (SELECT prosecdef FROM pg_proc
    WHERE proname='review_profile_change_request'
      AND pronamespace='public'::regnamespace),
  'review_profile_change_request is SECURITY DEFINER'
);

-- 4. Lifecycle-event enum coverage
SELECT is(
  (SELECT COUNT(*)::int FROM pg_enum e
     JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'employee_lifecycle_event_type'
      AND e.enumlabel IN ('profile_change_requested',
                          'profile_change_approved',
                          'profile_change_rejected',
                          'identity_email_change_requested',
                          'mfa_enrolled',
                          'mfa_unenrolled')),
  6,
  'identity & profile-change lifecycle event types exist'
);

-- 5. RPC bodies emit the lifecycle events + HR notification we rely on
SELECT is(
  (SELECT (pg_get_functiondef(p.oid) ILIKE '%employee_lifecycle_events%'
        AND pg_get_functiondef(p.oid) ILIKE '%profile_change_requested%'
        AND pg_get_functiondef(p.oid) ILIKE '%notifications%')::int
     FROM pg_proc p WHERE p.proname='submit_profile_change_request'
       AND p.pronamespace='public'::regnamespace),
  1, 'submit_profile_change_request emits event + notifies HR'
);

SELECT is(
  (SELECT (pg_get_functiondef(p.oid) ILIKE '%profile_change_approved%'
        AND pg_get_functiondef(p.oid) ILIKE '%profile_change_rejected%')::int
     FROM pg_proc p WHERE p.proname='review_profile_change_request'
       AND p.pronamespace='public'::regnamespace),
  1, 'review_profile_change_request emits approved/rejected events'
);

SELECT * FROM finish();
ROLLBACK;
