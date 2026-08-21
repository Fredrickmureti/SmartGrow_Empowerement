-- =====================================================================
-- Reconciliation wave · Phase 5 — history explains, and stays in scope.
--
-- WHAT THIS PROVES
-- 1. `bank_reconciliation_matches` is NOT readable org-wide. The old
--    policy `user_belongs_to_org(organization_id)` exposed one business's
--    (and one branch's) reconciliation decisions to every other business
--    in the organisation. Reads must be business- and branch-scoped.
-- 2. The two history readers exist, are hardened (SECURITY DEFINER,
--    pinned search_path, no anon/PUBLIC execute) and single-overload.
-- 3. They are read-only: no INSERT/UPDATE/DELETE, and they never call the
--    matching or posting seams. Explaining is not deciding.
-- 4. They assert scope internally rather than trusting the caller.
--
-- Run with: supabase test db --linked --file bank_match_history_read_seam_test.sql
-- =====================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- 1) No org-wide read on the match table.
-- ---------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.polname, pg_get_expr(p.polqual, p.polrelid) AS q
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relname = 'bank_reconciliation_matches'
       AND p.polcmd IN ('r','*')
  LOOP
    IF r.q IS NULL OR r.q NOT LIKE '%user_can_access_business%' THEN
      RAISE EXCEPTION 'read policy % on bank_reconciliation_matches is not business-scoped: %', r.polname, r.q;
    END IF;
    IF r.q NOT LIKE '%branch%' THEN
      RAISE EXCEPTION 'read policy % on bank_reconciliation_matches is not branch-scoped: %', r.polname, r.q;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relname = 'bank_reconciliation_matches'
       AND p.polcmd IN ('r','*')
       AND pg_get_expr(p.polqual, p.polrelid) = 'user_belongs_to_org(organization_id)'
  ) THEN
    RAISE EXCEPTION 'the org-wide read policy on bank_reconciliation_matches is back';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2) & 3) The history readers exist, are hardened, and are read-only.
-- ---------------------------------------------------------------------
DO $$
DECLARE fn text; r record; body text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['bank_match_history','bank_match_session_history'] LOOP
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname=fn) <> 1 THEN
      RAISE EXCEPTION 'history reader % must have exactly one overload', fn;
    END IF;

    SELECT p.prosecdef, p.proconfig, p.proacl, p.proowner, p.prosrc INTO r
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=fn;

    IF NOT r.prosecdef THEN
      RAISE EXCEPTION 'history reader % is not SECURITY DEFINER', fn;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(r.proconfig,'{}')) c WHERE c LIKE 'search\_path=%') THEN
      RAISE EXCEPTION 'history reader % has no pinned search_path', fn;
    END IF;
    IF EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(r.proacl, acldefault('f', r.proowner))) a
      WHERE a.privilege_type='EXECUTE'
        AND a.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname='anon'))
    ) THEN
      RAISE EXCEPTION 'history reader % is executable by anon/PUBLIC', fn;
    END IF;

    body := lower(r.prosrc);
    IF body ~ '(insert\s+into|update\s+public\.|delete\s+from)' THEN
      RAISE EXCEPTION 'history reader % writes data; it must be read-only', fn;
    END IF;
    IF body LIKE '%bank_match_propose%' OR body LIKE '%bank_match_confirm%'
       OR body LIKE '%bank_match_reject%' OR body LIKE '%bank_match_reverse%'
       OR body LIKE '%post_journal_entry_atomic%' THEN
      RAISE EXCEPTION 'history reader % calls a decision/posting seam', fn;
    END IF;

    -- 4) Scope is asserted inside the function, not assumed.
    IF body NOT LIKE '%_assert_can_read_bank_history%' THEN
      RAISE EXCEPTION 'history reader % does not assert business/branch scope', fn;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 5) The internal helpers are not part of the public API surface.
-- ---------------------------------------------------------------------
DO $$
DECLARE fn text; r record;
BEGIN
  FOREACH fn IN ARRAY ARRAY['_assert_can_read_bank_history','_bank_history_actor','_bank_match_history_row'] LOOP
    SELECT p.proacl, p.proowner INTO r
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=fn;
    IF r IS NULL THEN
      RAISE EXCEPTION 'history helper % is missing', fn;
    END IF;
    IF EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(r.proacl, acldefault('f', r.proowner))) a
      WHERE a.privilege_type='EXECUTE'
        AND a.grantee IN (
          0,
          (SELECT oid FROM pg_roles WHERE rolname='anon'),
          (SELECT oid FROM pg_roles WHERE rolname='authenticated')
        )
    ) THEN
      RAISE EXCEPTION 'history helper % is directly callable by clients', fn;
    END IF;
  END LOOP;
END $$;

SELECT 'bank_match_history_read_seam_test: OK' AS result;
