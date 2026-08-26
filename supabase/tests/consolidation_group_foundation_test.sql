-- Consolidation — group and ownership foundation (Brick 1).
--
-- WHAT THIS PROVES
-- A consolidation group is accounting-significant configuration: it decides
-- which legal entities are reported together, at what ownership, under which
-- method, and in which reporting currency. The only acceptable enforcement
-- story is one the database owns:
--
--   * scope coherence — group, member company and declared parent must all
--     belong to the same organization;
--   * the presentation currency must be an ENABLED OPERATING currency of the
--     parent company, not merely a code in the world catalogue;
--   * ownership structure must be acyclic, and `full` consolidation requires a
--     controlling interest (>= 50%);
--   * a declared parent must itself be in the group for the same period;
--   * membership periods for one company in one group may never overlap;
--   * a membership row's identity (company, group) is immutable;
--   * every change is recorded in an append-only change log;
--   * `close_consolidation_member` ends a membership with a date instead of
--     erasing it, and a later membership is then allowed;
--   * cross-tenant reads are refused by RLS, and the owner is NOT over-blocked.
--
-- SAFETY
-- The behavioural block seeds its own organizations and rolls back: the closing
-- `RAISE EXCEPTION 'rollback: ...'` aborts the transaction, so no fixture row
-- survives the run.

-- ---------------------------------------------------------------------------
-- 1) Contract: the tables exist, carry RLS with policies, and expose no anon
--    privilege. The change log is append-only for end users.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_t text; v_rel regclass;
BEGIN
  FOREACH v_t IN ARRAY ARRAY[
    'consolidation_groups', 'consolidation_group_members', 'consolidation_group_change_log'
  ] LOOP
    v_rel := ('public.' || v_t)::regclass;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel) THEN
      RAISE EXCEPTION 'public.% does not have row level security enabled', v_t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = v_t) THEN
      RAISE EXCEPTION 'public.% has no RLS policies', v_t;
    END IF;
    IF has_table_privilege('anon', v_rel, 'SELECT')
       OR has_table_privilege('anon', v_rel, 'INSERT')
       OR has_table_privilege('anon', v_rel, 'UPDATE')
       OR has_table_privilege('anon', v_rel, 'DELETE') THEN
      RAISE EXCEPTION 'anon holds a privilege on public.%', v_t;
    END IF;
  END LOOP;

  -- The audit trail is written by triggers only.
  IF has_table_privilege('authenticated', 'public.consolidation_group_change_log', 'INSERT')
     OR has_table_privilege('authenticated', 'public.consolidation_group_change_log', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.consolidation_group_change_log', 'DELETE') THEN
    RAISE EXCEPTION 'consolidation_group_change_log is writable by signed-in users';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Contract: the premature FX placeholder is gone (it returns with the
--    translation engine that gives it meaning, not before).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'consolidation_exchange_rates'
  ) THEN
    RAISE EXCEPTION 'consolidation_exchange_rates exists with no consumer';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typname = 'consolidation_rate_type'
  ) THEN
    RAISE EXCEPTION 'consolidation_rate_type exists with no consumer';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3) Contract: the close-out seam exists and is not anonymously callable.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'close_consolidation_member'
  ) THEN
    RAISE EXCEPTION 'close_consolidation_member is missing';
  END IF;
  IF has_function_privilege('anon', 'public.close_consolidation_member(uuid, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'close_consolidation_member is callable without signing in';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4) Behavioural: every guard refuses, the audit trail records, RLS isolates.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_org_a  uuid := gen_random_uuid();
  v_org_b  uuid := gen_random_uuid();
  v_biz_p  uuid := gen_random_uuid();   -- org A parent
  v_biz_s  uuid := gen_random_uuid();   -- org A subsidiary
  v_biz_t  uuid := gen_random_uuid();   -- org A second subsidiary
  v_biz_x  uuid := gen_random_uuid();   -- org B company
  v_user_a uuid := gen_random_uuid();
  v_user_b uuid := gen_random_uuid();
  v_group  uuid := gen_random_uuid();
  v_member uuid;
  v_rows   int;
  v_blocked boolean;
BEGIN
  -- ===== Seed (fixture owner, RLS bypassed) ================================
  INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  VALUES (v_user_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'consol-a-' || replace(v_user_a::text, '-', '') || '@example.test', now(), now()),
         (v_user_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'consol-b-' || replace(v_user_b::text, '-', '') || '@example.test', now(), now());

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org_a, 'Consol A', 'consol-a-' || replace(v_org_a::text, '-', '')),
         (v_org_b, 'Consol B', 'consol-b-' || replace(v_org_b::text, '-', ''));

  INSERT INTO public.user_roles (user_id, organization_id, role, is_active)
  VALUES (v_user_a, v_org_a, 'owner', true),
         (v_user_b, v_org_b, 'owner', true);

  INSERT INTO public.businesses (id, organization_id, name, country, base_currency, fiscal_year_start)
  VALUES (v_biz_p, v_org_a, 'Parent Ltd',     'KE', 'KES', 1),
         (v_biz_s, v_org_a, 'Sub One Ltd',    'KE', 'KES', 1),
         (v_biz_t, v_org_a, 'Sub Two Ltd',    'KE', 'KES', 1),
         (v_biz_x, v_org_b, 'Foreign Co Ltd', 'KE', 'KES', 1);

  -- ===== A: presentation currency must be an enabled operating currency ====
  v_blocked := false;
  BEGIN
    INSERT INTO public.consolidation_groups
      (organization_id, name, parent_business_id, presentation_currency)
    VALUES (v_org_a, 'Bad currency', v_biz_p, 'JPY');
  EXCEPTION WHEN check_violation THEN
    v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'a currency the parent does not operate in was accepted as presentation currency';
  END IF;

  -- ===== B: cross-organization parent refused ==============================
  v_blocked := false;
  BEGIN
    INSERT INTO public.consolidation_groups
      (organization_id, name, parent_business_id, presentation_currency)
    VALUES (v_org_a, 'Cross-org', v_biz_x, 'KES');
  EXCEPTION WHEN check_violation THEN
    v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'a group was created over a company of another organization';
  END IF;

  -- ===== The valid group (base currency is always an enabled currency) =====
  INSERT INTO public.consolidation_groups
    (id, organization_id, name, parent_business_id, presentation_currency)
  VALUES (v_group, v_org_a, 'A Group', v_biz_p, 'KES');

  INSERT INTO public.consolidation_group_members
    (organization_id, group_id, business_id, ownership_percent, method, effective_from)
  VALUES (v_org_a, v_group, v_biz_p, 100, 'full', DATE '2026-01-01');

  -- ===== C: cross-organization member refused ==============================
  v_blocked := false;
  BEGIN
    INSERT INTO public.consolidation_group_members
      (organization_id, group_id, business_id, ownership_percent, method, effective_from)
    VALUES (v_org_a, v_group, v_biz_x, 100, 'full', DATE '2026-01-01');
  EXCEPTION WHEN check_violation THEN
    v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'a company of another organization joined the group';
  END IF;

  -- ===== D: full consolidation below control refused =======================
  v_blocked := false;
  BEGIN
    INSERT INTO public.consolidation_group_members
      (organization_id, group_id, business_id, parent_business_id,
       ownership_percent, method, effective_from)
    VALUES (v_org_a, v_group, v_biz_s, v_biz_p, 30, 'full', DATE '2026-01-01');
  EXCEPTION WHEN check_violation THEN
    v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'full consolidation was accepted below a controlling interest';
  END IF;

  -- ===== E: a parent outside the group refused =============================
  v_blocked := false;
  BEGIN
    INSERT INTO public.consolidation_group_members
      (organization_id, group_id, business_id, parent_business_id,
       ownership_percent, method, effective_from)
    VALUES (v_org_a, v_group, v_biz_s, v_biz_t, 80, 'full', DATE '2026-01-01');
  EXCEPTION WHEN check_violation THEN
    v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'a parent that is not a member of the group was accepted';
  END IF;

  -- ===== The valid subsidiary ==============================================
  INSERT INTO public.consolidation_group_members
    (organization_id, group_id, business_id, parent_business_id,
     ownership_percent, method, effective_from)
  VALUES (v_org_a, v_group, v_biz_s, v_biz_p, 80, 'full', DATE '2026-01-01')
  RETURNING id INTO v_member;

  IF (SELECT created_by FROM public.consolidation_group_members WHERE id = v_member)
     IS DISTINCT FROM auth.uid() THEN
    -- auth.uid() is NULL for the fixture owner; the assertion is that the guard
    -- stamps the caller rather than whatever the client sent.
    RAISE EXCEPTION 'created_by is not stamped from the calling session';
  END IF;

  -- ===== F: overlapping membership periods refused =========================
  v_blocked := false;
  BEGIN
    INSERT INTO public.consolidation_group_members
      (organization_id, group_id, business_id, parent_business_id,
       ownership_percent, method, effective_from)
    VALUES (v_org_a, v_group, v_biz_s, v_biz_p, 60, 'full', DATE '2026-06-01');
  EXCEPTION WHEN check_violation OR unique_violation THEN
    v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'two overlapping membership periods were accepted for one company';
  END IF;

  -- ===== G: ownership cycle refused ========================================
  v_blocked := false;
  BEGIN
    UPDATE public.consolidation_group_members
       SET parent_business_id = v_biz_s
     WHERE group_id = v_group AND business_id = v_biz_p;
  EXCEPTION WHEN check_violation THEN
    v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'an ownership cycle was accepted';
  END IF;

  -- ===== H: membership identity is immutable ==============================
  v_blocked := false;
  BEGIN
    UPDATE public.consolidation_group_members SET business_id = v_biz_t WHERE id = v_member;
  EXCEPTION WHEN check_violation THEN
    v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'a membership row was repointed at another company';
  END IF;

  -- ===== I: the change log recorded the configuration so far ==============
  SELECT count(*) INTO v_rows
    FROM public.consolidation_group_change_log
   WHERE group_id = v_group AND entity = 'group' AND action = 'insert';
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'group creation was not recorded in the change log (% rows)', v_rows;
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.consolidation_group_change_log
   WHERE group_id = v_group AND entity = 'member' AND action = 'insert';
  IF v_rows < 2 THEN
    RAISE EXCEPTION 'membership creation was not recorded in the change log (% rows)', v_rows;
  END IF;

  -- ===== J: close-out sets an end date and permits a later membership =====
  PERFORM public.close_consolidation_member(v_member, DATE '2026-06-30');

  IF (SELECT effective_to FROM public.consolidation_group_members WHERE id = v_member)
     <> DATE '2026-06-30' THEN
    RAISE EXCEPTION 'close_consolidation_member did not stamp the end date';
  END IF;

  v_blocked := false;
  BEGIN
    PERFORM public.close_consolidation_member(v_member, DATE '2026-09-30');
  EXCEPTION WHEN check_violation THEN
    v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'an already closed membership was closed again';
  END IF;

  v_blocked := false;
  BEGIN
    PERFORM public.close_consolidation_member(v_member, DATE '2025-01-01');
  EXCEPTION WHEN check_violation THEN
    v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'a membership was closed before it started';
  END IF;

  -- The company may re-enter the group for a later, non-overlapping period.
  INSERT INTO public.consolidation_group_members
    (organization_id, group_id, business_id, parent_business_id,
     ownership_percent, method, effective_from)
  VALUES (v_org_a, v_group, v_biz_s, v_biz_p, 55, 'full', DATE '2026-07-01');

  SELECT count(*) INTO v_rows
    FROM public.consolidation_group_members
   WHERE group_id = v_group AND business_id = v_biz_s;
  IF v_rows <> 2 THEN
    RAISE EXCEPTION 'ownership history was not preserved (% rows)', v_rows;
  END IF;

  -- ===== K: RLS — the foreign organization sees nothing ====================
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user_b::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT count(*) INTO v_rows FROM public.consolidation_groups WHERE id = v_group;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'LEAK: a foreign organization can read the group';
  END IF;
  SELECT count(*) INTO v_rows FROM public.consolidation_group_members WHERE group_id = v_group;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'LEAK: a foreign organization can read group membership';
  END IF;
  SELECT count(*) INTO v_rows FROM public.consolidation_group_change_log WHERE group_id = v_group;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'LEAK: a foreign organization can read the configuration history';
  END IF;

  -- ===== L: the owner is not over-blocked =================================
  RESET ROLE;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user_a::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT count(*) INTO v_rows FROM public.consolidation_groups WHERE id = v_group;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'OVER-BLOCK: the owning user cannot read their own group';
  END IF;
  SELECT count(*) INTO v_rows FROM public.consolidation_group_change_log WHERE group_id = v_group;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'OVER-BLOCK: the owning user cannot read their own configuration history';
  END IF;

  RESET ROLE;
  RAISE EXCEPTION 'rollback: consolidation group foundation fixture passed';
END $$;
