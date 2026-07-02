-- =====================================================================
-- Curated lockdown: revoke anon EXECUTE on SECURITY DEFINER functions
-- except a verified pre/partial-auth allowlist.
-- Signed-in users (authenticated) and server jobs (service_role) keep access.
-- =====================================================================
DO $$
DECLARE
  r record;
  v_revoked int := 0;
  v_kept    int := 0;
  -- Functions that legitimately run with NO session (role = anon).
  -- Verified against frontend callers (accept/ownership/login/scanner/pricing).
  allow text[] := ARRAY[
    'check_pin_status','has_user_pin','set_user_pin','verify_pin_full',
    'verify_cashier_pin','verify_manager_pin','verify_company_isolation',
    'reset_my_signup','notify_admins_new_signup',
    'cheapest_plan_for_app','compute_org_billing','compute_org_billing_for_plan',
    'app_state_for_org'
  ];
  -- Name patterns for whole pre-auth families (acceptance, onboarding, pairing).
  allow_rx text := '(ownership_transfer|onboard|scanner|pairing|invitation|signup)';
BEGIN
  FOR r IN
    SELECT p.oid, p.oid::regprocedure AS sig, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef IS TRUE
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  LOOP
    IF r.proname = ANY(allow) OR r.proname ~* allow_rx THEN
      v_kept := v_kept + 1;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
    v_revoked := v_revoked + 1;
  END LOOP;

  RAISE NOTICE 'anon EXECUTE revoked on % functions; kept on % pre-auth functions', v_revoked, v_kept;
END $$;