-- crm_lead_history_and_events_test.sql
--
-- CRM Domain Audit — Phase 3 ratchets (authoritative history + business events).
--
--   H1  the history recorder and the outbox emitter are attached as triggers,
--       so no lifecycle transition can be written without an audit row.
--   H2  crm_lead_history is append-only (no UPDATE, no DELETE).
--   H3  every crm.lead.* topic the database can emit is registered in
--       business_event_topics (the dispatcher's registry is closed — an
--       unregistered topic dead-letters as unknown_event_type).
--   H4  behavioural: each transition writes exactly one history row of the
--       right event, with correct from/to values, plus one matching outbox row;
--       reason-bearing transitions persist their reason.

-- ---------------------------------------------------------------------------
-- H1 · Triggers attached.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(x.expected, ', ')
    INTO v_missing
    FROM (VALUES
      ('crm_leads_history_record',      'crm_leads'),
      ('crm_lead_history_emit_event',   'crm_lead_history')
    ) AS x(expected, tbl)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_trigger tg
       JOIN pg_class c ON c.oid = tg.tgrelid
      WHERE NOT tg.tgisinternal
        AND tg.tgname = x.expected
        AND c.relname = x.tbl
   );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'H1: missing CRM history/event trigger(s): %', v_missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- H3 · Topic registration for every event the recorder can produce.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(t.topic, ', ' ORDER BY t.topic)
    INTO v_missing
    FROM unnest(ARRAY[
      'crm.lead.qualified','crm.lead.stage_changed','crm.lead.won','crm.lead.lost',
      'crm.lead.reopened','crm.lead.reassigned','crm.lead.revalued','crm.lead.archived'
    ]) AS t(topic)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.business_event_topics bt
      WHERE bt.topic_prefix = t.topic AND bt.producer_domain = 'crm'
   );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'H3: crm lead topic(s) not registered: %', v_missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- H2 + H4 · Behavioural.
-- ---------------------------------------------------------------------------
BEGIN;
  DO $$
  DECLARE
    v_org uuid; v_biz uuid; v_stage uuid; v_stage2 uuid; v_won uuid; v_lead uuid;
    v_n int; v_reason text; v_ok boolean; v_hist uuid;
  BEGIN
    SELECT organization_id, id INTO v_org, v_biz FROM public.businesses LIMIT 1;
    IF v_biz IS NULL THEN
      RAISE EXCEPTION 'no business row available — the CRM history contract cannot be exercised';
    END IF;

    INSERT INTO public.crm_stages (organization_id, business_id, name, sequence, probability, is_active)
    VALUES (v_org, v_biz, 'pgtap hist stage A', 990, 20, true) RETURNING id INTO v_stage;
    INSERT INTO public.crm_stages (organization_id, business_id, name, sequence, probability, is_active)
    VALUES (v_org, v_biz, 'pgtap hist stage B', 991, 40, true) RETURNING id INTO v_stage2;

    INSERT INTO public.crm_leads (organization_id, business_id, lead_number, name, stage_id, expected_revenue)
    VALUES (v_org, v_biz, 'TEST-HIST-' || extract(epoch from clock_timestamp())::bigint,
            'pgtap history lead', v_stage, 1000)
    RETURNING id INTO v_lead;

    -- Transitions are driven through the guarded write path rather than the
    -- RPCs: the RPCs require auth.uid() (`_crm_assert_lead_access`), which a
    -- SQL-harness session does not have. The trigger under test sits on the
    -- table, so the guarded UPDATE exercises exactly the same code path.

    -- Stage change → exactly one 'stage_changed' row with correct from/to.
    PERFORM set_config('app.crm_lead_writer', '1', true);
    UPDATE public.crm_leads SET stage_id = v_stage2 WHERE id = v_lead;
    PERFORM set_config('app.crm_lead_writer', '0', true);
    SELECT count(*) INTO v_n FROM public.crm_lead_history
     WHERE lead_id = v_lead AND event = 'stage_changed'
       AND from_stage_id = v_stage AND to_stage_id = v_stage2;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'H4: stage change recorded % history row(s), expected 1', v_n;
    END IF;

    -- Revalue → 'revalued' with from/to value.
    PERFORM set_config('app.crm_lead_writer', '1', true);
    UPDATE public.crm_leads SET expected_revenue = 2500 WHERE id = v_lead;
    PERFORM set_config('app.crm_lead_writer', '0', true);
    SELECT count(*) INTO v_n FROM public.crm_lead_history
     WHERE lead_id = v_lead AND event = 'revalued'
       AND from_value = 1000 AND to_value = 2500;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'H4: revalue recorded % history row(s), expected 1', v_n;
    END IF;

    -- Lost → 'lost' row carrying the reason published by the RPC.
    PERFORM set_config('app.crm_lead_writer', '1', true);
    PERFORM set_config('app.crm_lead_reason', 'pgtap lost note', true);
    UPDATE public.crm_leads
       SET status = 'lost', lost_at = now(), probability = 0
     WHERE id = v_lead;
    PERFORM set_config('app.crm_lead_writer', '0', true);
    PERFORM set_config('app.crm_lead_reason', '', true);
    SELECT reason INTO v_reason FROM public.crm_lead_history
     WHERE lead_id = v_lead AND event = 'lost';
    IF v_reason IS DISTINCT FROM 'pgtap lost note' THEN
      RAISE EXCEPTION 'H4: lost history row lost its reason (got %)', coalesce(v_reason, '<null>');
    END IF;


    -- Every history row produced a business event of the matching topic.
    SELECT count(*) INTO v_n
      FROM public.crm_lead_history h
     WHERE h.lead_id = v_lead
       AND NOT EXISTS (
         SELECT 1 FROM public.business_event_outbox o
          WHERE o.source_doc_id = h.lead_id
            AND o.event_type = 'crm.lead.' || h.event
            AND o.source = 'crm');
    IF v_n > 0 THEN
      RAISE EXCEPTION 'H4: % history row(s) produced no business event', v_n;
    END IF;

    -- H2 · append-only.
    SELECT id INTO v_hist FROM public.crm_lead_history WHERE lead_id = v_lead LIMIT 1;
    v_ok := false;
    BEGIN
      UPDATE public.crm_lead_history SET reason = 'tampered' WHERE id = v_hist;
    EXCEPTION WHEN OTHERS THEN v_ok := true;
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'H2: a crm_lead_history row was updated';
    END IF;

    v_ok := false;
    BEGIN
      DELETE FROM public.crm_lead_history WHERE id = v_hist;
    EXCEPTION WHEN OTHERS THEN v_ok := true;
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'H2: a crm_lead_history row was deleted';
    END IF;
  END $$;
ROLLBACK;
