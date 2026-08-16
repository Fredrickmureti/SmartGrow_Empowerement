-- =====================================================================
-- POS Wave · Phase 4a — revoke EXECUTE from PUBLIC/anon on POS routines
-- =====================================================================
-- Every POS routine is SECURITY DEFINER (RLS-bypassing). None of them has
-- an unauthenticated caller: the mobile scanner pairing page (/scan/:token)
-- is an auth-only route, and the till itself is always signed in.
DO $$
DECLARE
  r record;
  v_count integer := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (
        p.proname LIKE 'pos\_%'
        OR p.proname LIKE '\_pos\_%'
        OR p.proname LIKE 'tg\_pos\_%'
        OR p.proname IN (
          'process_pos_transaction',
          'finalize_table_order',
          'get_next_pos_transaction_number',
          'get_next_draft_transaction_number',
          'attach_c2b_to_pos_transaction',
          'archive_old_pos_transactions',
          'cleanup_pos_transaction_idempotency',
          'cascade_branch_from_pos_transaction',
          'increment_pos_counter',
          'stamp_pos_transaction_branch_from_register',
          'get_available_pos_stock_for_register_batch'
        )
      )
      AND EXISTS (
        SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
        WHERE a.privilege_type = 'EXECUTE'
          AND a.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname = 'anon'))
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Phase 4a: locked down % POS routine(s)', v_count;
END $$;

-- Post-condition: nothing in POS scope remains anon/PUBLIC executable.
DO $$
DECLARE v_leak text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ')
    INTO v_leak
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND (p.proname LIKE 'pos\_%' OR p.proname LIKE '\_pos\_%'
         OR p.proname IN ('process_pos_transaction','finalize_table_order'))
    AND EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE a.privilege_type = 'EXECUTE'
        AND a.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname = 'anon'))
    );
  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 4a incomplete — still anon/PUBLIC executable: %', v_leak;
  END IF;
END $$;

-- =====================================================================
-- POS Wave · Phase 4b — collapse the commit idempotency RACE
-- =====================================================================
-- `process_pos_transaction` pre-checks the idempotency cache, but two
-- concurrent submissions of the same key both pass the check and the loser
-- hits `pos_transactions_idempotency_key_uidx` with a 23505 raised to the
-- cashier — for a sale that DID commit. That is precisely the "unknown
-- state" this wave forbids. We wrap the body in a subtransaction and turn
-- the unique violation into the authoritative replay envelope.
--
-- Implemented as surgery on the LIVE definition (guarded) so the ~20k-char
-- body stays single-sourced and no behaviour is re-typed.
DO $$
DECLARE
  v_src text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'process_pos_transaction';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'Phase 4b: process_pos_transaction not found';
  END IF;

  IF position('unique_violation' in v_src) > 0 THEN
    RAISE NOTICE 'Phase 4b: handler already present, skipping';
    RETURN;
  END IF;

  -- Open a subtransaction immediately after the body BEGIN.
  v_new := regexp_replace(v_src, E'\nBEGIN\n', E'\nBEGIN\n BEGIN\n');
  IF v_new = v_src THEN
    RAISE EXCEPTION 'Phase 4b: body BEGIN marker not found — aborting surgery';
  END IF;

  -- Close it with the replay-recovery handler.
  v_src := v_new;
  v_new := regexp_replace(
    v_src,
    E'END;\\s*\\$function\\$\\s*$',
    E'EXCEPTION WHEN unique_violation THEN\n'
    || E'    IF p_idempotency_key IS NULL THEN RAISE; END IF;\n'
    || E'    SELECT response INTO v_cached_response\n'
    || E'      FROM public.pos_transaction_idempotency\n'
    || E'     WHERE idempotency_key = p_idempotency_key LIMIT 1;\n'
    || E'    IF v_cached_response IS NOT NULL THEN\n'
    || E'      RETURN jsonb_set(v_cached_response, ''{idempotent_replay}'', ''true''::jsonb, true);\n'
    || E'    END IF;\n'
    || E'    SELECT id, transaction_number, branch_id, business_id, total INTO v_existing\n'
    || E'      FROM public.pos_transactions\n'
    || E'     WHERE organization_id = p_organization_id\n'
    || E'       AND business_id = p_business_id\n'
    || E'       AND register_id = p_register_id\n'
    || E'       AND idempotency_key = p_idempotency_key LIMIT 1;\n'
    || E'    IF v_existing.id IS NOT NULL THEN\n'
    || E'      RETURN jsonb_build_object(\n'
    || E'        ''success'', true, ''idempotent_replay'', true,\n'
    || E'        ''transaction_id'', v_existing.id,\n'
    || E'        ''transaction_number'', v_existing.transaction_number,\n'
    || E'        ''change'', 0,\n'
    || E'        ''branch_id'', v_existing.branch_id,\n'
    || E'        ''business_id'', v_existing.business_id);\n'
    || E'    END IF;\n'
    || E'    RAISE;\n'
    || E'  END;\n'
    || E'END;\n$function$\n'
  );
  IF v_new = v_src THEN
    RAISE EXCEPTION 'Phase 4b: function tail marker not found — aborting surgery';
  END IF;

  EXECUTE v_new;
END $$;

-- Re-assert the lockdown after the CREATE OR REPLACE above (which resets ACLs).
REVOKE ALL ON FUNCTION public.process_pos_transaction(uuid, uuid, uuid, uuid, jsonb, jsonb, numeric, numeric, numeric, numeric, text, uuid, text, text, text, uuid, uuid, uuid, numeric, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_pos_transaction(uuid, uuid, uuid, uuid, jsonb, jsonb, numeric, numeric, numeric, numeric, text, uuid, text, text, text, uuid, uuid, uuid, numeric, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.process_pos_transaction(uuid, uuid, uuid, uuid, jsonb, jsonb, numeric, numeric, numeric, numeric, text, uuid, text, text, text, uuid, uuid, uuid, numeric, uuid, text) TO authenticated, service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='process_pos_transaction'
      AND pg_get_functiondef(p.oid) ILIKE '%unique_violation%'
      AND pg_get_functiondef(p.oid) ILIKE '%pos_resolve_line%'
      AND pg_get_functiondef(p.oid) ILIKE '%assert_pos_caller_branch_access%'
  ) THEN
    RAISE EXCEPTION 'Phase 4b post-condition failed: handler or Phase-4 pricing args lost';
  END IF;
END $$;