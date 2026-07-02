-- Regression: accounts.system_role / is_system can only be mutated by
-- functions on the enforce_system_account_helper allowlist. Direct DML
-- from a non-allowlisted SECURITY DEFINER caller must be rejected even
-- if it sets the legacy `app.upsert_system_account.in_progress` GUC.

BEGIN;

DO $$
DECLARE
  v_org   uuid := gen_random_uuid();
  v_biz   uuid := gen_random_uuid();
  v_id    uuid;
  v_raised boolean := false;
BEGIN
  -- 1. Direct INSERT with system_role from a non-allowlisted context is rejected.
  BEGIN
    INSERT INTO public.accounts (
      organization_id, business_id, account_type, detail_type,
      code, name, is_system, is_active, opening_balance, current_balance, system_role
    ) VALUES (
      v_org, v_biz, 'expense'::public.account_type, 'cost_of_goods_sold',
      'TEST-COGS', 'Test COGS', true, true, 0, 0, 'cogs'
    );
  EXCEPTION WHEN check_violation THEN
    v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'expected check_violation when inserting system_role outside allowlist';
  END IF;

  -- 2. The legacy GUC must NOT be honoured anymore.
  v_raised := false;
  PERFORM set_config('app.upsert_system_account.in_progress', '1', true);
  BEGIN
    INSERT INTO public.accounts (
      organization_id, business_id, account_type, detail_type,
      code, name, is_system, is_active, opening_balance, current_balance, system_role
    ) VALUES (
      v_org, v_biz, 'expense'::public.account_type, 'cost_of_goods_sold',
      'TEST-COGS-2', 'Test COGS 2', true, true, 0, 0, 'cogs'
    );
  EXCEPTION WHEN check_violation THEN
    v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'GUC bypass must no longer be honoured';
  END IF;

  RAISE NOTICE 'system_account_helper allowlist invariant holds';
END;
$$;

ROLLBACK;
