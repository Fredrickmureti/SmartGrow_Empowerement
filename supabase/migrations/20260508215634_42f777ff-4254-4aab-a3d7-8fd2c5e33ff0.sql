-- Add run-aware overload for payroll_gl_readiness so all callers (Setup banner,
-- Overview banner for the latest blocked run, AccountMapping page) can opt
-- into the run-specific resolver and stay consistent with post-payroll-gl.
CREATE OR REPLACE FUNCTION public.payroll_gl_readiness(
  _org_id uuid,
  _business_id uuid,
  _run_id uuid
)
RETURNS TABLE (
  setting_key text,
  label text,
  rule_code text,
  kind text,
  required_account_type text,
  is_mapped boolean,
  suggested_account_id uuid,
  suggested_account_label text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _run_id IS NOT NULL THEN
    RETURN QUERY
      SELECT r.setting_key, r.label, r.rule_code, r.kind,
             r.required_account_type, r.is_mapped,
             r.suggested_account_id, r.suggested_account_label
      FROM public.payroll_required_gl_mappings_for_run(_run_id) r;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT r.setting_key, r.label, r.rule_code, r.kind,
           r.required_account_type, r.is_mapped,
           r.suggested_account_id, r.suggested_account_label
    FROM public.payroll_gl_readiness(_org_id, _business_id) r;
END;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_gl_readiness(uuid, uuid, uuid) TO authenticated, service_role;