CREATE TABLE public.consolidation_group_change_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  group_id uuid NOT NULL,
  member_id uuid,
  business_id uuid,
  entity text NOT NULL CHECK (entity IN ('group', 'member')),
  action text NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
  actor_id uuid,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX consolidation_group_change_log_group_idx
  ON public.consolidation_group_change_log (group_id, created_at DESC);

GRANT SELECT ON public.consolidation_group_change_log TO authenticated;
GRANT ALL ON public.consolidation_group_change_log TO service_role;

ALTER TABLE public.consolidation_group_change_log ENABLE ROW LEVEL SECURITY;

-- Read-only for users: rows are written exclusively by SECURITY DEFINER triggers,
-- so there is deliberately no INSERT/UPDATE/DELETE policy.
CREATE POLICY consolidation_group_change_log_select
  ON public.consolidation_group_change_log
  FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid(), organization_id)
    AND EXISTS (
      SELECT 1 FROM public.consolidation_groups g
       WHERE g.id = consolidation_group_change_log.group_id
         AND public.user_can_access_business(auth.uid(), g.parent_business_id)
    )
  );

CREATE OR REPLACE FUNCTION public._consolidation_group_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.consolidation_group_change_log (
    organization_id, group_id, entity, action, actor_id, before_state, after_state
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    COALESCE(NEW.id, OLD.id),
    'group',
    lower(TG_OP),
    auth.uid(),
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public._consolidation_group_log() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER consolidation_groups_log
  AFTER INSERT OR UPDATE OR DELETE ON public.consolidation_groups
  FOR EACH ROW EXECUTE FUNCTION public._consolidation_group_log();

CREATE OR REPLACE FUNCTION public._consolidation_member_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.consolidation_group_change_log (
    organization_id, group_id, member_id, business_id,
    entity, action, actor_id, before_state, after_state
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    COALESCE(NEW.group_id, OLD.group_id),
    COALESCE(NEW.id, OLD.id),
    COALESCE(NEW.business_id, OLD.business_id),
    'member',
    lower(TG_OP),
    auth.uid(),
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public._consolidation_member_log() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER consolidation_group_members_log
  AFTER INSERT OR UPDATE OR DELETE ON public.consolidation_group_members
  FOR EACH ROW EXECUTE FUNCTION public._consolidation_member_log();