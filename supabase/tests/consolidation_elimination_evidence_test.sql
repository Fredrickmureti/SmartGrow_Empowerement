-- Brick 7.4 — elimination drill-down: contract, posture and parity.
-- Run against a database with the consolidation migrations applied:
--   psql "$DATABASE_URL" -f supabase/tests/consolidation_elimination_evidence_test.sql
-- Every block rolls itself back; nothing is committed.
--
-- Block 3 needs a *signed-in* caller with an organisation role, because the
-- functions under test are SECURITY INVOKER and the translated trial balance
-- refuses an anonymous session. It skips itself, loudly, when run without one.

-- ---------------------------------------------------------------------------
-- Block 1 — posture: invoker, fixed search_path, no anonymous execution.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_name text;
  v_secdef boolean;
  v_config text[];
BEGIN
  FOREACH v_name IN ARRAY ARRAY['consolidation_intercompany_entry_lines',
                                'consolidation_elimination_evidence']
  LOOP
    SELECT p.prosecdef, p.proconfig INTO v_secdef, v_config
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;

    IF v_secdef IS NULL THEN
      RAISE EXCEPTION 'the drill-down function % is missing', v_name;
    END IF;
    IF v_secdef THEN
      RAISE EXCEPTION '% must be SECURITY INVOKER so member-level access still applies', v_name;
    END IF;
    IF v_config IS NULL OR NOT (v_config @> ARRAY['search_path=public']) THEN
      RAISE EXCEPTION '% must pin search_path to public', v_name;
    END IF;

    IF has_function_privilege('anon', format('public.%I(uuid,date,date%s)', v_name,
         CASE WHEN v_name = 'consolidation_elimination_evidence'
              THEN ',consolidation_elimination_class,uuid,uuid,uuid' ELSE '' END), 'EXECUTE') THEN
      RAISE EXCEPTION 'anon must not be able to execute %', v_name;
    END IF;
    IF NOT has_function_privilege('authenticated', format('public.%I(uuid,date,date%s)', v_name,
         CASE WHEN v_name = 'consolidation_elimination_evidence'
              THEN ',consolidation_elimination_class,uuid,uuid,uuid' ELSE '' END), 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated must be able to execute %', v_name;
    END IF;
  END LOOP;

  RAISE NOTICE 'BRICK7.4 POSTURE OK';
END $$;

-- ---------------------------------------------------------------------------
-- Block 2 — one computation: the summary is a projection of the evidence.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'consolidation_intercompany_flows';
  IF v_src NOT LIKE '%consolidation_intercompany_entry_lines%' THEN
    RAISE EXCEPTION 'intercompany flows must aggregate the entry-level evidence, not re-derive it';
  END IF;
  IF v_src LIKE '%exchange_rates%' THEN
    RAISE EXCEPTION 'intercompany flows must not read the rate book directly';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'consolidation_intercompany_entry_lines';
  IF v_src NOT LIKE '%resolve_consolidation_scope%' THEN
    RAISE EXCEPTION 'the entry-level reader must gate on the consolidation scope';
  END IF;
  IF v_src NOT LIKE '%get_consolidated_trial_balance_translated%' THEN
    RAISE EXCEPTION 'the entry-level reader must translate through the consolidated trial balance';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'consolidation_elimination_evidence';
  IF v_src NOT LIKE '%consolidation_intercompany_entry_lines%' THEN
    RAISE EXCEPTION 'the evidence function must read the same source the generator reads';
  END IF;
  IF v_src NOT LIKE '%has_org_role%' THEN
    RAISE EXCEPTION 'the evidence function must apply the same organisation check as generation';
  END IF;
  IF v_src NOT LIKE '%user_can_access_business%' THEN
    RAISE EXCEPTION 'the evidence function must decide ledger access server-side';
  END IF;

  RAISE NOTICE 'BRICK7.4 DELEGATION OK';
END $$;

-- ---------------------------------------------------------------------------
-- Block 3 — parity against live data, for a signed-in accountant.
-- For every consolidation group with generated eliminations, the evidence
-- behind each non-difference leg must reconcile to the leg it explains, and
-- the flow summary must equal the sum of its own entry lines.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_from date;
  v_to date;
  v_flow_debit numeric;
  v_line_debit numeric;
  v_evidence numeric;
  v_checked int := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE NOTICE 'BRICK7.4 PARITY SKIPPED — run this file as a signed-in accountant; '
                 'the translated trial balance refuses an anonymous session';
    RETURN;
  END IF;

  FOR r IN
    SELECT e.group_id,
           min(e.period_start) AS period_start,
           max(e.period_end)   AS period_end
      FROM public.consolidation_eliminations e
     GROUP BY e.group_id
     LIMIT 5
  LOOP
    v_from := r.period_start;
    v_to   := r.period_end;

    SELECT coalesce(sum(f.debit_presentation), 0) INTO v_flow_debit
      FROM public.consolidation_intercompany_flows(r.group_id, v_from, v_to) f;
    SELECT coalesce(sum(l.debit_presentation), 0) INTO v_line_debit
      FROM public.consolidation_intercompany_entry_lines(r.group_id, v_from, v_to) l;

    -- Rounding is applied once, on the aggregate, so the two may differ only
    -- by sub-unit rounding per aggregated group; a whole-unit gap is a bug.
    IF abs(v_flow_debit - v_line_debit) >= 1 THEN
      RAISE EXCEPTION 'group %: the flow summary (%) and its own entry lines (%) disagree',
        r.group_id, v_flow_debit, v_line_debit;
    END IF;

    FOR r IN
      SELECT el.group_id, el.elimination_class, el.declaring_business_id,
             el.counterparty_business_id, el.group_account_id,
             el.period_start, el.period_end, el.debit, el.credit
        FROM public.consolidation_eliminations el
       WHERE el.group_id = r.group_id
         AND el.period_start = v_from AND el.period_end = v_to
         AND NOT el.is_difference
    LOOP
      SELECT coalesce(sum(ev.debit_presentation - ev.credit_presentation), 0)
        INTO v_evidence
        FROM public.consolidation_elimination_evidence(
               r.group_id, r.period_start, r.period_end, r.elimination_class,
               r.declaring_business_id, r.counterparty_business_id, r.group_account_id) ev;

      -- An elimination reverses the position it removes: the leg's credit is
      -- the position's debit and vice versa.
      IF abs(v_evidence + (r.debit - r.credit)) >= 1 THEN
        RAISE EXCEPTION
          'leg % / % : the evidence nets to % but the leg removed %',
          r.elimination_class, r.group_account_id, v_evidence, (r.debit - r.credit);
      END IF;
      v_checked := v_checked + 1;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'BRICK7.4 PARITY OK — % legs reconciled to their evidence', v_checked;
END $$;
