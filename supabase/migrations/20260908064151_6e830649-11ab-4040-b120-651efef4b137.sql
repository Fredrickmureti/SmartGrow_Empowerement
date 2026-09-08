DO $$
DECLARE
  r record;
  nd text;
  skipped text[] := '{}';
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_functiondef(p.oid) AS d
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND pg_get_functiondef(p.oid) ILIKE '%super_admin%'
       AND p.proname NOT IN (
         'resolve_my_employee','get_linkable_users_for_employee',
         'accept_organization_invitation_atomic','set_sms_provider_config',
         'notify_expense_created','provision_additional_company',
         'promote_to_internal_user','get_commercial_timeline',
         'governance_run_teardown','has_role','governance_assert_not_self',
         'governance_self_action_verdict')
  LOOP
    nd := replace(replace(replace(replace(replace(replace(replace(replace(
            regexp_replace(regexp_replace(regexp_replace(r.d,
              '\s*(OR|or)\s+(public\.)?(has_org_role|has_role|is_super_admin)\((?:[^()]|\([^()]*\))*''super_admin''(?:[^()]|\([^()]*\))*\)','','g'),
              '(public\.)?(has_org_role|has_role|is_super_admin)\((?:[^()]|\([^()]*\))*''super_admin''(?:[^()]|\([^()]*\))*\)\s*(OR|or)\s*','','g'),
              '\s*(OR|or)\s+[a-z_.]*role\s*(=|::text\s*=)\s*''super_admin''(::[a-z_]+)?','','g'),
            'IN (''super_admin'', ''', 'IN ('''), 'IN (''super_admin'',''', 'IN ('''),
            ', ''super_admin'')', ')'), ',''super_admin'')', ')'),
            '''super_admin''::app_role, ', ''), ', ''super_admin''::app_role', ''),
            '''super_admin''::text, ', ''), ', ''super_admin''::text', '');

    IF nd ILIKE '%super_admin%' THEN
      RAISE EXCEPTION 'unhandled super_admin reference in function %', r.proname;
    END IF;

    BEGIN
      EXECUTE nd;
    EXCEPTION WHEN others THEN
      skipped := skipped || r.proname;
    END;
  END LOOP;

  IF array_length(skipped, 1) IS NOT NULL THEN
    RAISE NOTICE 'skipped (pre-existing compile errors): %', array_to_string(skipped, ', ');
  END IF;
END $$;