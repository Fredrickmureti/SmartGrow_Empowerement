-- Stage C closeout — structural self-tests for shift correctness.
-- These assert the canonical surface (RPCs, view, partial unique indexes,
-- RLS posture). Full end-to-end fixtures live alongside vitest.

-- 1) Partial unique indexes that enforce one open shift per register and
--    per cashier.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE indexname = 'uq_pos_shifts_one_open_per_register') THEN
    RAISE EXCEPTION 'missing partial unique index uq_pos_shifts_one_open_per_register';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE indexname = 'uq_pos_shifts_one_open_per_cashier') THEN
    RAISE EXCEPTION 'missing partial unique index uq_pos_shifts_one_open_per_cashier';
  END IF;
END $$;

-- 2) Status-flip guard trigger exists.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'trg_pos_shifts_no_client_status_flip') THEN
    RAISE EXCEPTION 'missing trg_pos_shifts_no_client_status_flip';
  END IF;
END $$;

-- 3) Canonical RPCs exist with the expected signatures.
DO $$
DECLARE
  v_args text;
BEGIN
  SELECT pg_get_function_identity_arguments('public.close_pos_shift'::regproc) INTO v_args;
  IF position('p_manager_override_id uuid' IN v_args) = 0
     OR position('p_blind_close boolean'      IN v_args) = 0
     OR position('p_denomination_counted boolean' IN v_args) = 0 THEN
    RAISE EXCEPTION 'close_pos_shift signature drift: %', v_args;
  END IF;

  PERFORM 'public.can_close_pos_shift(uuid)'::regprocedure;
  PERFORM 'public.force_close_pos_shift(uuid,text,uuid,numeric)'::regprocedure;
  PERFORM 'public.reopen_pos_shift(uuid)'::regprocedure;
END $$;

-- 3b) force_close_pos_shift must store approved override ids in the
--     override-history FK, not in the legacy manager-PIN FK.
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname='force_close_pos_shift';
  IF v_src LIKE '%variance_override_pin_id%' THEN
    RAISE EXCEPTION 'force_close_pos_shift must not write override ids into variance_override_pin_id';
  END IF;
  IF v_src NOT LIKE '%variance_override_id%' THEN
    RAISE EXCEPTION 'force_close_pos_shift missing variance_override_id audit link';
  END IF;
END $$;

-- 4) close_pos_shift body wires the gate, expected-cash view, manager
--    override, and denomination policy.
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname='close_pos_shift';
  IF v_src NOT LIKE '%can_close_pos_shift%'        THEN RAISE EXCEPTION 'close_pos_shift missing gate call'; END IF;
  IF v_src NOT LIKE '%v_pos_cash_expected%'        THEN RAISE EXCEPTION 'close_pos_shift missing expected-cash read'; END IF;
  IF v_src NOT LIKE '%assert_manager_override%'    THEN RAISE EXCEPTION 'close_pos_shift missing override assertion'; END IF;
  IF v_src NOT LIKE '%require_denomination_count%' THEN RAISE EXCEPTION 'close_pos_shift missing denomination policy'; END IF;
  IF v_src NOT LIKE '%pos.allow_close%'            THEN RAISE EXCEPTION 'close_pos_shift missing status-flip override token'; END IF;
END $$;

-- 5) Blockers covered by can_close_pos_shift: held orders + in-flight txns.
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname='can_close_pos_shift';
  IF v_src NOT LIKE '%pos_held_transactions%' THEN RAISE EXCEPTION 'gate missing held-orders check'; END IF;
  IF v_src NOT LIKE '%pending_transactions%'   THEN RAISE EXCEPTION 'gate missing in-flight check'; END IF;
  IF v_src NOT LIKE '%user_has_module_permission%' THEN RAISE EXCEPTION 'gate missing permission check'; END IF;
END $$;

-- 6) v_pos_cash_expected exposes the columns CloseShiftDialog reads.
DO $$
BEGIN
  PERFORM shift_id, opening_cash, cash_sales, cash_refunds,
          movements_net, expected_cash_computed
    FROM public.v_pos_cash_expected
   LIMIT 0;
END $$;

-- 7) RLS on pos_shifts: UPDATE policy must restrict to status='open'
--    (closed shifts are read-only to clients).
DO $$
DECLARE
  v_qual text;
BEGIN
  SELECT pg_get_expr(polqual, polrelid) INTO v_qual
    FROM pg_policy
   WHERE polrelid='public.pos_shifts'::regclass
     AND polcmd='w'
   LIMIT 1;
  IF v_qual IS NULL OR position('open' IN v_qual) = 0 THEN
    RAISE EXCEPTION 'pos_shifts UPDATE policy does not restrict to status=open: %', v_qual;
  END IF;
END $$;

-- 8) process_pos_void rejects voids when the original shift is closed.
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname='process_pos_void';
  IF v_src NOT LIKE '%shift_not_open%' THEN
    RAISE EXCEPTION 'process_pos_void missing same-shift window guard';
  END IF;
END $$;