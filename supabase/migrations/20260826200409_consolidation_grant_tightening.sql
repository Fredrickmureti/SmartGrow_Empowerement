-- Consolidation configuration is accounting-significant and never anonymous.
-- These tables were created under the schema-wide default privileges, which
-- handed anon and authenticated full DML. RLS blocked the rows, but privilege
-- and policy must agree.

REVOKE ALL ON public.consolidation_groups FROM anon;
REVOKE ALL ON public.consolidation_group_members FROM anon;
REVOKE ALL ON public.consolidation_group_change_log FROM anon;

-- The audit trail is written by triggers only; signed-in users may read it.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.consolidation_group_change_log FROM authenticated;
GRANT SELECT ON public.consolidation_group_change_log TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.consolidation_groups TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.consolidation_group_members TO authenticated;

GRANT ALL ON public.consolidation_groups TO service_role;
GRANT ALL ON public.consolidation_group_members TO service_role;
GRANT ALL ON public.consolidation_group_change_log TO service_role;
