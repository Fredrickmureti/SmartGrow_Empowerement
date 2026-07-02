
-- =====================================================================
-- HR audit follow-ups: atomic invitation accept, payroll severity overrides,
-- HR ops visibility into failed onboarding_attempts.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Per-org payroll readiness severity overrides
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payroll_readiness_rule_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  rule_code text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('block','warn','info')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, rule_code)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll_readiness_rule_overrides TO authenticated;
GRANT ALL ON public.payroll_readiness_rule_overrides TO service_role;

ALTER TABLE public.payroll_readiness_rule_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org admins manage payroll rule overrides"
  ON public.payroll_readiness_rule_overrides
  FOR ALL
  TO authenticated
  USING (public.is_org_admin(auth.uid(), organization_id))
  WITH CHECK (public.is_org_admin(auth.uid(), organization_id));

CREATE POLICY "Org members read payroll rule overrides"
  ON public.payroll_readiness_rule_overrides
  FOR SELECT
  TO authenticated
  USING (public.user_belongs_to_org(auth.uid(), organization_id));

CREATE OR REPLACE FUNCTION public.tg_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS set_updated_at_payroll_rule_overrides ON public.payroll_readiness_rule_overrides;
CREATE TRIGGER set_updated_at_payroll_rule_overrides
  BEFORE UPDATE ON public.payroll_readiness_rule_overrides
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- Replace blockers RPC to honour the org override (warn → block).
CREATE OR REPLACE FUNCTION public.payroll_readiness_blockers(
  p_org_id uuid,
  p_business_id uuid DEFAULT NULL,
  p_scope text DEFAULT 'org',
  p_subject_id uuid DEFAULT NULL
)
RETURNS TABLE(
  rule_code text, rule_name text, reason text, reason_code text,
  remediation_label text, remediation_link text, missing_fields text[]
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.code, r.name, f.reason, r.reason_code,
         r.remediation_label, r.remediation_link, f.missing_fields
  FROM payroll_readiness_findings f
  JOIN payroll_readiness_rules r ON r.id = f.rule_id
  LEFT JOIN payroll_readiness_rule_overrides o
    ON o.organization_id = p_org_id AND o.rule_code = r.code
  WHERE f.organization_id = p_org_id
    AND ((p_business_id IS NULL) OR (f.business_id = p_business_id))
    AND f.subject_type = p_scope
    AND (p_subject_id IS NULL OR f.subject_id = p_subject_id)
    AND f.status = 'fail'
    AND COALESCE(o.severity, r.severity) = 'block'
  ORDER BY r.sort_order, r.code;
$$;

-- ---------------------------------------------------------------------
-- 2) Atomic invitation acceptance
--    Wraps role upsert + member_permission_groups assignment +
--    employee link + invitation accepted_at into one transaction.
--    The edge function still handles auth user creation; this runs
--    everything else as a single SQL unit.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_organization_invitation_atomic(
  p_invitation_id uuid,
  p_user_id uuid,
  p_permission_group_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv record;
  v_existing_role record;
  v_privileged constant text[] := ARRAY['owner','admin','super_admin'];
  v_would_demote boolean := false;
  v_linked_employee_id uuid;
  v_employee_linked boolean := false;
  v_group_ids uuid[];
  v_group_id uuid;
  v_default_group_name text;
BEGIN
  SELECT id, organization_id, email, role, user_type, accepted_at, expires_at,
         COALESCE(permission_group_ids, ARRAY[]::uuid[]) AS permission_group_ids
    INTO v_inv
    FROM organization_invitations
   WHERE id = p_invitation_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invitation_not_found');
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'already_accepted');
  END IF;
  IF v_inv.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'expired');
  END IF;

  SELECT id, role::text AS role, user_type
    INTO v_existing_role
    FROM user_roles
   WHERE user_id = p_user_id
     AND organization_id = v_inv.organization_id
   LIMIT 1;

  IF FOUND
     AND v_existing_role.role = ANY (v_privileged)
     AND (v_inv.role::text = 'portal' OR v_inv.user_type = 'portal') THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'would_demote_admin',
      'existing_role', v_existing_role.role
    );
  END IF;

  -- Upsert role
  IF FOUND THEN
    UPDATE user_roles
       SET role = v_inv.role,
           user_type = v_inv.user_type,
           is_active = true,
           updated_at = now()
     WHERE id = v_existing_role.id;
  ELSE
    INSERT INTO user_roles (user_id, organization_id, role, user_type, is_active)
    VALUES (p_user_id, v_inv.organization_id, v_inv.role, v_inv.user_type, true);
  END IF;

  -- Auto-link employee row (only for non-privileged users)
  IF NOT FOUND OR NOT (v_existing_role.role = ANY (v_privileged)) THEN
    UPDATE employees
       SET user_id = p_user_id, user_access_status = 'active'
     WHERE organization_id = v_inv.organization_id
       AND lower(email) = lower(v_inv.email)
       AND user_id IS NULL
    RETURNING id INTO v_linked_employee_id;

    IF v_linked_employee_id IS NOT NULL THEN
      v_employee_linked := true;
    END IF;
  END IF;

  -- Permission groups: replace set for non-privileged, otherwise append
  IF NOT (FOUND AND v_existing_role.role = ANY (v_privileged)) THEN
    DELETE FROM member_permission_groups
     WHERE organization_id = v_inv.organization_id
       AND user_id = p_user_id;
  END IF;

  v_group_ids := COALESCE(p_permission_group_ids, v_inv.permission_group_ids);

  IF v_group_ids IS NOT NULL AND array_length(v_group_ids, 1) > 0 THEN
    FOREACH v_group_id IN ARRAY v_group_ids LOOP
      INSERT INTO member_permission_groups (organization_id, user_id, permission_group_id)
      VALUES (v_inv.organization_id, p_user_id, v_group_id)
      ON CONFLICT DO NOTHING;
    END LOOP;
  ELSE
    v_default_group_name := CASE WHEN v_inv.user_type = 'portal' THEN 'Portal User' ELSE 'Internal Users' END;
    SELECT id INTO v_group_id
      FROM permission_groups
     WHERE organization_id = v_inv.organization_id
       AND name = v_default_group_name
       AND is_system = true
     LIMIT 1;
    IF v_group_id IS NULL AND v_inv.user_type <> 'portal' THEN
      SELECT id INTO v_group_id
        FROM permission_groups
       WHERE organization_id = v_inv.organization_id
         AND name = 'Internal User'
         AND is_system = true
       LIMIT 1;
    END IF;
    IF v_group_id IS NOT NULL THEN
      INSERT INTO member_permission_groups (organization_id, user_id, permission_group_id)
      VALUES (v_inv.organization_id, p_user_id, v_group_id)
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  -- Mark invitation accepted
  UPDATE organization_invitations
     SET accepted_at = now()
   WHERE id = v_inv.id;

  -- Diagnostic onboarding_attempts row
  PERFORM record_invitation_link_outcome(
    v_inv.organization_id, p_user_id, v_inv.email, v_employee_linked, v_linked_employee_id
  );

  RETURN jsonb_build_object(
    'ok', true,
    'organization_id', v_inv.organization_id,
    'role', v_inv.role,
    'user_type', v_inv.user_type,
    'employee_linked', v_employee_linked,
    'linked_employee_id', v_linked_employee_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.accept_organization_invitation_atomic(uuid, uuid, uuid[]) TO service_role;

-- ---------------------------------------------------------------------
-- 3) HR ops visibility into failed onboarding_attempts
--    Add an org-admin / HR read policy and a helper RPC that returns
--    failed attempts the org needs to remediate.
-- ---------------------------------------------------------------------
DO $$ BEGIN
  CREATE POLICY "Org admins read org onboarding attempts"
    ON public.onboarding_attempts
    FOR SELECT
    TO authenticated
    USING (
      organization_id IS NOT NULL
      AND public.is_org_admin(auth.uid(), organization_id)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.hr_list_failed_onboarding_attempts(
  p_org_id uuid,
  p_limit int DEFAULT 100
)
RETURNS TABLE(
  id uuid,
  user_id uuid,
  status text,
  company_name text,
  error_message text,
  diagnostics jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, user_id, status, company_name, error_message,
         diagnostics, started_at, completed_at, updated_at
    FROM onboarding_attempts
   WHERE organization_id = p_org_id
     AND status IN ('failed','blocked')
     AND public.is_org_admin(auth.uid(), p_org_id)
   ORDER BY updated_at DESC
   LIMIT GREATEST(1, LEAST(p_limit, 500));
$$;

GRANT EXECUTE ON FUNCTION public.hr_list_failed_onboarding_attempts(uuid, int) TO authenticated, service_role;
