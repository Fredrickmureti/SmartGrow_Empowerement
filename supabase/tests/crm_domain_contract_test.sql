-- crm_domain_contract_test.sql
--
-- CRM Domain Audit — Phase 0 regression harness (see
-- .lovable/plan/crm-domain-audit-rework-contract-2026-08-24.md).
--
-- These are CATALOG-level ratchets: they read the shipped definitions of the
-- CRM functions, policies and grants, so they hold even on an empty database.
-- Each block guards one confirmed defect from the audit:
--
--   D1  every convert_lead_to_* RPC logs a system activity but omits
--       crm_activities.business_id, which is NOT NULL with no default — so
--       EVERY conversion aborts with a not-null violation and rolls back.
--   D2  the same RPCs (plus calculate_pipeline_value / get_next_lead_number)
--       are SECURITY DEFINER with no caller authorization at all: they act on
--       whatever lead/org id the browser hands them, bypassing RLS.
--   D3  get_next_lead_number derives the sequence from COUNT(*) + 1, which is
--       neither atomic (unique-violation races) nor monotonic (soft-deleted
--       leads make numbers repeat).
--   D5  crm_stages / crm_activities / crm_activity_types / crm_lost_reasons
--       are gated on organization_id only, so one tenant's businesses leak
--       into each other even though crm_activities.business_id is NOT NULL.
--   D6  anon holds full write privileges on every crm_* table; RLS is the only
--       thing standing between an unauthenticated caller and the pipeline.

-- ---------------------------------------------------------------------------
-- D1 · No CRM function may insert crm_activities without business_id.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname)
    INTO v_bad
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND pg_get_functiondef(p.oid) ~* 'INSERT\s+INTO\s+(public\.)?crm_activities'
     AND pg_get_functiondef(p.oid) !~* 'INSERT\s+INTO\s+(public\.)?crm_activities\s*\([^)]*business_id';

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'D1: function(s) insert crm_activities without business_id (NOT NULL) — every call aborts: %',
      v_bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- D2 · Every SECURITY DEFINER function that reads or writes CRM state must
--      authorize the caller. Read-only helper predicates are exempt.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_exempt text[] := ARRAY[
    -- Generic infrastructure triggers that are not CRM entry points.
    'notify_automation_event',
    'trigger_automation_processor',
    'enforce_org_write_lock'
  ];
  v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname)
    INTO v_bad
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.prosecdef
     AND NOT (p.proname = ANY (v_exempt))
     AND pg_get_functiondef(p.oid) ~* '(crm_leads|crm_stages|crm_activities)'
     AND pg_get_functiondef(p.oid) !~*
         '(user_can_access_business|user_has_module_permission|_assert_org_member|get_user_organizations|has_role\s*\()';

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'D2: SECURITY DEFINER CRM function(s) with no caller authorization (cross-tenant write): %',
      v_bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- D3 · Lead numbering must not be derived from COUNT(*).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = 'get_next_lead_number'
       AND pg_get_functiondef(p.oid) ~* 'COUNT\s*\(\s*\*\s*\)\s*\+\s*1'
  ) THEN
    RAISE EXCEPTION
      'D3: get_next_lead_number derives the sequence from COUNT(*)+1 — races against UNIQUE(organization_id, lead_number)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- D5 · Every CRM table that carries business_id must be business-scoped in RLS.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(format('%s.%s', pol.tablename, pol.policyname), '; ' ORDER BY pol.tablename, pol.policyname)
    INTO v_bad
    FROM pg_policies pol
   WHERE pol.schemaname = 'public'
     AND pol.tablename LIKE 'crm\_%'
     AND EXISTS (
       SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = pol.tablename
          AND c.column_name = 'business_id'
     )
     AND coalesce(pol.qual, '') || coalesce(pol.with_check, '') NOT ILIKE '%business_id%';

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'D5: CRM policies ignore business_id (cross-business leakage inside a tenant): %',
      v_bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- D6 · anon must hold no privileges on CRM tables. Every CRM policy is
--      auth.uid()-derived, so anon access can only ever be an accident.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(format('%s:%s', table_name, privilege_type), ', ' ORDER BY table_name, privilege_type)
    INTO v_bad
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name LIKE 'crm\_%'
     AND grantee = 'anon';

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'D6: anon holds privileges on CRM tables: %', v_bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Structural guard: crm_activities.business_id must stay NOT NULL. If a future
-- migration "fixes" D1 by relaxing the column instead of supplying the value,
-- this test must still fail.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'crm_activities'
       AND column_name = 'business_id' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'crm_activities.business_id must remain NOT NULL — activities are business-scoped records';
  END IF;
END $$;

-- ===========================================================================
-- Phase 4 · Branch dimension + cross-business referential integrity (D7).
-- Catalog-level ratchets: they read shipped definitions, so they hold on an
-- empty database.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- D7a · Every business-scoped reference off crm_leads must be enforced by a
--       COMPOSITE foreign key that carries business_id. A single-column FK
--       lets Business A point at Business B's stage/contact/reason/branch.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_col text;
  v_bad text := '';
BEGIN
  FOREACH v_col IN ARRAY ARRAY['stage_id','contact_id','company_contact_id','lost_reason_id','branch_id'] LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_constraint c
       WHERE c.conrelid = 'public.crm_leads'::regclass
         AND c.contype = 'f'
         AND cardinality(c.conkey) = 2
         AND (
           SELECT array_agg(a.attname::text ORDER BY a.attname)
             FROM unnest(c.conkey) k
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
         ) @> ARRAY['business_id', v_col]
    ) THEN
      v_bad := v_bad || v_col || ' ';
    END IF;
  END LOOP;

  IF v_bad <> '' THEN
    RAISE EXCEPTION
      'D7a: crm_leads column(s) lack a composite (business_id, ...) foreign key — cross-business references are possible: %',
      v_bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- D7b · The composite FKs above are only enforceable while the referenced
--       tables keep their (business_id, id) identity key.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_tbl text;
  v_bad text := '';
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['crm_stages','crm_lost_reasons','contacts','branches'] LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_constraint c
       WHERE c.conrelid = format('public.%I', v_tbl)::regclass
         AND c.contype IN ('u','p')
         AND cardinality(c.conkey) = 2
         AND (
           SELECT array_agg(a.attname::text ORDER BY a.attname)
             FROM unnest(c.conkey) k
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
         ) = ARRAY['business_id','id']
    ) THEN
      v_bad := v_bad || v_tbl || ' ';
    END IF;
  END LOOP;

  IF v_bad <> '' THEN
    RAISE EXCEPTION
      'D7b: table(s) lost their UNIQUE (business_id, id) key that CRM composite FKs depend on: %',
      v_bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- D7c · assigned_to must be constrained to an active member of the lead's
--       organization by a database trigger, not by UI convention.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.crm_leads'::regclass
       AND NOT t.tgisinternal
       AND t.tgname = 'crm_leads_assignee_guard'
  ) THEN
    RAISE EXCEPTION
      'D7c: crm_leads_assignee_guard trigger is missing — leads can be assigned to non-members';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = '_crm_lead_assignee_guard'
       AND p.prosecdef
       AND pg_get_functiondef(p.oid) ILIKE '%user_roles%'
  ) THEN
    RAISE EXCEPTION
      'D7c: _crm_lead_assignee_guard must stay SECURITY DEFINER and validate membership via user_roles';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Branch dimension · the branch column must exist on every branch-aware CRM
-- table, and lead history must retain the from/to branch trail.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_tbl text;
  v_bad text := '';
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['crm_leads','crm_stages','crm_activities','crm_lost_reasons','crm_lead_history'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = v_tbl AND column_name = 'branch_id'
    ) THEN
      v_bad := v_bad || v_tbl || ' ';
    END IF;
  END LOOP;

  IF v_bad <> '' THEN
    RAISE EXCEPTION 'Branch dimension: branch_id missing on CRM table(s): %', v_bad;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'crm_lead_history'
       AND column_name = 'from_branch_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'crm_lead_history'
       AND column_name = 'to_branch_id'
  ) THEN
    RAISE EXCEPTION
      'Branch dimension: crm_lead_history must retain from_branch_id/to_branch_id for the transfer trail';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Branch transfers are a governed operation: only crm_transfer_lead_branch may
-- move a lead, and the lifecycle write guard must reject a direct branch_id
-- UPDATE from the client.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = 'crm_transfer_lead_branch'
       AND p.prosecdef
  ) THEN
    RAISE EXCEPTION
      'Branch transfer: crm_transfer_lead_branch (SECURITY DEFINER) is missing';
  END IF;

  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname = '_crm_lead_lifecycle_write_guard') NOT ILIKE '%branch_id%' THEN
    RAISE EXCEPTION
      'Branch transfer: _crm_lead_lifecycle_write_guard no longer guards branch_id — direct client transfers are possible';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Event contract · the emitted lead payload must carry the branch dimension,
-- and the branch_transferred topic must be registered for the dispatcher.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = '_crm_emit_lead_event';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Event contract: _crm_emit_lead_event is missing';
  END IF;

  IF v_def NOT ILIKE '%branch_id%'
     OR v_def NOT ILIKE '%from_branch_id%'
     OR v_def NOT ILIKE '%to_branch_id%' THEN
    RAISE EXCEPTION
      'Event contract: _crm_emit_lead_event payload must carry branch_id, from_branch_id and to_branch_id';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.business_event_topics
     WHERE topic_prefix = 'crm.lead.branch_transferred'
  ) THEN
    RAISE EXCEPTION
      'Event contract: topic crm.lead.branch_transferred is not registered — transfers dead-letter as unknown events';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- R0 · crm_lead_items tenancy: business is mandatory and must equal the
-- parent lead's business (composite FK), and a product on the line must
-- belong to the same business.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'crm_lead_items'
       AND column_name = 'business_id' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION
      'R0: crm_lead_items.business_id is nullable — lead lines can escape business scope';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.crm_lead_items'::regclass
       AND contype = 'f'
       AND pg_get_constraintdef(oid) ILIKE '%(lead_id, business_id)%'
       AND pg_get_constraintdef(oid) ILIKE '%crm_leads(id, business_id)%'
  ) THEN
    RAISE EXCEPTION
      'R0: crm_lead_items has no (lead_id, business_id) composite FK to crm_leads — an item may reference another business''s lead';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE t.tgrelid = 'public.crm_lead_items'::regclass
       AND NOT t.tgisinternal
       AND p.proname = '_crm_lead_item_product_business_guard'
  ) THEN
    RAISE EXCEPTION
      'R0: crm_lead_items has no product/business validation trigger — a lead line may price another business''s product';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- R0 · crm_lead_history is append-only infrastructure: anon must hold no
-- privileges at all, and authenticated must hold read-only privileges.
-- Rows are written by the SECURITY DEFINER history trigger.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(format('%s:%s', grantee, privilege_type), ', ')
    INTO v_bad
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name = 'crm_lead_history'
     AND (grantee = 'anon'
          OR (grantee = 'authenticated' AND privilege_type <> 'SELECT'));

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'R0: crm_lead_history grants violate least privilege: %', v_bad;
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.crm_lead_history', 'SELECT') THEN
    RAISE EXCEPTION
      'R0: authenticated cannot read crm_lead_history — the lifecycle timeline is unreadable';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- R0 · Event honesty: a registered topic with no consumer domains must be
-- explicitly flagged integration_only, so the registry never implies a
-- downstream workflow that does not exist.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(topic_prefix, ', ')
    INTO v_bad
    FROM public.business_event_topics
   WHERE topic_prefix LIKE 'crm.%'
     AND (consumer_domains IS NULL OR cardinality(consumer_domains) = 0)
     AND integration_only IS NOT TRUE;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'R0: CRM topics have no consumer domains and are not flagged integration_only: %', v_bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- R1 · Every lifecycle RPC must accept an optimistic-concurrency token, so a
-- stale screen can never silently overwrite another user's transition.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(format('%s(%s)', p.proname,
                           pg_get_function_identity_arguments(p.oid)), ', ')
    INTO v_missing
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('crm_qualify_lead','crm_change_stage','crm_mark_proposition',
                       'crm_withdraw_proposition','crm_mark_won','crm_mark_lost',
                       'crm_reopen_lead','crm_reassign_lead','crm_revalue_lead',
                       'crm_archive_lead','crm_restore_lead')
     AND NOT ('p_expected_version' = ANY (coalesce(p.proargnames, ARRAY[]::text[])));

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      'R1: lifecycle RPCs without optimistic concurrency: %', v_missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- R1 · The lifecycle surface must be complete: every state in
-- crm_lead_status has a transition function that can reach it, and archive
-- has a documented inverse.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(fn, ', ') INTO v_missing
    FROM unnest(ARRAY['crm_qualify_lead','crm_mark_proposition','crm_mark_won',
                      'crm_mark_lost','crm_reopen_lead','crm_archive_lead',
                      'crm_restore_lead','crm_withdraw_proposition']) fn
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p
                      WHERE p.pronamespace = 'public'::regnamespace
                        AND p.proname = fn);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'R1: lifecycle functions missing: %', v_missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- R1 · Lifecycle provenance columns exist and version is NOT NULL defaulted,
-- so concurrency control cannot be bypassed by a null token.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(c, ', ') INTO v_missing
    FROM unnest(ARRAY['qualified_at','proposition_at','reopened_at','reopen_count',
                      'reopen_reason','archived_at','archived_by','archive_reason',
                      'version']) c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema='public' AND table_name='crm_leads'
                        AND column_name = c);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'R1: crm_leads is missing lifecycle columns: %', v_missing;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='crm_leads'
                AND column_name='version'
                AND (is_nullable='YES' OR column_default IS NULL)) THEN
    RAISE EXCEPTION 'R1: crm_leads.version must be NOT NULL with a default';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.crm_leads'::regclass
                    AND NOT tgisinternal
                    AND tgname = 'crm_leads_version_bump') THEN
    RAISE EXCEPTION 'R1: the version-bump trigger on crm_leads is missing';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- R1 · Archive is a closed invariant: is_active=false <-> archived_at set.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.crm_leads
   WHERE (is_active = false) <> (archived_at IS NOT NULL);
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'R1: % lead(s) disagree between is_active and archived_at', v_n;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- R1 · Pipeline configuration is an administration capability. Stage
-- write policies must go through crm_can_admin_pipeline, not plain sales.write.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(policyname, ', ') INTO v_bad
    FROM pg_policies
   WHERE schemaname='public' AND tablename='crm_stages'
     AND cmd IN ('INSERT','UPDATE','DELETE')
     AND coalesce(qual, '') || coalesce(with_check, '') NOT LIKE '%crm_can_admin_pipeline%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'R1: crm_stages write policies not gated on pipeline administration: %', v_bad;
  END IF;
END $$;
