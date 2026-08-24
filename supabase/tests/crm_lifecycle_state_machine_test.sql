-- crm_lifecycle_state_machine_test.sql
--
-- CRM Domain Audit — Phase 2 ratchets (lifecycle state machine).
-- Catalog-level assertions hold on an empty database; the behavioural block
-- exercises the invariants against a real business fixture.

-- ---------------------------------------------------------------------------
-- C1 · crm_leads.status exists, is the enum, and is NOT NULL.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='crm_leads'
       AND column_name='status' AND is_nullable='NO'
       AND udt_name='crm_lead_status'
  ) THEN
    RAISE EXCEPTION 'C1: crm_leads.status must exist as a NOT NULL crm_lead_status enum column';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- C2 · The lifecycle write guard and the scope guard are attached.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(t.expected, ', ')
    INTO v_missing
    FROM (VALUES
      ('trg_crm_lead_lifecycle_write_guard', 'crm_leads'),
      ('trg_crm_lead_scope_guard',           'crm_leads'),
      ('trg_crm_stage_deactivation_guard',   'crm_stages')
    ) AS t(expected, tbl)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_trigger tg
       JOIN pg_class c ON c.oid = tg.tgrelid
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relname = t.tbl AND tg.tgname = t.expected AND NOT tg.tgisinternal
   );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'C2: missing CRM lifecycle trigger(s): %', v_missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- C3 · Every transition RPC exists, is SECURITY DEFINER, authorizes the caller
--      and is not executable by anon.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_fns text[] := ARRAY['crm_qualify_lead','crm_change_stage','crm_mark_won',
                        'crm_mark_lost','crm_reopen_lead','crm_reassign_lead',
                        'crm_revalue_lead','crm_archive_lead'];
  f text; v_oid oid;
BEGIN
  FOREACH f IN ARRAY v_fns LOOP
    SELECT p.oid INTO v_oid FROM pg_proc p
      WHERE p.pronamespace='public'::regnamespace AND p.proname = f;
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'C3: transition RPC %() is missing', f;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
      RAISE EXCEPTION 'C3: %() must be SECURITY DEFINER', f;
    END IF;
    IF pg_get_functiondef(v_oid) !~ '_crm_assert_lead_access' THEN
      RAISE EXCEPTION 'C3: %() does not authorize the caller', f;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'C3: anon may execute %()', f;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- C4 · Terminal-state and probability invariants are declared.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.crm_leads'::regclass
       AND conname='crm_leads_terminal_consistency'
  ) THEN
    RAISE EXCEPTION 'C4: crm_leads_terminal_consistency constraint missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.crm_stages'::regclass
       AND conname='crm_stages_not_both_terminal'
  ) THEN
    RAISE EXCEPTION 'C4: a stage may not be both won and lost — constraint missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname='public' AND indexname='crm_stages_one_won_per_business')
  OR NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname='public' AND indexname='crm_stages_one_lost_per_business') THEN
    RAISE EXCEPTION 'C4: one-terminal-stage-per-business uniqueness missing';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- B1 · Behavioural: the guard rejects a direct lifecycle UPDATE, the terminal
--      constraint rejects contradictory state, and the stage-deactivation
--      guard rejects removing a stage that still holds open leads.
-- ---------------------------------------------------------------------------
BEGIN;
  DO $$
  DECLARE
    v_org uuid; v_biz uuid; v_stage uuid; v_lead uuid; v_ok boolean;
  BEGIN
    SELECT organization_id, id INTO v_org, v_biz FROM public.businesses LIMIT 1;
    IF v_biz IS NULL THEN
      RAISE EXCEPTION 'no business fixture — the CRM lifecycle contract cannot be exercised';
    END IF;

    INSERT INTO public.crm_stages
      (organization_id, business_id, name, sequence, probability, is_active)
    VALUES (v_org, v_biz, 'pgtap stage', 999, 30, true)
    RETURNING id INTO v_stage;

    INSERT INTO public.crm_leads
      (organization_id, business_id, lead_number, name, stage_id)
    VALUES (v_org, v_biz, 'TEST-LC-' || extract(epoch from now())::bigint,
            'pgtap lifecycle lead', v_stage)
    RETURNING id INTO v_lead;

    -- Direct lifecycle write must be refused.
    v_ok := false;
    BEGIN
      UPDATE public.crm_leads SET status = 'won' WHERE id = v_lead;
    EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'B1: a direct UPDATE of crm_leads.status was accepted';
    END IF;

    -- Contradictory terminal state must be refused even from a privileged path.
    v_ok := false;
    BEGIN
      PERFORM set_config('app.crm_lead_writer', '1', true);
      UPDATE public.crm_leads
         SET status='won', won_at=now(), lost_at=now(), probability=100
       WHERE id = v_lead;
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    PERFORM set_config('app.crm_lead_writer', '0', true);
    IF NOT v_ok THEN
      RAISE EXCEPTION 'B1: won_at and lost_at were allowed simultaneously';
    END IF;

    -- Cross-business stage assignment must be refused.
    v_ok := false;
    BEGIN
      PERFORM set_config('app.crm_lead_writer', '1', true);
      UPDATE public.crm_leads
         SET stage_id = (SELECT id FROM public.crm_stages
                          WHERE business_id <> v_biz LIMIT 1)
       WHERE id = v_lead AND EXISTS (SELECT 1 FROM public.crm_stages WHERE business_id <> v_biz);
      v_ok := NOT EXISTS (SELECT 1 FROM public.crm_stages WHERE business_id <> v_biz);
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    PERFORM set_config('app.crm_lead_writer', '0', true);
    IF NOT v_ok THEN
      RAISE EXCEPTION 'B1: a lead accepted a stage from another business';
    END IF;

    -- Stage deactivation with an open lead must be refused.
    v_ok := false;
    BEGIN
      UPDATE public.crm_stages SET is_active = false WHERE id = v_stage;
    EXCEPTION WHEN foreign_key_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'B1: a stage holding an open opportunity was deactivated';
    END IF;
  END $$;
ROLLBACK;
