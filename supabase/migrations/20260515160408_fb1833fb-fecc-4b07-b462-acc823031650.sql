
-- Purge platform admin audit log (platform admins only).
CREATE OR REPLACE FUNCTION public.clear_admin_audit_log(p_older_than_days integer DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_deleted integer := 0;
BEGIN
  IF v_caller IS NULL OR NOT public.is_platform_admin(v_caller) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_older_than_days IS NULL OR p_older_than_days <= 0 THEN
    DELETE FROM public.admin_audit_log;
  ELSE
    DELETE FROM public.admin_audit_log
    WHERE created_at < (now() - make_interval(days => p_older_than_days));
  END IF;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  INSERT INTO public.admin_audit_log (admin_user_id, action_type, details)
  VALUES (
    v_caller,
    'audit_log.cleared',
    jsonb_build_object('older_than_days', p_older_than_days, 'deleted', v_deleted)
  );

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_admin_audit_log(integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.clear_admin_audit_log(integer) TO authenticated;

-- Purge an organization's settings audit log (org admins/owners or platform admins).
CREATE OR REPLACE FUNCTION public.clear_settings_audit_log(
  p_org_id uuid,
  p_older_than_days integer DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_deleted integer := 0;
  v_deleted_app integer := 0;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF NOT (
    public.is_platform_admin(v_caller)
    OR public.is_org_admin_or_owner(v_caller, p_org_id)
  ) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_older_than_days IS NULL OR p_older_than_days <= 0 THEN
    DELETE FROM public.settings_audit_log WHERE organization_id = p_org_id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    DELETE FROM public.audit_logs
    WHERE organization_id = p_org_id AND action LIKE 'settings.%';
    GET DIAGNOSTICS v_deleted_app = ROW_COUNT;
  ELSE
    DELETE FROM public.settings_audit_log
    WHERE organization_id = p_org_id
      AND created_at < (now() - make_interval(days => p_older_than_days));
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    DELETE FROM public.audit_logs
    WHERE organization_id = p_org_id
      AND action LIKE 'settings.%'
      AND created_at < (now() - make_interval(days => p_older_than_days));
    GET DIAGNOSTICS v_deleted_app = ROW_COUNT;
  END IF;

  RETURN v_deleted + v_deleted_app;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_settings_audit_log(uuid, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.clear_settings_audit_log(uuid, integer) TO authenticated;
