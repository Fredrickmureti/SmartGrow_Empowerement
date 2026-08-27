-- Brick 4 privilege ratchet: the group chart of accounts and the account
-- mappings were granted to `anon` when they were created. Row level security
-- scopes every policy to `authenticated`, so no row was reachable, but the
-- table-level privilege is inconsistent with every other consolidation object
-- and would become a real exposure the moment a policy were widened.
REVOKE ALL ON public.consolidation_group_accounts FROM anon;
REVOKE ALL ON public.consolidation_account_mappings FROM anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.consolidation_group_accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.consolidation_account_mappings TO authenticated;
GRANT ALL ON public.consolidation_group_accounts TO service_role;
GRANT ALL ON public.consolidation_account_mappings TO service_role;