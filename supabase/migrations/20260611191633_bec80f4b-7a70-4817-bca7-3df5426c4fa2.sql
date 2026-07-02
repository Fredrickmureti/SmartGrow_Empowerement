-- =========================================================================
-- SoD Wave G3 — Governance Mode (solo / standard / strict)
-- Default-allow for solo owners, smooth opt-in to stricter SoD.
-- =========================================================================

-- 1. Column + check ------------------------------------------------------
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS governance_mode text NOT NULL DEFAULT 'solo';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'organizations_governance_mode_check'
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_governance_mode_check
      CHECK (governance_mode IN ('solo','standard','strict'));
  END IF;
END $$;

-- 2. Backfill ------------------------------------------------------------
-- Orgs with 2+ active members → 'standard'. Everyone else stays 'solo'.
UPDATE public.organizations o
   SET governance_mode = 'standard'
 WHERE governance_mode = 'solo'
   AND (
     SELECT count(*) FROM public.user_roles ur
      WHERE ur.organization_id = o.id
        AND ur.is_active = true
   ) >= 2;

-- 3. Auto-promotion trigger on user_roles -------------------------------
CREATE OR REPLACE FUNCTION public.promote_governance_mode_on_member_add()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org   uuid := NEW.organization_id;
  v_count int;
  v_mode  text;
BEGIN
  -- Only act on becoming-active rows.
  IF NEW.is_active IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  SELECT governance_mode INTO v_mode
    FROM public.organizations WHERE id = v_org;

  IF v_mode <> 'solo' THEN
    RETURN NEW;
  END IF;

  SELECT count(DISTINCT user_id) INTO v_count
    FROM public.user_roles
   WHERE organization_id = v_org
     AND is_active = true;

  IF v_count >= 2 THEN
    UPDATE public.organizations
       SET governance_mode = 'standard'
     WHERE id = v_org
       AND governance_mode = 'solo';

    INSERT INTO public.audit_logs(organization_id, user_id, action, entity_type, entity_id, new_values)
    VALUES (v_org, NEW.user_id, 'sod.governance_mode_changed',
            'organization', v_org,
            jsonb_build_object('from','solo','to','standard','trigger','second_member_added'));
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_promote_governance_mode_on_member_add ON public.user_roles;
CREATE TRIGGER trg_promote_governance_mode_on_member_add
  AFTER INSERT OR UPDATE OF is_active ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.promote_governance_mode_on_member_add();

-- 4. Mode-aware governance_assert_not_self ------------------------------
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
  v_mode          text;
  v_override      public.self_action_overrides;
  v_actor_role    public.app_role;
  v_org_mode      text;
  v_member_count  int;
  v_policy_exists boolean;
BEGIN
  IF p_actor IS NULL OR p_subject IS NULL THEN RETURN; END IF;
  IF p_actor <> p_subject THEN RETURN; END IF;

  IF p_org IS NOT NULL AND public._is_teardown_for_org(p_org) THEN
    RETURN;
  END IF;

  IF p_org IS NOT NULL THEN
    -- Resolve actor's highest role in this org.
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

    -- Explicit policy row (role-specific preferred over default).
    SELECT mode INTO v_mode
      FROM public.self_action_policy
     WHERE organization_id = p_org
       AND action_key = p_action
       AND (applies_to_role = v_actor_role OR applies_to_role IS NULL)
     ORDER BY (applies_to_role IS NULL) ASC
     LIMIT 1;

    v_policy_exists := v_mode IS NOT NULL;

    -- No explicit row → derive default from org governance_mode.
    IF v_mode IS NULL THEN
      SELECT governance_mode INTO v_org_mode
        FROM public.organizations WHERE id = p_org;
      v_org_mode := COALESCE(v_org_mode, 'standard');

      IF v_org_mode = 'solo' THEN
        SELECT count(DISTINCT user_id) INTO v_member_count
          FROM public.user_roles
         WHERE organization_id = p_org AND is_active = true;

        IF v_member_count <= 1 THEN
          -- Audit (auto-allow) and return without raising.
          INSERT INTO public.audit_logs(organization_id, user_id, action, entity_type, entity_id, new_values)
          VALUES (p_org, p_actor, 'sod.self_action_auto_allowed',
                  COALESCE(p_entity_type,'unknown'), p_entity_id,
                  jsonb_build_object('action_key', p_action,
                                     'reason', 'solo_org',
                                     'governance_mode', v_org_mode));
          RETURN;
        ELSE
          v_mode := 'allow';
        END IF;
      ELSIF v_org_mode = 'standard' THEN
        IF v_actor_role IN ('owner','super_admin') THEN
          v_mode := 'warn';
        ELSIF v_actor_role = 'admin' THEN
          v_mode := 'warn';
        ELSE
          v_mode := 'block';
        END IF;
      ELSE -- strict
        v_mode := 'block';
      END IF;
    END IF;
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
              jsonb_build_object('action_key', p_action, 'subject', p_subject,
                                 'source', CASE WHEN v_policy_exists THEN 'policy' ELSE 'mode_default' END));
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
                               'mode', v_mode,
                               'source', CASE WHEN v_policy_exists THEN 'policy' ELSE 'mode_default' END));
  END IF;

  RAISE EXCEPTION
    'Self-action blocked: a user cannot perform % on their own record. A separate approver is required.', p_action
    USING ERRCODE = '42501', HINT = 'GOV_SELF_ACTION';
END;
$$;

GRANT EXECUTE ON FUNCTION public.governance_assert_not_self(uuid,uuid,text,uuid,text,uuid) TO authenticated;
