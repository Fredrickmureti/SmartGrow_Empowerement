-- Slice 2 finalize: readiness rule for custom deduction GL mapping.
--
-- Adds a new check_kind branch to `payroll_readiness_eval_rule` and seeds
-- a global business-scope rule that flags any active custom deduction
-- type with ≥1 active/approved employee assignment and missing GL
-- mapping (liability always; expense when employer contribution).
--
-- The rule flows through `payroll_readiness_summary` → the "Payroll
-- Ready" badge, the pre-run panel, and `compute-payroll`'s 412 payload
-- (per ADR 0040) without any additional code changes.

CREATE OR REPLACE FUNCTION public.payroll_readiness_eval_rule(
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
DECLARE
  v_status text := 'pass';
  v_reason text;
  v_missing text[] := ARRAY[]::text[];
  v_details jsonb := '{}'::jsonb;
BEGIN
  IF p_rule.check_kind = 'business.custom_deduction_gl_mapping' THEN
    SELECT COALESCE(array_agg(t.code ORDER BY t.code), ARRAY[]::text[])
      INTO v_missing
      FROM public.custom_deduction_types t
     WHERE t.business_id = p_business_id
       AND t.is_active = true
       AND (
         t.gl_liability_account_id IS NULL
         OR (t.is_employer_contribution = true AND t.gl_expense_account_id IS NULL)
       )
       AND EXISTS (
         SELECT 1
           FROM public.employee_custom_deductions a
          WHERE a.deduction_type_id = t.id
            AND a.status IN ('approved','active')
       );
    IF array_length(v_missing, 1) IS NOT NULL THEN
      v_status := 'fail';
      v_reason := 'Custom deduction types missing GL mapping: ' || array_to_string(v_missing, ', ');
      v_details := jsonb_build_object('missing_codes', v_missing);
    END IF;
    RETURN QUERY SELECT v_status, v_reason, v_missing, v_details;
    RETURN;
  END IF;

  -- Delegate all other check_kinds to the previous implementation.
  RETURN QUERY
    SELECT * FROM public._payroll_readiness_eval_rule_core(
      p_rule, p_org_id, p_business_id, p_subject_id, p_period_start, p_period_end
    );
END;
$$;

-- Seed the rule (global — organization_id NULL).
INSERT INTO public.payroll_readiness_rules (
  organization_id, code, name, description, scope, severity, source,
  reason_code, check_kind, remediation_label, remediation_link,
  is_active, sort_order
) VALUES (
  NULL,
  'core.business.custom_deduction_gl_mapping',
  'Custom deduction GL mapping complete',
  'Every active custom deduction type with employee assignments must have a GL liability account mapped (and an expense account for employer contributions).',
  'org', 'block', 'core',
  'CUSTOM_DEDUCTION_GL_MAPPING',
  'business.custom_deduction_gl_mapping',
  'Open Custom deductions',
  '/hr/payroll/configuration/custom-deductions',
  true, 250
)
ON CONFLICT (organization_id, code) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      scope = EXCLUDED.scope,
      severity = EXCLUDED.severity,
      source = EXCLUDED.source,
      reason_code = EXCLUDED.reason_code,
      check_kind = EXCLUDED.check_kind,
      remediation_label = EXCLUDED.remediation_label,
      remediation_link = EXCLUDED.remediation_link,
      is_active = true,
      updated_at = now();