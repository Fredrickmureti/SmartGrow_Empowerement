-- Brick 4 defect: _consolidation_mapping_log is shared by
-- consolidation_group_accounts and consolidation_account_mappings, but it reads
-- NEW.business_id directly. PL/pgSQL resolves record fields at execution time
-- regardless of the CASE branch taken, so every INSERT/UPDATE/DELETE on
-- consolidation_group_accounts failed with
--   record "new" has no field "business_id"
-- i.e. the group chart of accounts was impossible to populate at all (the table
-- is empty in this database). Read the field out of the jsonb image instead,
-- which is field-agnostic.
CREATE OR REPLACE FUNCTION public._consolidation_mapping_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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
    CASE WHEN TG_TABLE_NAME = 'consolidation_account_mappings' THEN 'mapping' ELSE 'group_account' END,
    lower(TG_OP),
    auth.uid(),
    v_old,
    v_new
  );
  RETURN NULL;
END;
$fn$;