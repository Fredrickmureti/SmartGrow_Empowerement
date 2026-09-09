-- Branch Operational Day — structural invariants.
--
-- The operational day is a control, not a report. Everything that makes it a
-- control has to be in the database, because the client is not trusted:
--
--   1. One day row per branch per date, and at most ONE open day per branch,
--      enforced by unique indexes rather than by application code.
--   2. The day tables are readable through the Data API but never writable
--      from the client — state changes only happen through the RPCs.
--   3. Read access is gated by business membership (RLS + grants both).
--   4. The day history is append-only.
--   5. The ledger choke point (`journal_entries`) and the collection-round
--      table both carry a day guard trigger.
--   6. The RPCs are SECURITY DEFINER, closed to anon, open to signed-in users.
--   7. Authority comes from the existing permission framework: the day RPCs
--      call `mf_can_scoped`, and every operation they ask for is an operation
--      `user_has_module_permission` can actually answer. A capability the
--      resolver silently answers `false` for would lock everyone out.
--
-- Read-only: this test asserts structure and does not write any rows.

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_missing text;
  v_src text;
  v_op text;
BEGIN
  ---------------------------------------------------------------- 1. uniqueness
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'branch_operational_days'
       AND indexdef ILIKE 'CREATE UNIQUE INDEX%(branch_id, business_date)%'
  ) THEN
    RAISE EXCEPTION 'branch_operational_days must be UNIQUE on (branch_id, business_date)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'branch_operational_days'
       AND indexdef ILIKE 'CREATE UNIQUE INDEX%(branch_id)%'
       AND indexdef ILIKE '%status = ''open''%'
  ) THEN
    RAISE EXCEPTION 'A branch must be unable to hold two open days: partial UNIQUE index on (branch_id) WHERE status = ''open'' is missing';
  END IF;

  ------------------------------------------------------- 2. no client writes
  -- Read privileges straight from the catalog: information_schema views are
  -- filtered by the querying role and silently return nothing when the test
  -- runs as a role that neither granted nor holds the privilege.
  SELECT string_agg(c.relname || '/' || g.role || '/' || g.priv, ', ')
    INTO v_missing
    FROM pg_class c
    CROSS JOIN (VALUES ('anon'),('authenticated')) r(role)
    CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) p(priv)
    CROSS JOIN LATERAL (SELECT r.role AS role, p.priv AS priv) g
   WHERE c.relname IN ('branch_operational_days', 'branch_day_events')
     AND c.relnamespace = 'public'::regnamespace
     AND has_table_privilege(g.role, c.oid, g.priv);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Day state must only change through the RPCs, but direct write grants exist: %', v_missing;
  END IF;

  --------------------------------------------------------- 3. read is gated
  FOREACH v_op IN ARRAY ARRAY['branch_operational_days', 'branch_day_events'] LOOP
    IF NOT has_table_privilege('authenticated', ('public.' || v_op)::regclass, 'SELECT') THEN
      RAISE EXCEPTION '% is unreadable through the Data API — GRANT SELECT TO authenticated is missing', v_op;
    END IF;

    IF has_table_privilege('anon', ('public.' || v_op)::regclass, 'SELECT') THEN
      RAISE EXCEPTION '% is readable by signed-out visitors', v_op;
    END IF;


    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_op)::regclass) THEN
      RAISE EXCEPTION 'RLS is not enabled on %', v_op;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = v_op
         AND cmd IN ('SELECT', 'ALL')
         AND (COALESCE(qual, '') || COALESCE(with_check, '')) ~
             '(user_has_business_access|mf_can|user_has_module_permission)'
    ) THEN
      RAISE EXCEPTION 'Read policy on % does not reference the authorization surface', v_op;
    END IF;
  END LOOP;

  ------------------------------------------------------- 4. append-only log
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'branch_day_events' AND NOT t.tgisinternal
       AND t.tgname = 'trg_branch_day_events_append_only'
  ) THEN
    RAISE EXCEPTION 'branch_day_events is not protected as append-only';
  END IF;

  ------------------------------------------------------- 5. guard triggers
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'journal_entries' AND t.tgname = 'trg_enforce_branch_day_lock'
  ) THEN
    RAISE EXCEPTION 'The ledger has no branch-day lock — money could post into a closed day';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'mf_repayment_batches' AND t.tgname = 'trg_enforce_batch_branch_day'
  ) THEN
    RAISE EXCEPTION 'Collection rounds are not validated against the branch day';
  END IF;

  ------------------------------------------------------------ 6. RPC posture
  FOREACH v_op IN ARRAY ARRAY['open_branch_day', 'close_branch_day', 'reopen_branch_day'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = v_op AND p.prosecdef
    ) THEN
      RAISE EXCEPTION '% must exist and be SECURITY DEFINER', v_op;
    END IF;

    SELECT p.prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_op;

    IF v_src NOT LIKE '%mf_can_scoped%' THEN
      RAISE EXCEPTION '% does not consult the existing permission framework', v_op;
    END IF;
    IF v_src NOT LIKE '%pg_advisory_xact_lock%' THEN
      RAISE EXCEPTION '% has no concurrency lock', v_op;
    END IF;
  END LOOP;

  ------------------------------------- 7. every capability asked for resolves
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'user_has_module_permission'
     AND pg_get_function_arguments(p.oid) LIKE '%text%text%';

  FOREACH v_op IN ARRAY ARRAY['write', 'close', 'admin_override'] LOOP
    IF v_src NOT LIKE '%''' || v_op || '''%' THEN
      RAISE EXCEPTION 'The day engine asks for the % capability but user_has_module_permission cannot answer it — everyone would be locked out', v_op;
    END IF;
  END LOOP;

  RAISE NOTICE 'branch operational day invariants: OK';
END $$;
