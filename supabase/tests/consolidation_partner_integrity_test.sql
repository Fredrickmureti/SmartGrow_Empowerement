-- Intercompany partner integrity — 2026-08-29.
-- Run against a database with the consolidation migrations applied:
--   psql "$DATABASE_URL" -f supabase/tests/consolidation_partner_integrity_test.sql
-- Any failed assertion raises and aborts the transaction; nothing is committed.

BEGIN;

DO $$
DECLARE
  v_group public.consolidation_groups;
  v_partner public.consolidation_intercompany_partners;
  v_person uuid;
  v_ok boolean;
BEGIN
  ---------------------------------------------------------- 1. wiring -------
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'consolidation_leg_faces_counterparty'
       AND pg_get_function_identity_arguments(p.oid) = 'uuid, uuid, uuid, uuid, date') THEN
    RAISE EXCEPTION 'an intercompany leg must be tested on the entry''s own date, not on the report window';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'consolidation_leg_faces_counterparty'
       AND pg_get_function_identity_arguments(p.oid) = 'uuid, uuid, uuid, uuid, date, date') THEN
    RAISE EXCEPTION 'the report-window signature must be gone so no caller can reach it by accident';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'consolidation_partner_integrity_report') THEN
    RAISE EXCEPTION 'existing declarations must be reviewable';
  END IF;

  ------------------------------------------------- 2. authorisation ---------
  IF has_function_privilege('anon',
       'public.consolidation_partner_integrity_report(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not read intercompany declarations';
  END IF;
  IF has_function_privilege('anon',
       'public.consolidation_leg_faces_counterparty(uuid,uuid,uuid,uuid,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not probe intercompany scoping';
  END IF;

  ------------------------------------- 3. the audit trail accepts policy ----
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'consolidation_group_change_log_entity_check'
       AND pg_get_constraintdef(oid) LIKE '%elimination_rule%') THEN
    RAISE EXCEPTION 'an elimination-rule change must be recordable in the change log';
  END IF;

  ----------------------- 4. a natural person cannot stand for a company -----
  SELECT * INTO v_partner
    FROM public.consolidation_intercompany_partners LIMIT 1;

  IF v_partner.id IS NOT NULL THEN
    SELECT c.id INTO v_person
      FROM public.contacts c
     WHERE c.business_id = v_partner.business_id
       AND COALESCE(c.is_company, false) IS NOT TRUE
     LIMIT 1;

    IF v_person IS NOT NULL THEN
      v_ok := false;
      BEGIN
        INSERT INTO public.consolidation_intercompany_partners
          (organization_id, group_id, business_id, counterparty_business_id,
           contact_id, effective_from)
        VALUES (v_partner.organization_id, v_partner.group_id, v_partner.business_id,
                v_partner.counterparty_business_id, v_person, v_partner.effective_from);
      EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM LIKE '%individual%';
      END;
      IF NOT v_ok THEN
        RAISE EXCEPTION 'an individual contact must never be accepted as a group company''s stand-in';
      END IF;
    END IF;
  END IF;

  ----------------------------- 5. no live declaration is an individual ------
  IF EXISTS (
    SELECT 1
      FROM public.consolidation_intercompany_partners p
      JOIN public.contacts c ON c.id = p.contact_id
     WHERE COALESCE(c.is_company, false) IS NOT TRUE) THEN
    RAISE EXCEPTION 'a stored declaration still points at an individual contact';
  END IF;

  RAISE NOTICE 'Intercompany partner integrity invariants: OK';
END $$;

ROLLBACK;

-- Regression: the intercompany flow engine is STABLE, so it may never build a
-- temporary table — Postgres refuses CREATE TABLE in a non-volatile function
-- and the elimination run fails at read time.
BEGIN;
SELECT plan(2);

SELECT ok(
  pg_get_functiondef('public.consolidation_intercompany_entry_lines(uuid,date,date)'::regprocedure)
    !~* 'CREATE\s+TEMP',
  'consolidation_intercompany_entry_lines must not create a temporary table'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'consolidation_intercompany_scoped_entries'
       AND p.provolatile = 's'
  ),
  'the scoped-entry helper exists and is STABLE'
);

SELECT * FROM finish();
ROLLBACK;
