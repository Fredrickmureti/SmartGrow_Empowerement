DO $$
DECLARE
  r record;
  nq text;
  nw text;
  stmt text;
BEGIN
  FOR r IN
    SELECT tablename, policyname, cmd, coalesce(qual,'') AS q, coalesce(with_check,'') AS w
      FROM pg_policies
     WHERE schemaname = 'public'
       AND coalesce(qual,'') || coalesce(with_check,'') ILIKE '%super_admin%'
       AND NOT (tablename = 'user_roles')
       AND NOT (tablename = 'admin_sent_emails')
       AND NOT (tablename = 'identity_drift_reports')
       AND NOT (tablename = 'platform_apps')
       AND NOT (tablename = 'settings_audit_log')
       AND NOT (tablename = 'user_business_access')
  LOOP
    nq := replace(replace(replace(replace(
            regexp_replace(regexp_replace(regexp_replace(r.q,
              '\s*OR\s+has_(org_)?role\(auth\.uid\(\)[^()]*''super_admin''[^()]*\)','','g'),
              'has_(org_)?role\(auth\.uid\(\)[^()]*''super_admin''[^()]*\)\s*OR\s*','','g'),
              '\s*OR\s+has_role\(auth\.uid\(\), ''super_admin''::text\)','','g'),
            ', ''super_admin''::app_role',''), '''super_admin''::app_role, ',''),
            ', ''super_admin''::text',''), '''super_admin''::text, ','');
    nw := replace(replace(replace(replace(
            regexp_replace(regexp_replace(regexp_replace(r.w,
              '\s*OR\s+has_(org_)?role\(auth\.uid\(\)[^()]*''super_admin''[^()]*\)','','g'),
              'has_(org_)?role\(auth\.uid\(\)[^()]*''super_admin''[^()]*\)\s*OR\s*','','g'),
              '\s*OR\s+has_role\(auth\.uid\(\), ''super_admin''::text\)','','g'),
            ', ''super_admin''::app_role',''), '''super_admin''::app_role, ',''),
            ', ''super_admin''::text',''), '''super_admin''::text, ','');

    IF nq ILIKE '%super_admin%' OR nw ILIKE '%super_admin%' THEN
      RAISE EXCEPTION 'unhandled super_admin reference in policy %.%', r.tablename, r.policyname;
    END IF;

    stmt := format('ALTER POLICY %I ON public.%I', r.policyname, r.tablename);
    IF r.q <> '' THEN stmt := stmt || ' USING (' || nq || ')'; END IF;
    IF r.w <> '' THEN stmt := stmt || ' WITH CHECK (' || nw || ')'; END IF;
    EXECUTE stmt;
  END LOOP;
END $$;

-- Platform-level surfaces: retire the super_admin-only rules in favour of the
-- existing platform-admin resolver (which already covers organization owners).
DROP POLICY IF EXISTS "Super admins can manage sent emails" ON public.admin_sent_emails;
CREATE POLICY "Platform admins can manage sent emails"
  ON public.admin_sent_emails FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

DROP POLICY IF EXISTS "Super admins can view identity drift reports" ON public.identity_drift_reports;
CREATE POLICY "Platform admins can view identity drift reports"
  ON public.identity_drift_reports FOR SELECT TO authenticated
  USING (public.is_platform_admin(auth.uid()));

DROP POLICY IF EXISTS "Platform admins can manage apps" ON public.platform_apps;
CREATE POLICY "Platform admins can manage apps"
  ON public.platform_apps FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

DROP POLICY IF EXISTS "Platform admins can delete audit log entries" ON public.settings_audit_log;
CREATE POLICY "Platform admins can delete audit log entries"
  ON public.settings_audit_log FOR DELETE
  USING (public.is_platform_admin(auth.uid()));

ALTER POLICY "Org members can view their audit log" ON public.settings_audit_log
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
       WHERE ur.user_id = auth.uid()
         AND ur.organization_id = settings_audit_log.organization_id
         AND ur.is_active = true
    )
    OR public.is_platform_admin(auth.uid())
  );

ALTER POLICY "Workspace owners manage business access" ON public.user_business_access
  USING (
    EXISTS (
      SELECT 1 FROM public.businesses b
        JOIN public.organizations o ON o.id = b.organization_id
       WHERE b.id = user_business_access.business_id
         AND o.owner_user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.businesses b
        JOIN public.organizations o ON o.id = b.organization_id
       WHERE b.id = user_business_access.business_id
         AND o.owner_user_id = auth.uid()
    )
  );