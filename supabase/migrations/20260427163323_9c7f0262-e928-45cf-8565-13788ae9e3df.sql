-- Restrict execution on settings-related SECURITY DEFINER functions.
-- PostgreSQL grants EXECUTE to PUBLIC by default for new functions, so revoke it explicitly.

REVOKE EXECUTE ON FUNCTION public.set_branch_setting(uuid, text, jsonb, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_branch_setting(uuid, text, jsonb, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_branch_setting(uuid, text, jsonb, text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.clear_branch_setting(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.clear_branch_setting(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.clear_branch_setting(uuid, text, text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.get_effective_company_config(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_effective_company_config(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_effective_company_config(uuid, uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.audit_settings_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.audit_settings_change() FROM anon;

REVOKE EXECUTE ON FUNCTION public.settings_jsonb_to_text(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.settings_jsonb_to_text(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.settings_jsonb_to_text(jsonb) TO authenticated;