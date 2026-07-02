-- Stage 1: SMS rules uniqueness + recipient resolver fix + audit trail.
-- 1) Dedup + uniqueness
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY organization_id, event_type
           ORDER BY (is_enabled)::int DESC, created_at ASC
         ) AS rn
  FROM public.sms_event_rules
)
DELETE FROM public.sms_event_rules r
USING ranked
WHERE r.id = ranked.id AND ranked.rn > 1;

UPDATE public.sms_event_rules SET business_id = NULL WHERE business_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS sms_event_rules_org_event_uniq
  ON public.sms_event_rules (organization_id, event_type);

-- 2) Recipient resolver — pure SQL, STABLE, no temp tables
CREATE OR REPLACE FUNCTION public.resolve_rule_recipients(
  p_org_id uuid,
  p_event public.sms_event_type,
  p_entity_type text DEFAULT NULL,
  p_entity_id uuid DEFAULT NULL,
  p_primary_contact_id uuid DEFAULT NULL,
  p_primary_phone text DEFAULT NULL
)
RETURNS TABLE(phone text, recipient_kind text, source text, contact_id uuid, user_id uuid)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH rule AS (
    SELECT r.id AS rule_id, r.recipient_type
    FROM public.sms_event_rules r
    WHERE r.organization_id = p_org_id
      AND r.event_type = p_event
      AND r.is_enabled = true
    LIMIT 1
  ),
  primary_rcpt AS (
    SELECT p_primary_phone AS phone,
           rule.recipient_type::text AS recipient_kind,
           'primary_override'::text AS source,
           p_primary_contact_id AS contact_id,
           NULL::uuid AS user_id,
           false AS is_fallback
    FROM rule
    WHERE p_primary_phone IS NOT NULL AND length(trim(p_primary_phone)) > 0
    UNION ALL
    SELECT c.phone, rule.recipient_type::text, 'primary_contact', c.id, NULL, false
    FROM rule
    JOIN public.contacts c ON c.id = p_primary_contact_id
    WHERE rule.recipient_type IN ('customer','vendor')
      AND p_primary_contact_id IS NOT NULL
      AND (p_primary_phone IS NULL OR length(trim(p_primary_phone)) = 0)
      AND c.phone IS NOT NULL
      AND COALESCE(c.sms_consent, true) = true
    UNION ALL
    SELECT COALESCE(e.personal_phone, e.phone), 'employee', 'primary_employee', NULL, NULL, false
    FROM rule
    JOIN public.employees e ON e.id = p_primary_contact_id
    WHERE rule.recipient_type = 'employee'
      AND p_primary_contact_id IS NOT NULL
      AND (p_primary_phone IS NULL OR length(trim(p_primary_phone)) = 0)
      AND COALESCE(e.personal_phone, e.phone) IS NOT NULL
      AND COALESCE(e.sms_consent, true) = true
    UNION ALL
    SELECT pr.phone, 'internal', 'primary_internal', NULL, ur.user_id, false
    FROM rule
    JOIN public.user_roles ur ON ur.organization_id = p_org_id
                              AND ur.is_active = true
                              AND ur.role IN ('owner','admin')
    JOIN public.profiles pr ON pr.id = ur.user_id
    WHERE rule.recipient_type = 'internal'
      AND (p_primary_phone IS NULL OR length(trim(p_primary_phone)) = 0)
      AND pr.phone IS NOT NULL
  ),
  rule_phone AS (
    SELECT rr.phone, 'phone'::text AS recipient_kind, 'rule_phone'::text AS source,
           NULL::uuid AS contact_id, NULL::uuid AS user_id, rr.is_fallback
    FROM rule
    JOIN public.sms_event_rule_recipients rr ON rr.rule_id = rule.rule_id
    WHERE rr.recipient_kind = 'phone' AND rr.phone IS NOT NULL
  ),
  rule_user AS (
    SELECT pr.phone, 'user', 'rule_user', NULL::uuid, pr.id, rr.is_fallback
    FROM rule
    JOIN public.sms_event_rule_recipients rr ON rr.rule_id = rule.rule_id
    JOIN public.profiles pr ON pr.id = rr.user_id
    WHERE rr.recipient_kind = 'user' AND pr.phone IS NOT NULL
  ),
  rule_role AS (
    SELECT pr.phone, 'role', 'rule_role:' || rr.role::text, NULL::uuid, ur.user_id, rr.is_fallback
    FROM rule
    JOIN public.sms_event_rule_recipients rr ON rr.rule_id = rule.rule_id
    JOIN public.user_roles ur ON ur.role = rr.role
                              AND ur.organization_id = p_org_id
                              AND ur.is_active = true
    JOIN public.profiles pr ON pr.id = ur.user_id
    WHERE rr.recipient_kind = 'role' AND pr.phone IS NOT NULL
  ),
  rule_group_phone AS (
    SELECT m.phone, 'group_phone', 'rule_group:' || g.name, NULL::uuid, NULL::uuid, rr.is_fallback
    FROM rule
    JOIN public.sms_event_rule_recipients rr ON rr.rule_id = rule.rule_id
    JOIN public.sms_recipient_groups g ON g.id = rr.group_id
    JOIN public.sms_recipient_group_members m ON m.group_id = g.id
    WHERE rr.recipient_kind = 'group'
      AND m.member_kind = 'phone' AND m.phone IS NOT NULL
  ),
  rule_group_user AS (
    SELECT pr.phone, 'group_user', 'rule_group:' || g.name, NULL::uuid, pr.id, rr.is_fallback
    FROM rule
    JOIN public.sms_event_rule_recipients rr ON rr.rule_id = rule.rule_id
    JOIN public.sms_recipient_groups g ON g.id = rr.group_id
    JOIN public.sms_recipient_group_members m ON m.group_id = g.id
    JOIN public.profiles pr ON pr.id = m.user_id
    WHERE rr.recipient_kind = 'group'
      AND m.member_kind = 'user' AND pr.phone IS NOT NULL
  ),
  rule_group_role AS (
    SELECT pr.phone, 'group_role', 'rule_group:' || g.name || ':' || m.role::text, NULL::uuid, ur.user_id, rr.is_fallback
    FROM rule
    JOIN public.sms_event_rule_recipients rr ON rr.rule_id = rule.rule_id
    JOIN public.sms_recipient_groups g ON g.id = rr.group_id
    JOIN public.sms_recipient_group_members m ON m.group_id = g.id
    JOIN public.user_roles ur ON ur.role = m.role
                              AND ur.organization_id = p_org_id
                              AND ur.is_active = true
    JOIN public.profiles pr ON pr.id = ur.user_id
    WHERE rr.recipient_kind = 'group'
      AND m.member_kind = 'role' AND pr.phone IS NOT NULL
  ),
  unioned AS (
    SELECT * FROM primary_rcpt
    UNION ALL SELECT * FROM rule_phone
    UNION ALL SELECT * FROM rule_user
    UNION ALL SELECT * FROM rule_role
    UNION ALL SELECT * FROM rule_group_phone
    UNION ALL SELECT * FROM rule_group_user
    UNION ALL SELECT * FROM rule_group_role
  ),
  has_primary AS (
    SELECT bool_or(NOT is_fallback) AS any_primary FROM unioned
  ),
  filtered AS (
    SELECT u.*
    FROM unioned u, has_primary hp
    WHERE u.phone IS NOT NULL
      AND length(trim(u.phone)) > 0
      AND (NOT u.is_fallback OR COALESCE(hp.any_primary, false) = false)
      AND u.phone NOT IN (SELECT phone_number FROM public.sms_opt_outs WHERE organization_id = p_org_id)
  )
  SELECT DISTINCT ON (f.phone)
         f.phone, f.recipient_kind, f.source, f.contact_id, f.user_id
  FROM filtered f
  ORDER BY f.phone, f.is_fallback ASC;
$$;

COMMENT ON FUNCTION public.resolve_rule_recipients IS
  'Resolve all configured SMS recipients for a rule. Pure SQL, STABLE, no temp tables.';

-- 3) Audit trigger on rule mutations
CREATE OR REPLACE FUNCTION public.tg_audit_sms_event_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  BEGIN
    INSERT INTO public.settings_audit_log (
      organization_id, actor_id, setting_scope, setting_key,
      table_name, record_id, old_value, new_value
    ) VALUES (
      COALESCE(NEW.organization_id, OLD.organization_id),
      auth.uid(),
      'sms',
      'sms_event_rule:' || COALESCE(NEW.event_type, OLD.event_type)::text,
      'sms_event_rules',
      COALESCE(NEW.id, OLD.id),
      CASE WHEN OLD IS NOT NULL THEN to_jsonb(OLD) END,
      CASE WHEN NEW IS NOT NULL THEN to_jsonb(NEW) END
    );
  EXCEPTION WHEN OTHERS THEN
    -- Never block the rule write because of audit issues
    NULL;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_sms_event_rules ON public.sms_event_rules;
CREATE TRIGGER trg_audit_sms_event_rules
AFTER INSERT OR UPDATE OR DELETE ON public.sms_event_rules
FOR EACH ROW EXECUTE FUNCTION public.tg_audit_sms_event_rules();