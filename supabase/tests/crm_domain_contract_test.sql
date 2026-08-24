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
