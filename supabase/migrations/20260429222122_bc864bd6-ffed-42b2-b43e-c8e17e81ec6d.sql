
-- =====================================================================
-- SMS Stage 2 — Recipient groups, configurable rule recipients,
-- canonical recipient resolver, and entity linkage on sms_log.
-- =====================================================================

-- ---------- 1. sms_log: link sends back to the source document ----------
ALTER TABLE public.sms_log
  ADD COLUMN IF NOT EXISTS entity_type text,
  ADD COLUMN IF NOT EXISTS entity_id uuid,
  ADD COLUMN IF NOT EXISTS template_id uuid REFERENCES public.sms_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS triggered_by text NOT NULL DEFAULT 'manual'
    CHECK (triggered_by IN ('manual','automation','test','retry'));

CREATE INDEX IF NOT EXISTS idx_sms_log_entity
  ON public.sms_log (entity_type, entity_id, created_at DESC)
  WHERE entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sms_log_org_nontest
  ON public.sms_log (organization_id, created_at DESC)
  WHERE is_test = false;

-- ---------- 2. Recipient groups ----------
CREATE TABLE IF NOT EXISTS public.sms_recipient_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid,
  name text NOT NULL,
  description text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE INDEX IF NOT EXISTS idx_sms_recipient_groups_org
  ON public.sms_recipient_groups (organization_id);

ALTER TABLE public.sms_recipient_groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org members read recipient groups" ON public.sms_recipient_groups;
CREATE POLICY "Org members read recipient groups"
ON public.sms_recipient_groups FOR SELECT
USING (EXISTS (
  SELECT 1 FROM public.user_roles ur
  WHERE ur.user_id = auth.uid()
    AND ur.organization_id = sms_recipient_groups.organization_id
    AND ur.is_active = true
));

DROP POLICY IF EXISTS "Org admins write recipient groups" ON public.sms_recipient_groups;
CREATE POLICY "Org admins write recipient groups"
ON public.sms_recipient_groups FOR ALL
USING (EXISTS (
  SELECT 1 FROM public.user_roles ur
  WHERE ur.user_id = auth.uid()
    AND ur.organization_id = sms_recipient_groups.organization_id
    AND ur.is_active = true
    AND ur.role IN ('owner','admin','super_admin')
))
WITH CHECK (EXISTS (
  SELECT 1 FROM public.user_roles ur
  WHERE ur.user_id = auth.uid()
    AND ur.organization_id = sms_recipient_groups.organization_id
    AND ur.is_active = true
    AND ur.role IN ('owner','admin','super_admin')
));

DROP TRIGGER IF EXISTS update_sms_recipient_groups_updated_at ON public.sms_recipient_groups;
CREATE TRIGGER update_sms_recipient_groups_updated_at
BEFORE UPDATE ON public.sms_recipient_groups
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------- 3. Recipient group members ----------
CREATE TABLE IF NOT EXISTS public.sms_recipient_group_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.sms_recipient_groups(id) ON DELETE CASCADE,
  member_kind text NOT NULL CHECK (member_kind IN ('user','role','phone')),
  user_id uuid,
  role public.app_role,
  phone text,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (member_kind = 'user'  AND user_id IS NOT NULL AND role IS NULL  AND phone IS NULL) OR
    (member_kind = 'role'  AND role    IS NOT NULL AND user_id IS NULL AND phone IS NULL) OR
    (member_kind = 'phone' AND phone   IS NOT NULL AND user_id IS NULL AND role IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_sms_recipient_group_members_group
  ON public.sms_recipient_group_members (group_id);

ALTER TABLE public.sms_recipient_group_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org members read group members" ON public.sms_recipient_group_members;
CREATE POLICY "Org members read group members"
ON public.sms_recipient_group_members FOR SELECT
USING (EXISTS (
  SELECT 1 FROM public.sms_recipient_groups g
  JOIN public.user_roles ur
    ON ur.organization_id = g.organization_id
   AND ur.user_id = auth.uid()
   AND ur.is_active = true
  WHERE g.id = sms_recipient_group_members.group_id
));

DROP POLICY IF EXISTS "Org admins write group members" ON public.sms_recipient_group_members;
CREATE POLICY "Org admins write group members"
ON public.sms_recipient_group_members FOR ALL
USING (EXISTS (
  SELECT 1 FROM public.sms_recipient_groups g
  JOIN public.user_roles ur
    ON ur.organization_id = g.organization_id
   AND ur.user_id = auth.uid()
   AND ur.is_active = true
   AND ur.role IN ('owner','admin','super_admin')
  WHERE g.id = sms_recipient_group_members.group_id
))
WITH CHECK (EXISTS (
  SELECT 1 FROM public.sms_recipient_groups g
  JOIN public.user_roles ur
    ON ur.organization_id = g.organization_id
   AND ur.user_id = auth.uid()
   AND ur.is_active = true
   AND ur.role IN ('owner','admin','super_admin')
  WHERE g.id = sms_recipient_group_members.group_id
));

-- ---------- 4. Per-rule additional recipients ----------
CREATE TABLE IF NOT EXISTS public.sms_event_rule_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES public.sms_event_rules(id) ON DELETE CASCADE,
  recipient_kind text NOT NULL CHECK (recipient_kind IN ('group','phone','role','user')),
  group_id uuid REFERENCES public.sms_recipient_groups(id) ON DELETE CASCADE,
  phone text,
  role public.app_role,
  user_id uuid,
  is_fallback boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (recipient_kind = 'group' AND group_id IS NOT NULL AND phone IS NULL AND role IS NULL AND user_id IS NULL) OR
    (recipient_kind = 'phone' AND phone    IS NOT NULL AND group_id IS NULL AND role IS NULL AND user_id IS NULL) OR
    (recipient_kind = 'role'  AND role     IS NOT NULL AND group_id IS NULL AND phone IS NULL AND user_id IS NULL) OR
    (recipient_kind = 'user'  AND user_id  IS NOT NULL AND group_id IS NULL AND phone IS NULL AND role IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_sms_event_rule_recipients_rule
  ON public.sms_event_rule_recipients (rule_id);

ALTER TABLE public.sms_event_rule_recipients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org members read rule recipients" ON public.sms_event_rule_recipients;
CREATE POLICY "Org members read rule recipients"
ON public.sms_event_rule_recipients FOR SELECT
USING (EXISTS (
  SELECT 1 FROM public.sms_event_rules r
  JOIN public.user_roles ur
    ON ur.organization_id = r.organization_id
   AND ur.user_id = auth.uid()
   AND ur.is_active = true
  WHERE r.id = sms_event_rule_recipients.rule_id
));

DROP POLICY IF EXISTS "Org admins write rule recipients" ON public.sms_event_rule_recipients;
CREATE POLICY "Org admins write rule recipients"
ON public.sms_event_rule_recipients FOR ALL
USING (EXISTS (
  SELECT 1 FROM public.sms_event_rules r
  JOIN public.user_roles ur
    ON ur.organization_id = r.organization_id
   AND ur.user_id = auth.uid()
   AND ur.is_active = true
   AND ur.role IN ('owner','admin','super_admin')
  WHERE r.id = sms_event_rule_recipients.rule_id
))
WITH CHECK (EXISTS (
  SELECT 1 FROM public.sms_event_rules r
  JOIN public.user_roles ur
    ON ur.organization_id = r.organization_id
   AND ur.user_id = auth.uid()
   AND ur.is_active = true
   AND ur.role IN ('owner','admin','super_admin')
  WHERE r.id = sms_event_rule_recipients.rule_id
));

-- ---------- 5. Canonical recipient resolver ----------
CREATE OR REPLACE FUNCTION public.resolve_rule_recipients(
  p_org_id uuid,
  p_event public.sms_event_type,
  p_entity_type text DEFAULT NULL,
  p_entity_id uuid DEFAULT NULL,
  p_primary_contact_id uuid DEFAULT NULL,
  p_primary_phone text DEFAULT NULL
) RETURNS TABLE(
  phone text,
  recipient_kind text,
  source text,
  contact_id uuid,
  user_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rule_id uuid;
  v_rule_recipient_type public.sms_recipient_type;
  v_primary_count int := 0;
BEGIN
  SELECT r.id, r.recipient_type
    INTO v_rule_id, v_rule_recipient_type
  FROM public.sms_event_rules r
  WHERE r.organization_id = p_org_id
    AND r.event_type = p_event
    AND r.is_enabled = true
  LIMIT 1;

  IF v_rule_id IS NULL THEN
    RETURN; -- rule disabled / missing
  END IF;

  -- Build a temp working set
  CREATE TEMP TABLE IF NOT EXISTS _rcpt(
    phone text, recipient_kind text, source text, contact_id uuid, user_id uuid, is_fallback boolean
  ) ON COMMIT DROP;
  TRUNCATE _rcpt;

  -- ── 1. Primary recipient (rule.recipient_type) ──
  IF p_primary_phone IS NOT NULL AND length(trim(p_primary_phone)) > 0 THEN
    INSERT INTO _rcpt VALUES (p_primary_phone, v_rule_recipient_type::text, 'primary_override', p_primary_contact_id, NULL, false);
  ELSIF v_rule_recipient_type IN ('customer','vendor') AND p_primary_contact_id IS NOT NULL THEN
    INSERT INTO _rcpt
    SELECT c.phone, v_rule_recipient_type::text, 'primary_contact', c.id, NULL, false
    FROM public.contacts c
    WHERE c.id = p_primary_contact_id
      AND c.phone IS NOT NULL
      AND COALESCE(c.sms_consent, true) = true;
  ELSIF v_rule_recipient_type = 'employee' AND p_primary_contact_id IS NOT NULL THEN
    INSERT INTO _rcpt
    SELECT COALESCE(e.personal_phone, e.phone), 'employee', 'primary_employee', NULL, NULL, false
    FROM public.employees e
    WHERE e.id = p_primary_contact_id
      AND COALESCE(e.personal_phone, e.phone) IS NOT NULL
      AND COALESCE(e.sms_consent, true) = true;
  ELSIF v_rule_recipient_type = 'internal' THEN
    -- Internal default = all owners/admins of the org with a phone in their profile
    INSERT INTO _rcpt
    SELECT p.phone, 'internal', 'primary_internal', NULL, ur.user_id, false
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.organization_id = p_org_id
      AND ur.is_active = true
      AND ur.role IN ('owner','admin')
      AND p.phone IS NOT NULL;
  END IF;

  SELECT count(*) INTO v_primary_count FROM _rcpt WHERE is_fallback = false;

  -- ── 2. Additional rule recipients ──
  FOR v_rule_id IN SELECT id FROM public.sms_event_rules WHERE id = v_rule_id LOOP
    -- direct phone
    INSERT INTO _rcpt
    SELECT rr.phone, 'phone', 'rule_phone', NULL, NULL, rr.is_fallback
    FROM public.sms_event_rule_recipients rr
    WHERE rr.rule_id = v_rule_id AND rr.recipient_kind = 'phone'
      AND rr.phone IS NOT NULL;

    -- direct user
    INSERT INTO _rcpt
    SELECT p.phone, 'user', 'rule_user', NULL, p.id, rr.is_fallback
    FROM public.sms_event_rule_recipients rr
    JOIN public.profiles p ON p.id = rr.user_id
    WHERE rr.rule_id = v_rule_id AND rr.recipient_kind = 'user'
      AND p.phone IS NOT NULL;

    -- role expansion (org-scoped)
    INSERT INTO _rcpt
    SELECT p.phone, 'role', 'rule_role:' || rr.role::text, NULL, ur.user_id, rr.is_fallback
    FROM public.sms_event_rule_recipients rr
    JOIN public.user_roles ur ON ur.role = rr.role
                              AND ur.organization_id = p_org_id
                              AND ur.is_active = true
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE rr.rule_id = v_rule_id AND rr.recipient_kind = 'role'
      AND p.phone IS NOT NULL;

    -- group expansion
    INSERT INTO _rcpt
    SELECT m.phone, 'group_phone', 'rule_group:' || g.name, NULL, NULL, rr.is_fallback
    FROM public.sms_event_rule_recipients rr
    JOIN public.sms_recipient_groups g ON g.id = rr.group_id
    JOIN public.sms_recipient_group_members m ON m.group_id = g.id
    WHERE rr.rule_id = v_rule_id AND rr.recipient_kind = 'group'
      AND m.member_kind = 'phone' AND m.phone IS NOT NULL;

    INSERT INTO _rcpt
    SELECT p.phone, 'group_user', 'rule_group:' || g.name, NULL, p.id, rr.is_fallback
    FROM public.sms_event_rule_recipients rr
    JOIN public.sms_recipient_groups g ON g.id = rr.group_id
    JOIN public.sms_recipient_group_members m ON m.group_id = g.id
    JOIN public.profiles p ON p.id = m.user_id
    WHERE rr.rule_id = v_rule_id AND rr.recipient_kind = 'group'
      AND m.member_kind = 'user' AND p.phone IS NOT NULL;

    INSERT INTO _rcpt
    SELECT p.phone, 'group_role', 'rule_group:' || g.name || ':' || m.role::text, NULL, ur.user_id, rr.is_fallback
    FROM public.sms_event_rule_recipients rr
    JOIN public.sms_recipient_groups g ON g.id = rr.group_id
    JOIN public.sms_recipient_group_members m ON m.group_id = g.id
    JOIN public.user_roles ur ON ur.role = m.role
                              AND ur.organization_id = p_org_id
                              AND ur.is_active = true
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE rr.rule_id = v_rule_id AND rr.recipient_kind = 'group'
      AND m.member_kind = 'role' AND p.phone IS NOT NULL;
  END LOOP;

  -- ── 3. Drop fallback rows if we already have any primary/non-fallback recipients ──
  IF (SELECT count(*) FROM _rcpt WHERE is_fallback = false) > 0 THEN
    DELETE FROM _rcpt WHERE is_fallback = true;
  END IF;

  -- ── 4. Drop opted-out phones ──
  DELETE FROM _rcpt
  WHERE phone IN (
    SELECT phone_number FROM public.sms_opt_outs WHERE organization_id = p_org_id
  );

  -- ── 5. Return de-duplicated by phone ──
  RETURN QUERY
  SELECT DISTINCT ON (r.phone) r.phone, r.recipient_kind, r.source, r.contact_id, r.user_id
  FROM _rcpt r
  WHERE r.phone IS NOT NULL AND length(trim(r.phone)) > 0
  ORDER BY r.phone, r.is_fallback ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_rule_recipients(uuid, public.sms_event_type, text, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_rule_recipients(uuid, public.sms_event_type, text, uuid, uuid, text) TO service_role;
