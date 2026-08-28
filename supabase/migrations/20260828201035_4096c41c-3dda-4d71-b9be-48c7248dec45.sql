-- R6: the group's translation reserve is a GROUP construct. Where the group
-- keeps its own chart, the reserve must live on a group-chart account instead
-- of borrowing an equity account owned by the parent member company.
ALTER TABLE public.consolidation_groups
  ADD COLUMN IF NOT EXISTS cta_group_account_id uuid
    REFERENCES public.consolidation_group_accounts(id) ON DELETE RESTRICT;

COMMENT ON COLUMN public.consolidation_groups.cta_group_account_id IS
  'Group-chart equity account carrying the cumulative translation reserve. Required when the group uses a group chart; cta_account_id remains the fallback for single-chart groups.';
