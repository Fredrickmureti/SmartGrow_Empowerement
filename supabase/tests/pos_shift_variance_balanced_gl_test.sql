-- POS cash variance GL posting must be balanced and enterprise-safe.
--
-- A variance is not a standalone P&L line. It changes the physical cash
-- drawer balance and offsets that movement to Cash Over/Short:
--   overage:   Dr Cash Drawer,       Cr Cash Over/Short
--   shortage:  Dr Cash Over/Short,   Cr Cash Drawer
-- This test pins that contract so future migrations cannot reintroduce
-- unbalanced shift-close journals.
\set ON_ERROR_STOP on

DO $$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef('public.post_pos_shift_gl(uuid)'::regprocedure)
    INTO v_src;

  IF position('ensure_cash_short_over_account' IN v_src) = 0 THEN
    RAISE EXCEPTION 'post_pos_shift_gl must auto-provision/resolve Cash Over/Short before posting variance';
  END IF;

  IF position('Cash overage deposited' IN v_src) = 0
     OR position('Cash overage' IN v_src) = 0 THEN
    RAISE EXCEPTION 'cash overage must post both drawer debit and Cash Over/Short credit lines';
  END IF;

  IF position('Cash shortage removed from drawer' IN v_src) = 0
     OR position('Cash shortage' IN v_src) = 0 THEN
    RAISE EXCEPTION 'cash shortage must post both Cash Over/Short debit and drawer credit lines';
  END IF;

  IF position('v_total_sales = 0 THEN RETURN NULL' IN v_src) > 0 THEN
    RAISE EXCEPTION 'post_pos_shift_gl must not skip variance-only closes just because sales are zero';
  END IF;

  IF position('v_cash_variance_account = v_cash_short_over_account' IN v_src) = 0 THEN
    RAISE EXCEPTION 'drawer cash and Cash Over/Short must be guarded against mapping to the same account';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.system_account_roles
    WHERE role_key = 'cash_short_over'
      AND required_account_type = 'expense'
  ) THEN
    RAISE EXCEPTION 'cash_short_over must be registered as an expense system account role';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.account_role_eligibility
    WHERE role_key = 'cash_short_over'
      AND account_type = 'expense'
  ) THEN
    RAISE EXCEPTION 'cash_short_over must expose eligible expense detail types for Account Mapping UI';
  END IF;
END $$;