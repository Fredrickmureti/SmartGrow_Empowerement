-- Audit log
DROP POLICY IF EXISTS "Authenticated users can view audit log" ON public.admin_audit_log;
DROP POLICY IF EXISTS "Authenticated users can insert audit log" ON public.admin_audit_log;
CREATE POLICY "Service role can insert audit log"
  ON public.admin_audit_log FOR INSERT TO service_role WITH CHECK (true);

-- automated_action_logs
DROP POLICY IF EXISTS "System can insert automation logs" ON public.automated_action_logs;
CREATE POLICY "Service role can insert automation logs"
  ON public.automated_action_logs FOR INSERT TO service_role WITH CHECK (true);

-- login_history
DROP POLICY IF EXISTS "Service role can insert login history" ON public.login_history;
CREATE POLICY "Service role can insert login history"
  ON public.login_history FOR INSERT TO service_role WITH CHECK (true);

-- security_alerts
DROP POLICY IF EXISTS "Service role can insert alerts" ON public.security_alerts;
CREATE POLICY "Service role can insert security alerts"
  ON public.security_alerts FOR INSERT TO service_role WITH CHECK (true);

-- user_devices
DROP POLICY IF EXISTS "Service role can insert devices" ON public.user_devices;
CREATE POLICY "Service role can insert devices"
  ON public.user_devices FOR INSERT TO service_role WITH CHECK (true);

-- platform_admin_notifications
DROP POLICY IF EXISTS "Service can insert admin notifications" ON public.platform_admin_notifications;
CREATE POLICY "Service role can insert admin notifications"
  ON public.platform_admin_notifications FOR INSERT TO service_role WITH CHECK (true);

-- Storage: organization-assets scoped to org members
DROP POLICY IF EXISTS "Organization logos are publicly accessible" ON storage.objects;
CREATE POLICY "Org members can read organization assets"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'organization-assets'
    AND (storage.foldername(name))[1] IN (
      SELECT (o.id)::text FROM public.organizations o
      WHERE o.id IN (SELECT public.get_user_organizations(auth.uid()))
    )
  );

-- Storage: employee-avatars authenticated-only
DROP POLICY IF EXISTS "Anyone can view employee avatars" ON storage.objects;
CREATE POLICY "Authenticated users can read employee avatars"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'employee-avatars');

-- Org creation rate limit
CREATE OR REPLACE FUNCTION public.enforce_org_creation_rate_limit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE recent_count int;
BEGIN
  IF NEW.owner_user_id IS NULL THEN RETURN NEW; END IF;
  SELECT count(*) INTO recent_count FROM public.organizations
  WHERE owner_user_id = NEW.owner_user_id AND created_at > now() - interval '1 hour';
  IF recent_count >= 5 THEN
    RAISE EXCEPTION 'Too many workspaces created recently. Please wait before creating another.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_org_creation_rate_limit ON public.organizations;
CREATE TRIGGER trg_enforce_org_creation_rate_limit
  BEFORE INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_org_creation_rate_limit();