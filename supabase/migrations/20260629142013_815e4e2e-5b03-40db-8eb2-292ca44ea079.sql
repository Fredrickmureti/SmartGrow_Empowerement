-- Restore payroll_readiness_blockers (dropped in 20260629115900 with no replacement).
-- payroll_readiness_summary and assert_payroll_ready_json still call this function,
-- so both the Readiness page summary pane and the compute-payroll readiness gate
-- broke identically. Re-defining it with the same (uuid, uuid, text, uuid) signature
-- and the same body restores the single shared evaluation engine.

CREATE OR REPLACE FUNCTION public.payroll_readiness_blockers(
  p_org_id uuid,
  p_business_id uuid DEFAULT NULL,
  p_scope text DEFAULT 'org',
  p_subject_id uuid DEFAULT NULL
)
RETURNS TABLE(
  rule_code text,
  rule_name text,
  reason text,
  reason_code text,
  remediation_label text,
  remediation_link text,
  missing_fields text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.code,
         r.name,
         f.reason,
         r.reason_code,
         r.remediation_label,
         r.remediation_link,
         f.missing_fields
  FROM public.payroll_readiness_findings f
  JOIN public.payroll_readiness_rules r ON r.id = f.rule_id
  LEFT JOIN public.payroll_readiness_rule_overrides o
    ON o.organization_id = p_org_id AND o.rule_code = r.code
  WHERE f.organization_id = p_org_id
    AND ((p_business_id IS NULL) OR (f.business_id = p_business_id))
    AND f.subject_type = p_scope
    AND (p_subject_id IS NULL OR f.subject_id = p_subject_id)
    AND f.status = 'fail'
    AND COALESCE(o.severity, r.severity) = 'block'
  ORDER BY r.sort_order, r.code;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_readiness_blockers(uuid, uuid, text, uuid)
  TO authenticated, service_role;