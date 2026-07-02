-- Phase 0.5: Plug branch-isolation leaks left by previous Phase 0.
-- Drops legacy permissive RLS policies that OR'd around the branch-aware ones,
-- and adds branch-aware predicates to budgets, vendor_credit_notes, and the
-- jel_*_perm legacy line-level policies.

-- 1. fixed_assets — drop legacy org-level catch-alls
DROP POLICY IF EXISTS org_fixed_assets_select   ON public.fixed_assets;
DROP POLICY IF EXISTS org_fixed_assets_insert   ON public.fixed_assets;
DROP POLICY IF EXISTS org_fixed_assets_update   ON public.fixed_assets;
DROP POLICY IF EXISTS org_fixed_assets_delete   ON public.fixed_assets;

-- 2. depreciation_entries — same
DROP POLICY IF EXISTS org_depreciation_entries_select ON public.depreciation_entries;
DROP POLICY IF EXISTS org_depreciation_entries_insert ON public.depreciation_entries;
DROP POLICY IF EXISTS org_depreciation_entries_update ON public.depreciation_entries;
DROP POLICY IF EXISTS org_depreciation_entries_delete ON public.depreciation_entries;

-- 3. journal_entry_lines — drop the loose jel_*_perm and legacy policies; the _v2
--    policies already enforce branch via the parent JE.
DROP POLICY IF EXISTS jel_select_perm ON public.journal_entry_lines;
DROP POLICY IF EXISTS jel_insert_perm ON public.journal_entry_lines;
DROP POLICY IF EXISTS jel_update_perm ON public.journal_entry_lines;
DROP POLICY IF EXISTS jel_delete_perm ON public.journal_entry_lines;
DROP POLICY IF EXISTS "Users can delete journal entry lines" ON public.journal_entry_lines;
DROP POLICY IF EXISTS "Users can update journal entry lines" ON public.journal_entry_lines;
DROP POLICY IF EXISTS "Users can create journal entry lines" ON public.journal_entry_lines;

-- 4. budgets — branch_id exists on the table; add branch-aware predicates
ALTER TABLE public.budgets ADD COLUMN IF NOT EXISTS branch_id uuid;

DROP POLICY IF EXISTS budgets_select_v2 ON public.budgets;
DROP POLICY IF EXISTS budgets_update_v2 ON public.budgets;
DROP POLICY IF EXISTS budgets_delete_v2 ON public.budgets;
DROP POLICY IF EXISTS budgets_insert_v2 ON public.budgets;

CREATE POLICY budgets_select_v2 ON public.budgets FOR SELECT
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'read')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

CREATE POLICY budgets_insert_v2 ON public.budgets FOR INSERT
WITH CHECK (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'create')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

CREATE POLICY budgets_update_v2 ON public.budgets FOR UPDATE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'write')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
)
WITH CHECK (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'write')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

CREATE POLICY budgets_delete_v2 ON public.budgets FOR DELETE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'delete')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

-- 5. vendor_credit_notes — INSERT WITH CHECK currently lacks branch check
DROP POLICY IF EXISTS vcn_insert_perm ON public.vendor_credit_notes;
CREATE POLICY vcn_insert_v2 ON public.vendor_credit_notes FOR INSERT
WITH CHECK (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'create')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

-- 6. fixed_assets / depreciation_entries — tighten INSERT WITH CHECK as well
DROP POLICY IF EXISTS fixed_assets_insert_perm ON public.fixed_assets;
CREATE POLICY fixed_assets_insert_perm ON public.fixed_assets FOR INSERT
WITH CHECK (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'create')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

-- 7. Self-asserting guard: every table in the branch-scoped set must have
--    each active SELECT policy reference user_can_access_branch OR
--    has_finance_permission.
DO $$
DECLARE
  rec record;
  bad text := '';
BEGIN
  FOR rec IN
    SELECT tablename, policyname, qual::text AS q
    FROM pg_policies
    WHERE schemaname='public'
      AND cmd='SELECT'
      AND tablename IN (
        'invoices','payments','credit_notes','journal_entries','journal_entry_lines',
        'budgets','fixed_assets','depreciation_entries','vendor_credit_notes',
        'bank_accounts','bank_transactions','bills','bill_payments'
      )
  LOOP
    -- Allow platform-admin / subscription / block_* / superuser policies through
    IF rec.policyname ILIKE 'Platform%' OR rec.policyname ILIKE 'block_%' OR rec.policyname ILIKE 'Subscription%' THEN
      CONTINUE;
    END IF;
    IF rec.q !~ '(user_can_access_branch|has_finance_permission)' THEN
      bad := bad || format(' [%s.%s]', rec.tablename, rec.policyname);
    END IF;
  END LOOP;

  IF length(bad) > 0 THEN
    RAISE EXCEPTION 'Phase 0.5 guard failed — branch-leaking SELECT policies still active:%', bad;
  END IF;
END $$;
