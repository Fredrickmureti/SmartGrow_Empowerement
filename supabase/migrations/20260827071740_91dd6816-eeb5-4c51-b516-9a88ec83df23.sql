ALTER TABLE public.consolidation_group_change_log
  DROP CONSTRAINT consolidation_group_change_log_entity_check;

ALTER TABLE public.consolidation_group_change_log
  ADD CONSTRAINT consolidation_group_change_log_entity_check
  CHECK (entity = ANY (ARRAY['group'::text, 'member'::text, 'group_account'::text, 'mapping'::text, 'intercompany_partner'::text]));

CREATE OR REPLACE FUNCTION public._consolidation_partner_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  v_old jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  v_row jsonb := COALESCE(v_new, v_old);
BEGIN
  INSERT INTO public.consolidation_group_change_log (
    organization_id, group_id, business_id, entity, action, actor_id, before_state, after_state
  ) VALUES (
    (v_row ->> 'organization_id')::uuid,
    (v_row ->> 'group_id')::uuid,
    NULLIF(v_row ->> 'business_id', '')::uuid,
    'intercompany_partner',
    lower(TG_OP),
    auth.uid(),
    v_old,
    v_new
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public._consolidation_partner_log() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER consolidation_intercompany_partners_log
  AFTER INSERT OR UPDATE OR DELETE ON public.consolidation_intercompany_partners
  FOR EACH ROW EXECUTE FUNCTION public._consolidation_partner_log();
