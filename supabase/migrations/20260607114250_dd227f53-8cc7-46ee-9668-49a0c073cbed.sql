
-- F2a: one-shot cleanup of stale org-wide findings superseded by business-scoped findings
DELETE FROM public.payroll_readiness_findings old
USING public.payroll_readiness_findings newer
WHERE old.business_id IS NULL
  AND newer.business_id IS NOT NULL
  AND old.organization_id = newer.organization_id
  AND old.rule_id = newer.rule_id
  AND old.subject_type = newer.subject_type
  AND old.subject_id IS NOT DISTINCT FROM newer.subject_id
  AND newer.evaluated_at >= old.evaluated_at;

-- F2b: unique index to prevent drift going forward
CREATE UNIQUE INDEX IF NOT EXISTS payroll_readiness_findings_scope_uniq
  ON public.payroll_readiness_findings (
    organization_id,
    rule_id,
    subject_type,
    COALESCE(subject_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- F2c: tighten blocker filter — only include null-business rows when caller asked for org-wide
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
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT r.code, r.name, f.reason, r.reason_code,
         r.remediation_label, r.remediation_link, f.missing_fields
  FROM payroll_readiness_findings f
  JOIN payroll_readiness_rules r ON r.id = f.rule_id
  WHERE f.organization_id = p_org_id
    AND (
      -- caller asked for org-wide: include both NULL and any business
      (p_business_id IS NULL)
      OR
      -- caller scoped to a specific business: ONLY that business
      (f.business_id = p_business_id)
    )
    AND f.subject_type = p_scope
    AND (p_subject_id IS NULL OR f.subject_id = p_subject_id)
    AND f.status = 'fail'
    AND r.severity = 'block'
  ORDER BY r.sort_order, r.code;
$$;

-- F3: resolve_my_employee — never raise on inconsistent session state
CREATE OR REPLACE FUNCTION public.resolve_my_employee()
RETURNS TABLE(
  employee_id uuid,
  organization_id uuid,
  business_id uuid,
  is_linked boolean,
  can_self_link boolean
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_org_id uuid;
  v_last uuid;
  v_emp record;
  v_is_admin boolean := false;
  v_org_has_any_employee boolean := false;
BEGIN
  IF v_user IS NULL THEN RETURN; END IF;

  BEGIN
    SELECT last_org_id INTO v_last FROM public.profiles WHERE user_id = v_user LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_last := NULL;
  END;

  BEGIN
    IF v_last IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.user_roles
       WHERE user_id = v_user AND organization_id = v_last AND is_active = true
    ) THEN
      v_org_id := v_last;
    ELSE
      SELECT ur.organization_id INTO v_org_id
        FROM public.user_roles ur
       WHERE ur.user_id = v_user AND ur.is_active = true
       ORDER BY CASE ur.role
                  WHEN 'super_admin' THEN 0
                  WHEN 'owner' THEN 1
                  WHEN 'admin' THEN 2
                  ELSE 3
                END, ur.created_at ASC
       LIMIT 1;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_org_id := NULL;
  END;

  IF v_org_id IS NULL THEN RETURN; END IF;

  BEGIN
    SELECT e.id, e.organization_id, e.business_id INTO v_emp
      FROM public.employees e
     WHERE e.user_id = v_user AND e.organization_id = v_org_id
     LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_emp := NULL;
  END;

  BEGIN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles ur
       WHERE ur.user_id = v_user AND ur.organization_id = v_org_id
         AND ur.is_active = true AND ur.role IN ('owner','admin','super_admin')
    ) INTO v_is_admin;
  EXCEPTION WHEN OTHERS THEN
    v_is_admin := false;
  END;

  BEGIN
    SELECT EXISTS (
      SELECT 1 FROM public.employees e WHERE e.organization_id = v_org_id
    ) INTO v_org_has_any_employee;
  EXCEPTION WHEN OTHERS THEN
    v_org_has_any_employee := false;
  END;

  employee_id     := v_emp.id;
  organization_id := COALESCE(v_emp.organization_id, v_org_id);
  business_id     := v_emp.business_id;
  is_linked       := v_emp.id IS NOT NULL;
  can_self_link   := v_is_admin AND NOT v_org_has_any_employee AND v_emp.id IS NULL;

  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  -- Last-resort guard: never bubble a 400 to the client; return empty.
  RETURN;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.resolve_my_employee() TO authenticated;
