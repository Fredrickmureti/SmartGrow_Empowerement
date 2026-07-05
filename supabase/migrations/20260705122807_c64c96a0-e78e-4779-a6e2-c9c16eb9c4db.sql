-- Missing core evaluator: two later migrations delegate to
-- public._payroll_readiness_eval_rule_core(...) but that function was never
-- created. The original evaluator body lives under
-- public.payroll_readiness_eval_rule_legacy(...). Provide the underscore-
-- prefixed core name as a thin, identical-signature wrapper so every
-- fallback branch resolves.

CREATE OR REPLACE FUNCTION public._payroll_readiness_eval_rule_core(
  p_rule public.payroll_readiness_rules,
  p_org_id uuid,
  p_business_id uuid,
  p_subject_id uuid,
  p_period_start date,
  p_period_end date
) RETURNS TABLE(status text, reason text, missing_fields text[], details jsonb)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM public.payroll_readiness_eval_rule_legacy(
    p_rule, p_org_id, p_business_id, p_subject_id, p_period_start, p_period_end
  );
END;
$$;

REVOKE ALL ON FUNCTION public._payroll_readiness_eval_rule_core(
  public.payroll_readiness_rules, uuid, uuid, uuid, date, date
) FROM public;
GRANT EXECUTE ON FUNCTION public._payroll_readiness_eval_rule_core(
  public.payroll_readiness_rules, uuid, uuid, uuid, date, date
) TO authenticated, service_role;
