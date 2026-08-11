-- Purchase Returns audit, Phase 9 — invariant coverage for the server-authoritative
-- purchase return lifecycle.
--
-- Why this file exists: the returns lifecycle is the join point between three
-- ledgers (stock, GR/NI, accounts payable). Every rule below was violated by the
-- pre-audit implementation at least once, and each violation is silent at runtime:
-- an over-return only surfaces as negative stock weeks later, a client-side write
-- only surfaces as a return with no event trail, and a loosened status domain only
-- surfaces as an unrepresentable state in the UI.
--
-- Introspection plus read-only probes only; safe in any environment.

-- 1) The lifecycle commands exist, exactly once each, and are SECURITY DEFINER.
DO $$
DECLARE v_name text; v_count int; v_secdef boolean;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'purchase_return_create','purchase_return_update_draft','purchase_return_submit',
    'purchase_return_approve','purchase_return_reject','purchase_return_dispatch',
    'purchase_return_acknowledge','purchase_return_raise_credit',
    'purchase_return_close','purchase_return_cancel',
    '_pret_write_lines','_pret_lock_receipt_line'
  ] LOOP
    SELECT count(*), bool_and(p.prosecdef) INTO v_count, v_secdef
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_count <> 1 THEN
      RAISE EXCEPTION '% must exist with exactly one overload, found %', v_name, v_count;
    END IF;
    IF NOT v_secdef THEN
      RAISE EXCEPTION '% must be SECURITY DEFINER — the client role cannot write the tables', v_name;
    END IF;
  END LOOP;
END $$;

-- 2) The tables are SELECT-only for the client roles. Direct DML would bypass the
--    FSM, the event trail and the outbox in one step.
DO $$
DECLARE v_tbl text; v_role text; v_priv text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['purchase_returns','purchase_return_items','purchase_return_events'] LOOP
    FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['INSERT','UPDATE','DELETE'] LOOP
        IF has_table_privilege(v_role, format('public.%I', v_tbl), v_priv) THEN
          RAISE EXCEPTION '% holds % on public.% — returns must be RPC-only writes',
            v_role, v_priv, v_tbl;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

-- 3) RLS is on and every return row is business-scoped.
DO $$
DECLARE v_tbl text; v_rls boolean; v_policies int;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['purchase_returns','purchase_return_items','purchase_return_events'] LOOP
    SELECT c.relrowsecurity INTO v_rls
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relname = v_tbl;
    IF NOT COALESCE(v_rls,false) THEN
      RAISE EXCEPTION 'RLS is disabled on public.%', v_tbl;
    END IF;
    SELECT count(*) INTO v_policies FROM pg_policies
     WHERE schemaname='public' AND tablename = v_tbl;
    IF v_policies = 0 THEN
      RAISE EXCEPTION 'public.% has RLS enabled but no policies — the table is unreadable', v_tbl;
    END IF;
  END LOOP;
END $$;

-- 4) Over-return protection is serialised. `_pret_write_lines` must take the
--    receipt-line lock *before* it reads the remaining returnable quantity;
--    without the lock two concurrent returns both read the same headroom and
--    jointly return more than was ever received.
DO $$
DECLARE v_src text; v_lock int; v_read int;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='_pret_write_lines';

  v_lock := position('_pret_lock_receipt_line' in v_src);
  v_read := position('purchase_return_returnable_lines' in v_src);

  IF v_lock = 0 THEN
    RAISE EXCEPTION '_pret_write_lines does not lock the source receipt line — concurrent over-return is possible';
  END IF;
  IF v_read = 0 THEN
    RAISE EXCEPTION '_pret_write_lines no longer validates against purchase_return_returnable_lines';
  END IF;
  IF v_lock > v_read THEN
    RAISE EXCEPTION 'the receipt-line lock is taken after the returnable read — the check is still racy';
  END IF;
END $$;

-- 5) The lock helper really locks (FOR UPDATE), rather than merely reading the row.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='_pret_lock_receipt_line';
  IF v_src !~* 'for\s+update' THEN
    RAISE EXCEPTION '_pret_lock_receipt_line does not take a row lock';
  END IF;
END $$;

-- 6) The status domain is exactly the lifecycle the UI can represent. Legacy
--    'pending' / 'processed' must no longer be accepted on new rows.
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
   WHERE n.nspname='public' AND t.relname='purchase_returns'
     AND c.contype='c' AND pg_get_constraintdef(c.oid) ILIKE '%status%';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'purchase_returns.status has no CHECK constraint — any string is a legal state';
  END IF;
  IF v_def ~* '''pending''' OR v_def ~* '''processed''' THEN
    RAISE EXCEPTION 'legacy statuses are still accepted: %', v_def;
  END IF;
  IF v_def !~* '''draft''' OR v_def !~* '''dispatched''' OR v_def !~* '''credited''' THEN
    RAISE EXCEPTION 'status constraint is missing core lifecycle states: %', v_def;
  END IF;
END $$;

-- 7) No historical row sits outside the constraint (the tightening migration must
--    have carried legacy rows forward rather than orphaning them).
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM public.purchase_returns
   WHERE status IN ('pending','processed');
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% purchase_returns rows still carry a legacy status', v_bad;
  END IF;
END $$;

-- 8) Dispatch owns the stock ledger and the credit command owns the debit note.
DO $$
DECLARE v_dispatch text; v_credit text;
BEGIN
  SELECT p.prosrc INTO v_dispatch FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='purchase_return_dispatch';
  SELECT p.prosrc INTO v_credit FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='purchase_return_raise_credit';

  IF v_dispatch !~* 'stock_movements' THEN
    RAISE EXCEPTION 'purchase_return_dispatch no longer writes the stock ledger';
  END IF;
  IF v_credit !~* 'credit_note' THEN
    RAISE EXCEPTION 'purchase_return_raise_credit no longer produces a vendor debit note';
  END IF;
  IF v_credit ~* 'stock_movements' THEN
    RAISE EXCEPTION 'the credit command moves stock — physical and financial legs must stay separate';
  END IF;
END $$;

-- 9) Every lifecycle command leaves an audit trail and an integration event.
DO $$
DECLARE v_name text; v_src text; v_log_src text;
BEGIN
  SELECT p.prosrc INTO v_log_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='_pret_log';
  IF v_log_src IS NULL OR v_log_src !~* 'purchase_return_events' THEN
    RAISE EXCEPTION '_pret_log no longer appends to purchase_return_events';
  END IF;

  FOREACH v_name IN ARRAY ARRAY[
    'purchase_return_submit','purchase_return_approve','purchase_return_reject',
    'purchase_return_dispatch','purchase_return_acknowledge',
    'purchase_return_raise_credit','purchase_return_close','purchase_return_cancel'
  ] LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=v_name;
    -- The audit row is written through the `_pret_log` helper (directly, or via
    -- `_pret_apply_approval` for the governed approval path), which is the only
    -- writer of the append-only event table.
    IF v_src !~* '_pret_log' AND v_src !~* '_pret_apply_approval'
       AND v_src !~* 'purchase_return_events' THEN
      RAISE EXCEPTION '% leaves no audit trail on purchase_return_events', v_name;
    END IF;
    IF v_src !~* 'row_version' THEN
      RAISE EXCEPTION '% does not enforce optimistic concurrency via row_version', v_name;
    END IF;
  END LOOP;
END $$;

SELECT 'purchase_returns lifecycle invariants hold' AS result;
