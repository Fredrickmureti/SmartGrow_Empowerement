-- Wave B1.7 — pgTAP regression for public.print_policies_resolve(uuid, uuid, text, text).
--
-- Contract under test (see supabase/migrations/20260618000802_*.sql):
--   The resolver scans document_print_policies for the supplied
--   (business_id, document_type) and picks the MOST SPECIFIC match by
--   the following tier ladder, smaller number wins:
--     Tier 1 — row.branch_id = p_branch AND row.intent = p_intent
--     Tier 2 — row.branch_id = p_branch AND row.intent IS NULL
--     Tier 3 — row.branch_id IS NULL   AND row.intent = p_intent
--     Tier 4 — row.branch_id IS NULL   AND row.intent IS NULL
--   When no row matches, the resolver returns the system fallback row
--     (NULL printer, 'a4', 'pdf', 1 copy, auto_print=false, ask_user=true).
--
-- The current unique index on document_print_policies is
-- (business_id, COALESCE(branch_id, sentinel), document_type) and does NOT
-- include intent, so we vary `business_id` per tier to avoid index collisions
-- while still exercising the resolver's tier logic end-to-end. One scenario at
-- the bottom DOES insert two coexisting rows under a single business to verify
-- the ORDER BY specificity tie-breaker fires correctly.
--
-- Test isolation: everything runs inside a single transaction with
-- session_replication_role=replica so FK checks and audit triggers do not
-- require pre-existing businesses/branches/printer_profiles rows. The
-- transaction is rolled back at the end — no rows persist.

\set ON_ERROR_STOP on

BEGIN;

SET LOCAL session_replication_role = replica;

-- ---------------------------------------------------------------------------
-- (0) Signature sanity: the v2 resolver must exist with exactly 4 args.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'print_policies_resolve'
    AND pg_get_function_identity_arguments(p.oid) = 'p_business_id uuid, p_branch_id uuid, p_document_type text, p_intent text';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'print_policies_resolve: expected exactly one (uuid,uuid,text,text) overload, found %', v_count;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Tier 1 — branch + intent match returns the branch+intent row.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_biz     uuid := '00000000-0000-0000-0000-0000000b1001';
  v_branch  uuid := '00000000-0000-0000-0000-000000bb1001';
  v_printer uuid := '00000000-0000-0000-0000-0000000fa101';
  r record;
BEGIN
  INSERT INTO public.document_print_policies
    (business_id, branch_id, document_type, intent,
     printer_profile_id, paper_format, render_mode, copies, auto_print)
  VALUES
    (v_biz, v_branch, 'invoice', 'a4_document',
     v_printer, 'a4', 'pdf', 2, true);

  SELECT * INTO r
  FROM public.print_policies_resolve(v_biz, v_branch, 'invoice', 'a4_document');

  IF r.printer_profile_id IS DISTINCT FROM v_printer THEN
    RAISE EXCEPTION 'Tier 1: expected printer %, got %', v_printer, r.printer_profile_id;
  END IF;
  IF r.copies <> 2 OR r.auto_print IS NOT TRUE OR r.ask_user IS NOT FALSE THEN
    RAISE EXCEPTION 'Tier 1: copies/auto_print/ask_user mismatch — copies=%, auto_print=%, ask_user=%',
      r.copies, r.auto_print, r.ask_user;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Tier 2 — branch row with NULL intent matches an intent-bearing call.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_biz     uuid := '00000000-0000-0000-0000-0000000b1002';
  v_branch  uuid := '00000000-0000-0000-0000-000000bb1002';
  v_printer uuid := '00000000-0000-0000-0000-0000000fa102';
  r record;
BEGIN
  INSERT INTO public.document_print_policies
    (business_id, branch_id, document_type, intent,
     printer_profile_id, paper_format, render_mode, copies, auto_print)
  VALUES
    (v_biz, v_branch, 'invoice', NULL,
     v_printer, 'letter', 'pdf', 1, false);

  SELECT * INTO r
  FROM public.print_policies_resolve(v_biz, v_branch, 'invoice', 'a4_document');

  IF r.printer_profile_id IS DISTINCT FROM v_printer THEN
    RAISE EXCEPTION 'Tier 2: expected printer %, got %', v_printer, r.printer_profile_id;
  END IF;
  IF r.paper_format <> 'letter' OR r.ask_user IS NOT FALSE THEN
    RAISE EXCEPTION 'Tier 2: paper_format/ask_user mismatch — paper=%, ask_user=%',
      r.paper_format, r.ask_user;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Tier 3 — org-wide row (branch IS NULL) carrying an intent matches.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_biz     uuid := '00000000-0000-0000-0000-0000000b1003';
  v_branch  uuid := '00000000-0000-0000-0000-000000bb1003';
  v_printer uuid := '00000000-0000-0000-0000-0000000fa103';
  r record;
BEGIN
  INSERT INTO public.document_print_policies
    (business_id, branch_id, document_type, intent,
     printer_profile_id, paper_format, render_mode, copies, auto_print)
  VALUES
    (v_biz, NULL, 'invoice', 'a4_document',
     v_printer, 'a4', 'pdf', 3, false);

  SELECT * INTO r
  FROM public.print_policies_resolve(v_biz, v_branch, 'invoice', 'a4_document');

  IF r.printer_profile_id IS DISTINCT FROM v_printer THEN
    RAISE EXCEPTION 'Tier 3: expected printer %, got %', v_printer, r.printer_profile_id;
  END IF;
  IF r.copies <> 3 OR r.ask_user IS NOT FALSE THEN
    RAISE EXCEPTION 'Tier 3: copies/ask_user mismatch — copies=%, ask_user=%',
      r.copies, r.ask_user;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Tier 4 — org default (branch IS NULL AND intent IS NULL) matches.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_biz     uuid := '00000000-0000-0000-0000-0000000b1004';
  v_branch  uuid := '00000000-0000-0000-0000-000000bb1004';
  v_printer uuid := '00000000-0000-0000-0000-0000000fa104';
  r record;
BEGIN
  INSERT INTO public.document_print_policies
    (business_id, branch_id, document_type, intent,
     printer_profile_id, paper_format, render_mode, copies, auto_print)
  VALUES
    (v_biz, NULL, 'invoice', NULL,
     v_printer, 'a4', 'pdf', 1, false);

  SELECT * INTO r
  FROM public.print_policies_resolve(v_biz, v_branch, 'invoice', 'a4_document');

  IF r.printer_profile_id IS DISTINCT FROM v_printer THEN
    RAISE EXCEPTION 'Tier 4: expected printer %, got %', v_printer, r.printer_profile_id;
  END IF;
  IF r.ask_user IS NOT FALSE THEN
    RAISE EXCEPTION 'Tier 4: ask_user should be false when a fallback row exists, got %', r.ask_user;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- No-match — returns synthesized fallback with ask_user=true.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_biz    uuid := '00000000-0000-0000-0000-0000000b1005';
  v_branch uuid := '00000000-0000-0000-0000-000000bb1005';
  r record;
BEGIN
  SELECT * INTO r
  FROM public.print_policies_resolve(v_biz, v_branch, 'invoice', 'a4_document');

  IF r.printer_profile_id IS NOT NULL THEN
    RAISE EXCEPTION 'No-match: printer_profile_id should be NULL, got %', r.printer_profile_id;
  END IF;
  IF r.paper_format <> 'a4' OR r.render_mode <> 'pdf' OR r.copies <> 1
     OR r.auto_print IS NOT FALSE OR r.ask_user IS NOT TRUE THEN
    RAISE EXCEPTION 'No-match: fallback row shape wrong — paper=%, render=%, copies=%, auto=%, ask=%',
      r.paper_format, r.render_mode, r.copies, r.auto_print, r.ask_user;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Ranking tie-breaker — when a branch-scoped row AND an org-default row both
-- exist for the same (business, document_type), the branch row wins.
-- This exercises the ORDER BY specificity path, which the per-tier scenarios
-- above cannot reach (the unique index forbids them coexisting under one biz).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_biz       uuid := '00000000-0000-0000-0000-0000000b1006';
  v_branch    uuid := '00000000-0000-0000-0000-000000bb1006';
  v_printer_branch uuid := '00000000-0000-0000-0000-0000000fa106';
  v_printer_org    uuid := '00000000-0000-0000-0000-0000000fa206';
  r record;
BEGIN
  -- Org-default first
  INSERT INTO public.document_print_policies
    (business_id, branch_id, document_type, intent,
     printer_profile_id, paper_format, render_mode, copies, auto_print)
  VALUES
    (v_biz, NULL, 'invoice', NULL,
     v_printer_org, 'a4', 'pdf', 1, false);

  -- Branch-scoped row coexists (different COALESCE(branch_id, sentinel))
  INSERT INTO public.document_print_policies
    (business_id, branch_id, document_type, intent,
     printer_profile_id, paper_format, render_mode, copies, auto_print)
  VALUES
    (v_biz, v_branch, 'invoice', NULL,
     v_printer_branch, 'a4', 'pdf', 1, false);

  SELECT * INTO r
  FROM public.print_policies_resolve(v_biz, v_branch, 'invoice', NULL);

  IF r.printer_profile_id IS DISTINCT FROM v_printer_branch THEN
    RAISE EXCEPTION 'Tie-breaker: branch row should outrank org-default, got %',
      r.printer_profile_id;
  END IF;

  -- And when the caller is in a DIFFERENT branch, the org-default takes over.
  SELECT * INTO r
  FROM public.print_policies_resolve(
    v_biz, '00000000-0000-0000-0000-0000ffffffff'::uuid, 'invoice', NULL);

  IF r.printer_profile_id IS DISTINCT FROM v_printer_org THEN
    RAISE EXCEPTION 'Tie-breaker: org-default should serve unrelated branch, got %',
      r.printer_profile_id;
  END IF;
END $$;

ROLLBACK;
