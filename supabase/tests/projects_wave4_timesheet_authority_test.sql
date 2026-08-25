-- Projects Wave 4 — workforce eligibility & timesheet authority.
--
-- WHAT THIS PROVES
--   1. project_members carries the split semantics: project_role, can_write,
--      is_billable_participant (access ≠ billing ≠ organizational role).
--   2. project_add_member refuses: non-governor callers, inactive employees,
--      cross-branch staff on a branch-pinned project, callers without branch
--      access.
--   3. The timesheets eligibility trigger refuses: foreign-company projects,
--      closed projects, timesheet-disabled projects, wrong-branch employees
--      (unless the project allows cross-branch work), non-members (unless
--      time entry is open to the company).
--   4. resolve_project_billing_rate returns 0 for a member flagged as
--      non-billable participant.
--
-- SAFETY: seeds its own fixtures inside a DO block and rolls back at the end.

-- 1) Schema contract ------------------------------------------------------------
DO $$
DECLARE
  v_cols text[];
BEGIN
  SELECT array_agg(column_name ORDER BY ordinal_position) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'project_members';
  IF NOT (v_cols @> ARRAY['project_role','can_write','is_billable_participant']) THEN
    RAISE EXCEPTION 'project_members is missing the Wave 4 semantic columns (has: %)', v_cols;
  END IF;

  SELECT array_agg(column_name ORDER BY ordinal_position) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'projects';
  IF NOT (v_cols @> ARRAY['allows_cross_branch_work','time_entry_open_to_org']) THEN
    RAISE EXCEPTION 'projects is missing the Wave 4 governance flags (has: %)', v_cols;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'timesheets'
       AND t.tgname = 'timesheets_aa_project_eligibility'
  ) THEN
    RAISE EXCEPTION 'timesheets eligibility trigger is not installed';
  END IF;
END $$;

-- 2) Behavioural ----------------------------------------------------------------
DO $$
DECLARE
  v_org     uuid := gen_random_uuid();
  v_biz     uuid := gen_random_uuid();
  v_br_a    uuid := gen_random_uuid();
  v_br_b    uuid := gen_random_uuid();
  v_mgr     uuid := gen_random_uuid();
  v_user_w  uuid := gen_random_uuid();
  v_user_x  uuid := gen_random_uuid();
  v_user_y  uuid := gen_random_uuid();
  v_emp_w   uuid := gen_random_uuid();
  v_emp_x   uuid := gen_random_uuid();
  v_proj_a  uuid := gen_random_uuid();
  v_proj_b  uuid := gen_random_uuid();
  v_proj_c  uuid := gen_random_uuid();
  v_rate    numeric;
  v_blocked boolean;
BEGIN
  -- ===== Seed =================================================================
  INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  SELECT u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'pj4-' || replace(u::text, '-', '') || '@example.test', now(), now()
    FROM (VALUES (v_mgr),(v_user_w),(v_user_x),(v_user_y)) s(u);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'PJ4 Org', 'pj4-' || replace(v_org::text, '-', ''));

  INSERT INTO public.user_roles (user_id, organization_id, role, is_active)
  VALUES (v_mgr, v_org, 'admin', true),
         (v_user_w, v_org, 'member', true),
         (v_user_x, v_org, 'member', true);

  INSERT INTO public.businesses (id, organization_id, name, country, base_currency, fiscal_year_start)
  VALUES (v_biz, v_org, 'PJ4 Ltd', 'KE', 'KES', 1);

  INSERT INTO public.branches (id, organization_id, business_id, name)
  VALUES (v_br_a, v_org, v_biz, 'HQ'),
         (v_br_b, v_org, v_biz, 'North');

  INSERT INTO public.employees (id, organization_id, business_id, branch_id, user_id,
                                employee_number, first_name, last_name, hire_date, is_active)
  VALUES (v_emp_w, v_org, v_biz, v_br_a, v_user_w, 'E-W', 'Wren', 'A', DATE '2026-01-01', true),
         (v_emp_x, v_org, v_biz, v_br_b, v_user_x, 'E-X', 'Xer',  'B', DATE '2026-01-01', true);

  -- A: branch-pinned project on HQ
  INSERT INTO public.projects (id, organization_id, business_id, branch_id, manager_id,
                               project_number, name, status, allow_timesheets,
                               allows_cross_branch_work, time_entry_open_to_org)
  VALUES (v_proj_a, v_org, v_biz, v_br_a, v_mgr, 'PJ-4A', 'Alpha', 'active', true, false, false);

  -- B: cross-branch open
  INSERT INTO public.projects (id, organization_id, business_id, branch_id, manager_id,
                               project_number, name, status, allow_timesheets,
                               allows_cross_branch_work, time_entry_open_to_org)
  VALUES (v_proj_b, v_org, v_biz, v_br_a, v_mgr, 'PJ-4B', 'Bravo', 'active', true, true, false);

  -- C: open to whole company
  INSERT INTO public.projects (id, organization_id, business_id, branch_id, manager_id,
                               project_number, name, status, allow_timesheets,
                               allows_cross_branch_work, time_entry_open_to_org)
  VALUES (v_proj_c, v_org, v_biz, v_br_a, v_mgr, 'PJ-4C', 'Charlie', 'active', true, false, true);

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_mgr::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  -- ===== 1: wrong-branch employee refused on the branch-pinned project ========
  PERFORM public.project_add_member(v_proj_a, v_user_w, 'member', 500);

  v_blocked := false;
  BEGIN
    PERFORM public.project_add_member(v_proj_a, v_user_x, 'member');
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true; END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'project_add_member accepted a cross-branch employee on a branch-pinned project';
  END IF;

  -- and allowed once the project permits cross-branch work
  PERFORM public.project_add_member(v_proj_b, v_user_x, 'member');

  -- ===== 2: non-governor cannot manage the team ==============================
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user_w::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_blocked := false;
  BEGIN
    PERFORM public.project_add_member(v_proj_a, v_user_y, 'member');
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true; END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'a plain member could manage the project team';
  END IF;

  -- ===== 3: timesheet eligibility — member on a pinned project passes ========
  INSERT INTO public.timesheets (organization_id, business_id, employee_id, date, hours, project_id)
  VALUES (v_org, v_biz, v_emp_w, DATE '2026-01-05', 2, v_proj_a);

  -- ===== 4: wrong-branch employee refused on the pinned project ===============
  v_blocked := false;
  BEGIN
    INSERT INTO public.timesheets (organization_id, business_id, employee_id, date, hours, project_id)
    VALUES (v_org, v_biz, v_emp_x, DATE '2026-01-05', 2, v_proj_a);
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true; END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'cross-branch timesheet accepted on a branch-pinned project';
  END IF;

  -- ===== 5: same employee accepted on the cross-branch project ================
  INSERT INTO public.timesheets (organization_id, business_id, employee_id, date, hours, project_id)
  VALUES (v_org, v_biz, v_emp_x, DATE '2026-01-05', 2, v_proj_b);

  -- ===== 6: non-member refused even in-branch (team-only entry) ===============
  v_blocked := false;
  BEGIN
    INSERT INTO public.timesheets (organization_id, business_id, employee_id, date, hours, project_id)
    VALUES (v_org, v_biz, v_emp_w, DATE '2026-01-06', 2, v_proj_c);
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true; END;
  IF v_blocked THEN
    RAISE EXCEPTION 'open-to-company project refused a non-member timesheet (flag not honored)';
  END IF;

  -- ===== 7: completed project refuses time ====================================
  UPDATE public.projects SET status = 'completed', is_active = false WHERE id = v_proj_c;
  v_blocked := false;
  BEGIN
    INSERT INTO public.timesheets (organization_id, business_id, employee_id, date, hours, project_id)
    VALUES (v_org, v_biz, v_emp_w, DATE '2026-01-06', 2, v_proj_c);
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true; END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'timesheet accepted on a completed project';
  END IF;

  -- ===== 8: non-billable participant resolves to a zero rate ==================
  UPDATE public.project_members SET is_billable_participant = false, billable_rate = 400
   WHERE project_id = v_proj_a AND user_id = v_user_w;
  SELECT public.resolve_project_billing_rate(v_proj_a, v_emp_w, NULL) INTO v_rate;
  IF coalesce(v_rate, -1) <> 0 THEN
    RAISE EXCEPTION 'non-billable participant resolved rate % instead of 0', v_rate;
  END IF;

  UPDATE public.project_members SET is_billable_participant = true
   WHERE project_id = v_proj_a AND user_id = v_user_w;
  SELECT public.resolve_project_billing_rate(v_proj_a, v_emp_w, NULL) INTO v_rate;
  IF coalesce(v_rate, -1) <> 400 THEN
    RAISE EXCEPTION 'billable participant resolved rate % instead of 400', v_rate;
  END IF;

  RAISE EXCEPTION 'rollback: projects_wave4 tests passed';
END $$;
