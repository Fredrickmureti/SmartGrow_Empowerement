
-- =========================================================================
-- SoD Wave G2 — Migration 1: Self-Action Framework
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.self_action_policy (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  action_key        text NOT NULL,
  mode              text NOT NULL DEFAULT 'block'
                    CHECK (mode IN ('block','warn','require_cosign','allow')),
  applies_to_role   public.app_role,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_by        uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_self_action_policy_role
  ON public.self_action_policy (organization_id, action_key, applies_to_role)
  WHERE applies_to_role IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_self_action_policy_default
  ON public.self_action_policy (organization_id, action_key)
  WHERE applies_to_role IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.self_action_policy TO authenticated;
GRANT ALL ON public.self_action_policy TO service_role;

ALTER TABLE public.self_action_policy ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members read self_action_policy"
  ON public.self_action_policy FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role)
    OR public.has_role(auth.uid(), organization_id, 'admin'::public.app_role)
    OR public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
    OR public.has_role(auth.uid(), organization_id, 'accountant'::public.app_role)
    OR public.has_role(auth.uid(), organization_id, 'staff'::public.app_role)
  );

CREATE POLICY "owners write self_action_policy"
  ON public.self_action_policy FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role)
    OR public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  );

CREATE POLICY "owners update self_action_policy"
  ON public.self_action_policy FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role)
    OR public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
  WITH CHECK (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role)
    OR public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  );

CREATE POLICY "owners delete self_action_policy"
  ON public.self_action_policy FOR DELETE TO authenticated
  USING (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role)
    OR public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  );

CREATE OR REPLACE FUNCTION public.touch_self_action_policy()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := COALESCE(auth.uid(), NEW.updated_by);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_self_action_policy_touch ON public.self_action_policy;
CREATE TRIGGER trg_self_action_policy_touch
  BEFORE UPDATE ON public.self_action_policy
  FOR EACH ROW EXECUTE FUNCTION public.touch_self_action_policy();

-- ----- self_action_overrides ----------------------------------------------
CREATE TABLE IF NOT EXISTS public.self_action_overrides (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  actor_user_id       uuid NOT NULL,
  subject_user_id     uuid NOT NULL,
  action_key          text NOT NULL,
  entity_type         text,
  entity_id           uuid,
  reason              text NOT NULL,
  co_signed_by        uuid NOT NULL,
  expires_at          timestamptz NOT NULL DEFAULT (now() + interval '1 hour'),
  consumed_at         timestamptz,
  consumed_entity_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (length(reason) >= 12),
  CHECK (co_signed_by <> actor_user_id)
);

CREATE INDEX IF NOT EXISTS idx_self_action_overrides_lookup
  ON public.self_action_overrides (organization_id, actor_user_id, action_key, expires_at)
  WHERE consumed_at IS NULL;

GRANT SELECT, INSERT ON public.self_action_overrides TO authenticated;
GRANT ALL ON public.self_action_overrides TO service_role;

ALTER TABLE public.self_action_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org admins read self_action_overrides"
  ON public.self_action_overrides FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role)
    OR public.has_role(auth.uid(), organization_id, 'admin'::public.app_role)
    OR public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  );

CREATE POLICY "owners co-sign self_action_overrides"
  ON public.self_action_overrides FOR INSERT TO authenticated
  WITH CHECK (
    co_signed_by = auth.uid()
    AND co_signed_by <> actor_user_id
    AND (
      public.has_role(auth.uid(), organization_id, 'owner'::public.app_role)
      OR public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
    )
  );

CREATE OR REPLACE FUNCTION public.self_action_overrides_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF current_setting('app.self_action_consume', true) = 'true' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'self_action_overrides rows are immutable'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_self_action_overrides_immutable ON public.self_action_overrides;
CREATE TRIGGER trg_self_action_overrides_immutable
  BEFORE UPDATE OR DELETE ON public.self_action_overrides
  FOR EACH ROW EXECUTE FUNCTION public.self_action_overrides_immutable();

-- ----- governance_assert_not_self -----------------------------------------
CREATE OR REPLACE FUNCTION public.governance_assert_not_self(
  p_actor       uuid,
  p_subject     uuid,
  p_action      text,
  p_org         uuid DEFAULT NULL,
  p_entity_type text DEFAULT NULL,
  p_entity_id   uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mode       text;
  v_override   public.self_action_overrides;
  v_actor_role public.app_role;
BEGIN
  IF p_actor IS NULL OR p_subject IS NULL THEN RETURN; END IF;
  IF p_actor <> p_subject THEN RETURN; END IF;

  IF p_org IS NOT NULL AND public._is_teardown_for_org(p_org) THEN
    RETURN;
  END IF;

  IF p_org IS NOT NULL THEN
    SELECT ur.role INTO v_actor_role
      FROM public.user_roles ur
     WHERE ur.user_id = p_actor
       AND ur.organization_id = p_org
       AND ur.is_active = true
     ORDER BY CASE ur.role
       WHEN 'super_admin' THEN 0
       WHEN 'owner'       THEN 1
       WHEN 'admin'       THEN 2
       ELSE 9
     END
     LIMIT 1;

    SELECT mode INTO v_mode
      FROM public.self_action_policy
     WHERE organization_id = p_org
       AND action_key = p_action
       AND (applies_to_role = v_actor_role OR applies_to_role IS NULL)
     ORDER BY (applies_to_role IS NULL) ASC
     LIMIT 1;
  END IF;

  v_mode := COALESCE(v_mode, 'block');

  IF v_mode = 'allow' THEN
    RETURN;
  END IF;

  IF v_mode = 'warn' THEN
    IF p_org IS NOT NULL THEN
      INSERT INTO public.audit_logs(organization_id, user_id, action, entity_type, entity_id, new_values)
      VALUES (p_org, p_actor, 'sod.self_action_warn',
              COALESCE(p_entity_type,'unknown'), p_entity_id,
              jsonb_build_object('action_key', p_action, 'subject', p_subject));
    END IF;
    RETURN;
  END IF;

  -- block or require_cosign: check for a fresh, unconsumed override.
  IF p_org IS NOT NULL THEN
    SELECT * INTO v_override
      FROM public.self_action_overrides o
     WHERE o.organization_id = p_org
       AND o.actor_user_id   = p_actor
       AND o.subject_user_id = p_subject
       AND o.action_key      = p_action
       AND (p_entity_id IS NULL OR o.entity_id IS NULL OR o.entity_id = p_entity_id)
       AND o.expires_at > now()
       AND o.consumed_at IS NULL
     ORDER BY o.created_at DESC
     LIMIT 1
     FOR UPDATE;

    IF FOUND THEN
      PERFORM set_config('app.self_action_consume','true', true);
      UPDATE public.self_action_overrides
         SET consumed_at = now(),
             consumed_entity_id = p_entity_id
       WHERE id = v_override.id;
      PERFORM set_config('app.self_action_consume','false', true);

      INSERT INTO public.audit_logs(organization_id, user_id, action, entity_type, entity_id, new_values)
      VALUES (p_org, p_actor, 'sod.self_action_override_consumed',
              COALESCE(p_entity_type,'unknown'), p_entity_id,
              jsonb_build_object('action_key', p_action,
                                 'override_id', v_override.id,
                                 'co_signed_by', v_override.co_signed_by,
                                 'reason', v_override.reason));
      RETURN;
    END IF;
  END IF;

  IF p_org IS NOT NULL THEN
    INSERT INTO public.audit_logs(organization_id, user_id, action, entity_type, entity_id, new_values)
    VALUES (p_org, p_actor, 'sod.self_action_blocked',
            COALESCE(p_entity_type,'unknown'), p_entity_id,
            jsonb_build_object('action_key', p_action,
                               'subject', p_subject,
                               'mode', v_mode));
  END IF;

  RAISE EXCEPTION
    'Self-action blocked: a user cannot perform % on their own record. A separate approver is required.', p_action
    USING ERRCODE = '42501', HINT = 'GOV_SELF_ACTION';
END;
$$;

GRANT EXECUTE ON FUNCTION public.governance_assert_not_self(uuid,uuid,text,uuid,text,uuid) TO authenticated;

-- ----- governance_assert_not_subject --------------------------------------
CREATE OR REPLACE FUNCTION public.governance_assert_not_subject(
  p_actor       uuid,
  p_employee_id uuid,
  p_action      text,
  p_org         uuid DEFAULT NULL,
  p_entity_type text DEFAULT NULL,
  p_entity_id   uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_subject uuid;
BEGIN
  IF p_actor IS NULL OR p_employee_id IS NULL THEN RETURN; END IF;
  SELECT user_id INTO v_subject FROM public.employees WHERE id = p_employee_id;
  IF v_subject IS NULL THEN RETURN; END IF;
  PERFORM public.governance_assert_not_self(p_actor, v_subject, p_action, p_org, p_entity_type, p_entity_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.governance_assert_not_subject(uuid,uuid,text,uuid,text,uuid) TO authenticated;

-- ----- Seed default policies from legacy per-business payroll setting -----
-- Default row for every org: block self-approval for payroll.approve.
INSERT INTO public.self_action_policy (organization_id, action_key, mode, applies_to_role, notes)
SELECT DISTINCT b.organization_id, 'payroll.approve', 'block', NULL::public.app_role,
       'Seeded from businesses.payroll_self_approval_policy'
  FROM public.businesses b
 WHERE b.organization_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- admin_only orgs: allow owner/admin/super_admin to self-approve.
INSERT INTO public.self_action_policy (organization_id, action_key, mode, applies_to_role, notes)
SELECT DISTINCT b.organization_id, 'payroll.approve', 'allow', r::public.app_role,
       'Seeded: admin_only policy permits self-approval for ' || r
  FROM public.businesses b
  CROSS JOIN unnest(ARRAY['owner','admin','super_admin']) AS r
 WHERE COALESCE(b.payroll_self_approval_policy,'admin_only') = 'admin_only'
   AND b.organization_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- permitted_users orgs: relax the default row to 'allow'.
UPDATE public.self_action_policy p
   SET mode = 'allow',
       notes = 'Seeded: permitted_users policy allows any approver to self-approve payroll'
  FROM public.businesses b
 WHERE p.organization_id = b.organization_id
   AND p.action_key = 'payroll.approve'
   AND p.applies_to_role IS NULL
   AND COALESCE(b.payroll_self_approval_policy,'admin_only') = 'permitted_users';
