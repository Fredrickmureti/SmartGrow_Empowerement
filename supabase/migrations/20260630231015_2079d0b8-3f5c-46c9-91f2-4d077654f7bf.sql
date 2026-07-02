CREATE OR REPLACE FUNCTION public.evaluate_payroll_readiness_quiet(
  p_org_id uuid, p_business_id uuid DEFAULT NULL::uuid,
  p_scope text DEFAULT 'org'::text, p_subject_ids uuid[] DEFAULT NULL::uuid[],
  p_period_start date DEFAULT NULL::date, p_period_end date DEFAULT NULL::date
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_rule     public.payroll_readiness_rules;
  v_subject  uuid;
  v_subjects uuid[];
  v_eval     record;
BEGIN
  IF p_org_id IS NULL THEN RETURN; END IF;

  IF p_scope IN ('employee','run') THEN
    v_subjects := COALESCE(p_subject_ids, ARRAY[]::uuid[]);
    IF array_length(v_subjects, 1) IS NULL THEN RETURN; END IF;
  ELSE
    v_subjects := ARRAY[NULL::uuid];
  END IF;

  FOR v_rule IN
    SELECT * FROM public.payroll_readiness_rules
    WHERE is_active = true AND scope = p_scope
      AND (organization_id IS NULL OR organization_id = p_org_id)
    ORDER BY sort_order, code
  LOOP
    FOREACH v_subject IN ARRAY v_subjects LOOP
      FOR v_eval IN
        SELECT * FROM public.payroll_readiness_eval_rule(
          v_rule, p_org_id, p_business_id, v_subject, p_period_start, p_period_end)
      LOOP
        INSERT INTO public.payroll_readiness_findings (
          organization_id, business_id, rule_id, subject_type, subject_id,
          status, reason, missing_fields, details, evaluated_at
        ) VALUES (
          p_org_id, p_business_id, v_rule.id, p_scope, v_subject,
          v_eval.status, v_eval.reason, v_eval.missing_fields, v_eval.details, now()
        )
        ON CONFLICT (
          organization_id,
          COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid),
          subject_type,
          COALESCE(subject_id, '00000000-0000-0000-0000-000000000000'::uuid),
          rule_id
        )
        DO UPDATE SET
          status = EXCLUDED.status, reason = EXCLUDED.reason,
          missing_fields = EXCLUDED.missing_fields, details = EXCLUDED.details,
          evaluated_at = EXCLUDED.evaluated_at;
      END LOOP;
    END LOOP;
  END LOOP;
END;
$function$;