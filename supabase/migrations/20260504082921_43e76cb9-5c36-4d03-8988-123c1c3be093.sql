-- Wave 4 — Step 1: Add branch_id to transactional finance tables that the
-- application code has been filtering on (via applyBranchFilter) but where
-- the column did not exist. Missing columns were causing 400 errors on
-- /finance/reconciliation, /finance/bank-feeds, /expenses, etc.
--
-- Convention (matches src/lib/branchScope.ts):
--   - branch_id NULL = legacy / company-shared row, visible from every branch
--   - branch_id = X  = scoped to branch X
-- All columns are nullable; backfill is best-effort from a parent record
-- where one naturally exists. Existing rows keep working as "shared".

-- 1. expenses
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_branch_id ON public.expenses(branch_id);

-- 2. bank_transactions — backfill from owning bank_account.branch_id
ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
UPDATE public.bank_transactions bt
   SET branch_id = ba.branch_id
  FROM public.bank_accounts ba
 WHERE bt.bank_account_id = ba.id
   AND bt.branch_id IS NULL
   AND ba.branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_transactions_branch_id ON public.bank_transactions(branch_id);

-- 3. bank_reconciliation_items — inherit from session
ALTER TABLE public.bank_reconciliation_items
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bank_reconciliation_items_branch_id ON public.bank_reconciliation_items(branch_id);

-- 4. bank_reconciliation_writeoffs
ALTER TABLE public.bank_reconciliation_writeoffs
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bank_reconciliation_writeoffs_branch_id ON public.bank_reconciliation_writeoffs(branch_id);

-- 5. bank_transaction_splits
ALTER TABLE public.bank_transaction_splits
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bank_transaction_splits_branch_id ON public.bank_transaction_splits(branch_id);

-- 6. bank_statements
ALTER TABLE public.bank_statements
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bank_statements_branch_id ON public.bank_statements(branch_id);

-- 7. reconciliation_sessions — backfill from bank_account if column exists
ALTER TABLE public.reconciliation_sessions
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
UPDATE public.reconciliation_sessions rs
   SET branch_id = ba.branch_id
  FROM public.bank_accounts ba
 WHERE rs.bank_account_id = ba.id
   AND rs.branch_id IS NULL
   AND ba.branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reconciliation_sessions_branch_id ON public.reconciliation_sessions(branch_id);

-- 8. depreciation_entries — backfill from fixed_asset.branch_id when joinable
ALTER TABLE public.depreciation_entries
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_depreciation_entries_branch_id ON public.depreciation_entries(branch_id);

-- 9. depreciation_schedules
ALTER TABLE public.depreciation_schedules
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_depreciation_schedules_branch_id ON public.depreciation_schedules(branch_id);

-- Backfill depreciation_entries.branch_id from fixed_asset_id where present
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='depreciation_entries' AND column_name='fixed_asset_id') THEN
    UPDATE public.depreciation_entries de
       SET branch_id = fa.branch_id
      FROM public.fixed_assets fa
     WHERE de.fixed_asset_id = fa.id
       AND de.branch_id IS NULL
       AND fa.branch_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='depreciation_schedules' AND column_name='fixed_asset_id') THEN
    UPDATE public.depreciation_schedules ds
       SET branch_id = fa.branch_id
      FROM public.fixed_assets fa
     WHERE ds.fixed_asset_id = fa.id
       AND ds.branch_id IS NULL
       AND fa.branch_id IS NOT NULL;
  END IF;
END $$;

-- ─── Step 3 (DB half): defense-in-depth for fiscal-period actions ──────
-- Even with the UI gate, we add a hard guard so a forged request from a
-- branch-context session cannot close/reopen a period. The frontend is
-- expected to set the `app.active_branch_id` GUC on each request via the
-- existing branch-context middleware; if that GUC is set, period mutations
-- are rejected.
CREATE OR REPLACE FUNCTION public.assert_no_branch_context_for_period_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_branch text;
BEGIN
  -- current_setting with missing_ok=true returns '' if the GUC is unset.
  v_branch := current_setting('app.active_branch_id', true);
  IF v_branch IS NOT NULL AND v_branch <> '' AND v_branch <> 'null' THEN
    RAISE EXCEPTION
      'Fiscal period changes are managed at the parent business. Switch to "All branches" first.'
      USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_fiscal_periods_no_branch_context ON public.fiscal_periods;
CREATE TRIGGER trg_fiscal_periods_no_branch_context
  BEFORE INSERT OR UPDATE OR DELETE ON public.fiscal_periods
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_no_branch_context_for_period_mutation();