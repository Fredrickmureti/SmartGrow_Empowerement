
-- POS Stage B3-complete: extend caller-authority triggers to the money-handling
-- and audit surfaces (transactions, line items, payments, drawer events, cash
-- movements, manager overrides). The generic trigger function from migration
-- 20260516115704 reads NEW.branch_id, falls back to parent register via
-- register_id, and calls assert_pos_caller_branch_access. All six tables below
-- carry branch_id directly (verified via information_schema), so the existing
-- function works unchanged. Triggers are named zzz_* so they fire after any
-- existing BEFORE-trigger that stamps branch_id from the parent register.

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'pos_transactions',
    'pos_transaction_items',
    'pos_transaction_payments',
    'pos_drawer_events',
    'pos_cash_movements',
    'pos_manager_overrides'
  ])
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS zzz_assert_pos_branch_caller_access ON public.%I', t
    );
    EXECUTE format(
      'CREATE TRIGGER zzz_assert_pos_branch_caller_access
         BEFORE INSERT OR UPDATE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.tg_assert_pos_branch_caller_access()', t
    );
  END LOOP;
END $$;

COMMENT ON TRIGGER zzz_assert_pos_branch_caller_access ON public.pos_transactions IS
  'POS Stage B3-complete: blocks cross-branch transaction writes at the DB layer. '
  'service_role / auth.uid()=NULL contexts bypass.';
