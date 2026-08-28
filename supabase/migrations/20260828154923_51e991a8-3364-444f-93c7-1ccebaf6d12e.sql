-- ---------------------------------------------------------------------------
-- R5: remove the cause of the consolidation residual, not the symptom.
--
-- The parent carries an intragroup receivable of KES 2,630,000 against a
-- USD 20,000 payable: the trade rate was 131.5, the closing rate is 129.5.
-- Under IAS 21.45 that KES 40,000 is an exchange difference of the parent and
-- belongs in the parent's profit or loss. It is not a consolidation plug and
-- it is not a translation reserve movement.
--
-- No second accounting engine is introduced. The existing period-end FX
-- revaluation stays the only thing that posts. What is added is one shared
-- definition of an open monetary position, a read-only diagnosis built on it,
-- and a refusal that names the remedy instead of leaving the user to guess.
-- ---------------------------------------------------------------------------

-- One definition of "exposed to currency movement", used by the posting engine
-- and by the diagnosis, so the two can never disagree.
CREATE OR REPLACE FUNCTION public.fx_open_monetary_positions(_business_id uuid, _as_of date)
RETURNS TABLE(account_id uuid, currency text, foreign_balance numeric, base_balance_old numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    jel.account_id,
    upper(COALESCE(jel.original_currency, je.currency)) AS currency,
    SUM(COALESCE(jel.original_debit, jel.debit, 0) - COALESCE(jel.original_credit, jel.credit, 0)) AS foreign_balance,
    SUM(COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0)) AS base_balance_old
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.accounts a ON a.id = jel.account_id
  JOIN public.businesses b ON b.id = je.business_id
  WHERE je.business_id = _business_id
    AND je.status = 'posted'
    AND je.entry_date <= _as_of
    AND COALESCE(jel.original_currency, je.currency) IS NOT NULL
    AND upper(COALESCE(jel.original_currency, je.currency)) <> upper(b.base_currency)
    AND public.fx_is_monetary_account(a.account_type::text, a.detail_type::text)
  GROUP BY jel.account_id, upper(COALESCE(jel.original_currency, je.currency))
  HAVING ABS(SUM(COALESCE(jel.original_debit, jel.debit, 0) - COALESCE(jel.original_credit, jel.credit, 0))) > 0.01
$function$;

REVOKE ALL ON FUNCTION public.fx_open_monetary_positions(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fx_open_monetary_positions(uuid, date) FROM anon;
REVOKE ALL ON FUNCTION public.fx_open_monetary_positions(uuid, date) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fx_open_monetary_positions(uuid, date) TO service_role;

-- How much exchange difference a company has not yet recognised as of a date.
-- Read-only: it never posts and never decides anything.
CREATE OR REPLACE FUNCTION public.fx_unrecognised_exchange_difference(_business_id uuid, _as_of date)
RETURNS TABLE(currency text, foreign_balance numeric, carried_rate numeric, closing_rate numeric, unrecognised numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid;
  v_rate numeric;
  r record;
BEGIN
  SELECT organization_id INTO v_org FROM public.businesses WHERE id = _business_id;
  IF v_org IS NULL THEN
    RETURN;
  END IF;

  -- A company's currency exposure is its own business: only its organisation
  -- may read it.
  IF NOT (public.has_org_role(auth.uid(), v_org, 'owner'::public.app_role)
       OR public.has_org_role(auth.uid(), v_org, 'admin'::public.app_role)
       OR public.has_org_role(auth.uid(), v_org, 'super_admin'::public.app_role)) THEN
    RAISE EXCEPTION 'You are not allowed to read the currency exposure of this company'
      USING ERRCODE = '42501';
  END IF;

  FOR r IN
    SELECT p.currency AS cur,
           sum(p.foreign_balance) AS fb,
           sum(p.base_balance_old) AS bb
      FROM public.fx_open_monetary_positions(_business_id, _as_of) p
     GROUP BY p.currency
  LOOP
    CONTINUE WHEN abs(r.fb) < 0.01;
    v_rate := public.resolve_exchange_rate(v_org, _business_id, r.cur, _as_of);
    CONTINUE WHEN v_rate IS NULL OR v_rate <= 0;

    currency        := r.cur;
    foreign_balance := round(r.fb, 2);
    carried_rate    := round(r.bb / r.fb, 6);
    closing_rate    := v_rate;
    unrecognised    := round(r.fb * v_rate - r.bb, 2);

    IF abs(unrecognised) >= 0.01 THEN
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.fx_unrecognised_exchange_difference(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fx_unrecognised_exchange_difference(uuid, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.fx_unrecognised_exchange_difference(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fx_unrecognised_exchange_difference(uuid, date) TO service_role;

-- The sentence a refusal adds when the gap has a known cause at a member.
CREATE OR REPLACE FUNCTION public.consolidation_fx_remedy_note(_business_id uuid, _as_of date)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_name text;
  v_base text;
  v_note text := '';
  r record;
BEGIN
  SELECT name, upper(base_currency) INTO v_name, v_base FROM public.businesses WHERE id = _business_id;
  IF v_name IS NULL THEN
    RETURN NULL;
  END IF;

  FOR r IN SELECT * FROM public.fx_unrecognised_exchange_difference(_business_id, _as_of)
  LOOP
    v_note := v_note || format(
      ' %s still carries %s %s of monetary balances at %s while the closing rate on %s is %s, so %s %s of exchange difference is unrecognised in its own books; under IAS 21.45 that belongs in its profit or loss, so run period-end FX revaluation for %s as of %s before consolidating.',
      v_name, to_char(r.foreign_balance, 'FM999999999990.00'), r.currency,
      to_char(r.carried_rate, 'FM999999990.0000'), _as_of,
      to_char(r.closing_rate, 'FM999999990.0000'),
      to_char(r.unrecognised, 'FM999999999990.00'), v_base,
      v_name, _as_of);
  END LOOP;

  RETURN NULLIF(v_note, '');
EXCEPTION
  WHEN insufficient_privilege THEN
    RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.consolidation_fx_remedy_note(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consolidation_fx_remedy_note(uuid, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.consolidation_fx_remedy_note(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.consolidation_fx_remedy_note(uuid, date) TO service_role;

-- The posting engine now reads the shared definition rather than its own copy.
CREATE OR REPLACE FUNCTION public.revalue_fx_balances(_business_id uuid, _run_date date, _base_currency text DEFAULT NULL::text, _unrealized_gain_account uuid DEFAULT NULL::uuid, _unrealized_loss_account uuid DEFAULT NULL::uuid, _user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org_id uuid;
  _run_id uuid;
  _je_id uuid;
  _fx_book_id uuid;
  _row record;
  _new_rate numeric;
  _line_seq integer := 0;
  _total_gain numeric := 0;
  _total_loss numeric := 0;
  _net_delta numeric := 0;
  _base_new numeric;
  _delta numeric;
  _old_rate numeric;
  _gain_business uuid;
  _loss_business uuid;
  _lines jsonb := '[]'::jsonb;
  _period public.fiscal_periods;
  _prior public.fx_revaluation_runs;
  _reversal_je uuid;
  _uid uuid := COALESCE(auth.uid(), _user_id);
  _entity_base text;
  _resolved_gain uuid;
  _resolved_loss uuid;
BEGIN
  SELECT organization_id INTO _org_id FROM public.businesses WHERE id = _business_id;
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'Business % not found', _business_id USING ERRCODE = 'P0002';
  END IF;

  IF _uid IS NULL OR NOT public.has_finance_permission(_uid, 'finance.manage_periods', _business_id) THEN
    RAISE EXCEPTION 'You do not have permission to run FX revaluation for this business'
      USING ERRCODE = '42501';
  END IF;

  -- The reporting currency is a property of the legal entity, never of the caller.
  SELECT upper(base_currency) INTO _entity_base FROM public.businesses WHERE id = _business_id;
  IF _entity_base IS NULL THEN
    RAISE EXCEPTION 'Business % has no base currency configured', _business_id USING ERRCODE = '23514';
  END IF;
  IF _base_currency IS NOT NULL AND upper(_base_currency) <> _entity_base THEN
    RAISE EXCEPTION 'Base currency % does not match this company''s books (%)', upper(_base_currency), _entity_base
      USING ERRCODE = '23514';
  END IF;
  _base_currency := _entity_base;

  -- FX result accounts come from the central mapping, not from the caller.
  _resolved_gain := public.resolve_fx_unrealized_account(_business_id, 'gain');
  _resolved_loss := public.resolve_fx_unrealized_account(_business_id, 'loss');
  IF _unrealized_gain_account IS NOT NULL AND _unrealized_gain_account <> _resolved_gain THEN
    RAISE EXCEPTION 'Unrealized FX gain account is set in Default Accounts and cannot be overridden per run'
      USING ERRCODE = '23514';
  END IF;
  IF _unrealized_loss_account IS NOT NULL AND _unrealized_loss_account <> _resolved_loss THEN
    RAISE EXCEPTION 'Unrealized FX loss account is set in Default Accounts and cannot be overridden per run'
      USING ERRCODE = '23514';
  END IF;
  _unrealized_gain_account := _resolved_gain;
  _unrealized_loss_account := _resolved_loss;

  SELECT business_id INTO _gain_business FROM public.accounts WHERE id = _unrealized_gain_account;
  SELECT business_id INTO _loss_business FROM public.accounts WHERE id = _unrealized_loss_account;
  IF _gain_business IS DISTINCT FROM _business_id OR _loss_business IS DISTINCT FROM _business_id THEN
    RAISE EXCEPTION 'FX gain/loss accounts must belong to the selected business' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO _period
    FROM public.fiscal_periods
   WHERE business_id = _business_id
     AND _run_date BETWEEN start_date AND end_date
   ORDER BY start_date DESC LIMIT 1;

  -- D15: a run and a reversal must never interleave. Locks are transaction
  -- scoped and taken in a fixed order (company, then period/date scope) so
  -- concurrent callers cannot deadlock. Contention is refused, never queued.
  IF NOT pg_try_advisory_xact_lock(public._fx_reval_lock_key(_business_id, NULL)) THEN
    RAISE EXCEPTION 'A revaluation is already running for this company. Wait for it to finish before starting another.'
      USING ERRCODE = '55P03';
  END IF;
  IF NOT pg_try_advisory_xact_lock(
        public._fx_reval_lock_key(_business_id, COALESCE(_period.id::text, _run_date::text))) THEN
    RAISE EXCEPTION 'A revaluation is already running for this company and period. Wait for it to finish before starting another.'
      USING ERRCODE = '55P03';
  END IF;

  IF _period.id IS NOT NULL AND _period.status <> 'open' THEN
    RAISE EXCEPTION 'Fiscal period % is % — FX revaluation cannot post into it', _period.name, _period.status
      USING ERRCODE = '23514';
  END IF;

  IF _period.id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.fx_revaluation_runs
     WHERE business_id = _business_id AND fiscal_period_id = _period.id AND status = 'posted'
  ) THEN
    RAISE EXCEPTION 'A posted FX revaluation already exists for period %. Reverse it before running again.', _period.name
      USING ERRCODE = '23505';
  END IF;

  -- Period-less runs get the same guard, keyed on the run date.
  IF _period.id IS NULL AND EXISTS (
    SELECT 1 FROM public.fx_revaluation_runs
     WHERE business_id = _business_id AND fiscal_period_id IS NULL
       AND run_date = _run_date AND status = 'posted'
  ) THEN
    RAISE EXCEPTION 'A posted FX revaluation already exists for %. Reverse it before running again.', _run_date
      USING ERRCODE = '23505';
  END IF;

  SELECT public.default_journal_book_for_source(_business_id, 'fx_revaluation') INTO _fx_book_id;

  INSERT INTO public.fx_revaluation_runs (
    organization_id, business_id, run_date, base_currency, status, created_by,
    reversal_policy, journal_book_id, unrealized_gain_account_id, unrealized_loss_account_id,
    fiscal_period_id
  ) VALUES (
    _org_id, _business_id, _run_date, upper(_base_currency), 'draft', _uid,
    'next_period', _fx_book_id, _unrealized_gain_account, _unrealized_loss_account,
    _period.id
  ) RETURNING id INTO _run_id;

  SELECT * INTO _prior
    FROM public.fx_revaluation_runs
   WHERE business_id = _business_id
     AND status = 'posted'
     AND reversal_policy = 'next_period'
     AND run_date < _run_date
   ORDER BY run_date DESC LIMIT 1;

  IF _prior.id IS NOT NULL THEN
    _reversal_je := public.reverse_fx_revaluation_run(_prior.id, _run_date, _uid, _run_id);
  END IF;

  -- One shared definition of an open monetary position (R5).
  FOR _row IN
    SELECT p.account_id, p.currency, p.foreign_balance, p.base_balance_old
      FROM public.fx_open_monetary_positions(_business_id, _run_date) p
  LOOP
    _new_rate := public.resolve_exchange_rate(_org_id, _business_id, _row.currency, _run_date);

    IF _new_rate IS NULL OR _new_rate <= 0 THEN
      UPDATE public.fx_revaluation_runs
         SET status = 'failed',
             notes = 'No exchange rate on file for ' || _row.currency || ' → '
                     || upper(_base_currency) || ' as of ' || _run_date
       WHERE id = _run_id;
      RAISE EXCEPTION 'FX revaluation aborted: no exchange rate on file for % → % as of %',
        _row.currency, upper(_base_currency), _run_date
        USING ERRCODE = '23514';
    END IF;

    _base_new := _row.foreign_balance * _new_rate;
    _delta := round(_base_new - _row.base_balance_old, 2);
    _old_rate := CASE WHEN _row.foreign_balance = 0 THEN _new_rate ELSE _row.base_balance_old / _row.foreign_balance END;

    INSERT INTO public.fx_revaluation_lines (
      run_id, account_id, currency, foreign_balance,
      old_rate, new_rate, base_balance_old, base_balance_new, delta
    ) VALUES (
      _run_id, _row.account_id, _row.currency, _row.foreign_balance,
      _old_rate, _new_rate, _row.base_balance_old, _base_new, _delta
    );

    CONTINUE WHEN ABS(_delta) < 0.01;

    -- Unrealized FX belongs to the legal entity, never to a branch.
    IF _delta > 0 THEN
      _lines := _lines
        || jsonb_build_object('account_id', _row.account_id, 'business_id', _business_id, 'branch_id', NULL,
             'description', 'FX revaluation ' || _row.currency || ' @ ' || _new_rate, 'debit', _delta, 'credit', 0)
        || jsonb_build_object('account_id', _unrealized_gain_account, 'business_id', _business_id, 'branch_id', NULL,
             'description', 'Unrealized FX gain ' || _row.currency, 'debit', 0, 'credit', _delta);
      _line_seq := _line_seq + 2;
      _total_gain := _total_gain + _delta;
    ELSE
      _lines := _lines
        || jsonb_build_object('account_id', _unrealized_loss_account, 'business_id', _business_id, 'branch_id', NULL,
             'description', 'Unrealized FX loss ' || _row.currency, 'debit', ABS(_delta), 'credit', 0)
        || jsonb_build_object('account_id', _row.account_id, 'business_id', _business_id, 'branch_id', NULL,
             'description', 'FX revaluation ' || _row.currency || ' @ ' || _new_rate, 'debit', 0, 'credit', ABS(_delta));
      _line_seq := _line_seq + 2;
      _total_loss := _total_loss + ABS(_delta);
    END IF;
    _net_delta := _net_delta + _delta;
  END LOOP;

  IF _line_seq = 0 THEN
    UPDATE public.fx_revaluation_runs
       SET status = 'posted', total_unrealized_gain = 0, total_unrealized_loss = 0, journal_entry_id = NULL
     WHERE id = _run_id;
    RETURN jsonb_build_object('success', true, 'run_id', _run_id, 'lines', 0,
      'fiscal_period_id', _period.id, 'reversal_journal_entry_id', _reversal_je,
      'message', 'No FX deltas to post');
  END IF;

  -- ADR-0146: the posting engine is the only journal numberer.
  _je_id := public.post_journal_entry_atomic(
    _org_id, _business_id, NULL, _run_date,
    NULL,
    'Unrealized FX revaluation as of ' || _run_date,
    'fx_revaluation', _run_id, _uid, false, true,
    _lines, upper(_base_currency), 1, NULL, NULL
  );

  UPDATE public.journal_entries
     SET journal_book_id = COALESCE(journal_book_id, _fx_book_id)
   WHERE id = _je_id;

  UPDATE public.fx_revaluation_runs
     SET status = 'posted', total_unrealized_gain = _total_gain, total_unrealized_loss = _total_loss, journal_entry_id = _je_id
   WHERE id = _run_id;

  RETURN jsonb_build_object(
    'success', true,
    'run_id', _run_id,
    'journal_entry_id', _je_id,
    'fiscal_period_id', _period.id,
    'reversed_run_id', _prior.id,
    'reversal_journal_entry_id', _reversal_je,
    'lines', _line_seq,
    'unrealized_gain', _total_gain,
    'unrealized_loss', _total_loss,
    'net_delta', _net_delta,
    'reversal_policy', 'next_period'
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- The refusal now carries the remedy: it names the company whose books still
-- hold the unrecognised exchange difference.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consolidation_generate_eliminations(_group_id uuid, _date_from date, _date_to date)
RETURNS TABLE(elimination_class consolidation_elimination_class, pair_count integer, line_count integer, eliminated_debit numeric, eliminated_credit numeric, difference_amount numeric)
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_group public.consolidation_groups;
  v_class public.consolidation_elimination_class;
  v_rule public.consolidation_elimination_rules;
  v_types public.account_type[];
  v_pair record;
  v_unbalanced record;
  v_diff numeric;
  v_a uuid;
  v_b uuid;
  v_policy text;
  v_cur_a text;
  v_cur_b text;
  v_cross_currency boolean;
  v_tolerance numeric;
  v_within_tolerance boolean;
  v_remedy text;
  v_locked record;
  v_prev_legs integer := 0;
  v_prev_debit numeric := 0;
  v_prev_credit numeric := 0;
BEGIN
  IF _group_id IS NULL OR _date_from IS NULL OR _date_to IS NULL THEN
    RAISE EXCEPTION 'consolidation_generate_eliminations: group and date range are required';
  END IF;
  IF _date_to < _date_from THEN
    RAISE EXCEPTION 'consolidation_generate_eliminations: date_to must not precede date_from';
  END IF;

  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found or not visible to you' USING ERRCODE = '42501';
  END IF;

  IF NOT (public.has_org_role(auth.uid(), v_group.organization_id, 'owner'::public.app_role)
       OR public.has_org_role(auth.uid(), v_group.organization_id, 'admin'::public.app_role)
       OR public.has_org_role(auth.uid(), v_group.organization_id, 'super_admin'::public.app_role)) THEN
    RAISE EXCEPTION 'You are not allowed to generate consolidation eliminations' USING ERRCODE = '42501';
  END IF;

  SELECT m.business_name AS business_name, d::date AS locked_date
    INTO v_locked
    FROM public.resolve_consolidation_scope(_group_id, _date_to) m
    CROSS JOIN LATERAL unnest(
      ARRAY(SELECT generate_series(date_trunc('month', _date_from)::date, _date_to, interval '1 month')::date)
      || ARRAY[_date_to]
    ) AS d
   WHERE public.is_period_locked(v_group.organization_id, m.business_id, d)
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'The fiscal period covering % is closed for %, a member of this group. Eliminations for % to % cannot be generated or replaced while a member period is closed: reopen that period, or run the consolidation for a period the member''s books are still open for',
      v_locked.locked_date, v_locked.business_name, _date_from, _date_to
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::int, round(COALESCE(sum(e.debit), 0), 2), round(COALESCE(sum(e.credit), 0), 2)
    INTO v_prev_legs, v_prev_debit, v_prev_credit
    FROM public.consolidation_eliminations e
   WHERE e.group_id = _group_id AND e.period_start = _date_from AND e.period_end = _date_to;

  CREATE TEMP TABLE IF NOT EXISTS _ic_flows_run (
    declaring_business_id uuid, counterparty_business_id uuid, group_account_id uuid,
    group_account_code text, group_account_name text, account_type public.account_type,
    presentation_currency text, net_debit numeric, account_ids uuid[], entry_count integer
  ) ON COMMIT DROP;
  TRUNCATE _ic_flows_run;

  INSERT INTO _ic_flows_run
  SELECT f.declaring_business_id, f.counterparty_business_id, f.group_account_id,
         min(f.group_account_code), min(f.group_account_name), f.account_type,
         min(f.presentation_currency),
         round(sum(f.debit_presentation - f.credit_presentation), 2),
         array_agg(DISTINCT f.account_id), sum(f.entry_count)::int
    FROM public.consolidation_intercompany_flows(_group_id, _date_from, _date_to) f
   GROUP BY f.declaring_business_id, f.counterparty_business_id, f.group_account_id, f.account_type;

  DELETE FROM _ic_flows_run WHERE net_debit = 0;

  PERFORM set_config('app.consolidation_elimination_engine', 'on', true);

  FOREACH v_class IN ARRAY ARRAY['intercompany_balance', 'intercompany_trading']::public.consolidation_elimination_class[]
  LOOP
    SELECT * INTO v_rule
      FROM public.consolidation_elimination_rules r
     WHERE r.group_id = _group_id AND r.elimination_class = v_class;

    DELETE FROM public.consolidation_eliminations e
     WHERE e.group_id = _group_id
       AND e.period_start = _date_from
       AND e.period_end = _date_to
       AND e.elimination_class = v_class;

    IF v_rule.id IS NOT NULL AND NOT v_rule.is_active THEN
      CONTINUE;
    END IF;

    v_tolerance := COALESCE(v_rule.tolerance_amount, 0);

    v_types := CASE WHEN v_class = 'intercompany_balance'
                    THEN ARRAY['asset', 'liability']::public.account_type[]
                    ELSE ARRAY['income', 'expense']::public.account_type[] END;

    FOR v_pair IN
      SELECT least(f.declaring_business_id::text, f.counterparty_business_id::text)::uuid AS a,
             greatest(f.declaring_business_id::text, f.counterparty_business_id::text)::uuid AS b
        FROM _ic_flows_run f
       WHERE f.account_type = ANY (v_types)
       GROUP BY 1, 2
    LOOP
      v_a := v_pair.a;
      v_b := v_pair.b;

      INSERT INTO public.consolidation_eliminations (
        organization_id, group_id, period_start, period_end, elimination_class,
        declaring_business_id, counterparty_business_id, group_account_id,
        group_account_code, group_account_name, account_type, presentation_currency,
        debit, credit, is_difference, source_evidence, generated_by)
      SELECT v_group.organization_id, _group_id, _date_from, _date_to, v_class,
             f.declaring_business_id, f.counterparty_business_id, f.group_account_id,
             f.group_account_code, f.group_account_name, f.account_type, f.presentation_currency,
             GREATEST(-f.net_debit, 0), GREATEST(f.net_debit, 0), false,
             jsonb_build_object(
               'source_account_ids', to_jsonb(f.account_ids),
               'entry_count', f.entry_count,
               'net_debit_before_elimination', f.net_debit),
             auth.uid()
        FROM _ic_flows_run f
       WHERE f.account_type = ANY (v_types)
         AND ((f.declaring_business_id = v_a AND f.counterparty_business_id = v_b)
           OR (f.declaring_business_id = v_b AND f.counterparty_business_id = v_a));

      SELECT round(COALESCE(sum(e.credit - e.debit), 0), 2) INTO v_diff
        FROM public.consolidation_eliminations e
       WHERE e.group_id = _group_id AND e.period_start = _date_from AND e.period_end = _date_to
         AND e.elimination_class = v_class AND NOT e.is_difference
         AND ((e.declaring_business_id = v_a AND e.counterparty_business_id = v_b)
           OR (e.declaring_business_id = v_b AND e.counterparty_business_id = v_a));

      IF v_diff <> 0 THEN
        v_policy := COALESCE(v_rule.difference_policy::text, 'refuse');
        v_within_tolerance := abs(v_diff) <= v_tolerance;

        SELECT b.base_currency INTO v_cur_a FROM public.businesses b WHERE b.id = v_a;
        SELECT b.base_currency INTO v_cur_b FROM public.businesses b WHERE b.id = v_b;
        v_cross_currency := (v_cur_a IS DISTINCT FROM v_cur_b)
                         OR (v_cur_a IS DISTINCT FROM v_group.presentation_currency)
                         OR (v_cur_b IS DISTINCT FROM v_group.presentation_currency);

        -- R5: a difference between two companies on different currencies is
        -- usually not a consolidation problem at all — it is an exchange
        -- difference one of them has not recognised yet. Say so, by name.
        v_remedy := COALESCE(public.consolidation_fx_remedy_note(v_a, _date_to), '')
                 || COALESCE(public.consolidation_fx_remedy_note(v_b, _date_to), '');
        v_remedy := NULLIF(v_remedy, '');

        -- The group's chosen handling governs every difference, however small.
        -- A tolerance says a difference of that size needs no separate
        -- explanation; it never says the difference may be handled by a rule
        -- the group did not choose.
        IF v_policy = 'refuse' THEN
          RAISE EXCEPTION 'The two sides of the % position between % and % differ by % %, and this group is set to refuse differences of this class%.%',
            v_class,
            (SELECT name FROM public.businesses WHERE id = v_a),
            (SELECT name FROM public.businesses WHERE id = v_b),
            abs(v_diff), v_group.presentation_currency,
            CASE WHEN v_within_tolerance
                 THEN format(' (the gap is inside the configured tolerance of %s %s, but a refusing group refuses regardless)', v_tolerance, v_group.presentation_currency)
                 ELSE format(' (the configured tolerance is %s %s)', v_tolerance, v_group.presentation_currency) END,
            COALESCE(v_remedy, ' Correct the position in the members'' books, or change this class''s difference handling to say where the gap belongs and why')
            USING ERRCODE = '22023';
        END IF;

        IF v_policy = 'post_to_cta' THEN
          IF v_class = 'intercompany_trading' THEN
            RAISE EXCEPTION 'The intragroup trading position between % and % differs by % %. A trading mismatch is unrecorded revenue, unrealised profit or a cut-off difference; it cannot be carried to the translation reserve.%',
              (SELECT name FROM public.businesses WHERE id = v_a),
              (SELECT name FROM public.businesses WHERE id = v_b),
              abs(v_diff), v_group.presentation_currency,
              COALESCE(v_remedy, '')
              USING ERRCODE = '22023';
          END IF;

          IF NOT v_cross_currency THEN
            RAISE EXCEPTION 'The two sides of the % position between % and % differ by % %, and both companies already report in %; that gap is a real disagreement, not a translation difference, so it cannot be carried to the translation reserve',
              v_class,
              (SELECT name FROM public.businesses WHERE id = v_a),
              (SELECT name FROM public.businesses WHERE id = v_b),
              abs(v_diff), v_group.presentation_currency, v_group.presentation_currency
              USING ERRCODE = '22023';
          END IF;

          -- A gap the members themselves have not yet recognised is theirs to
          -- recognise: the group reserve is not a place to put it.
          IF v_remedy IS NOT NULL THEN
            RAISE EXCEPTION 'The % position between % and % differs by % %, but that gap is an exchange difference the members have not recognised yet, so it cannot be carried to the group translation reserve.%',
              v_class,
              (SELECT name FROM public.businesses WHERE id = v_a),
              (SELECT name FROM public.businesses WHERE id = v_b),
              abs(v_diff), v_group.presentation_currency, v_remedy
              USING ERRCODE = '22023';
          END IF;

          IF v_group.cta_account_id IS NULL THEN
            RAISE EXCEPTION 'The % position between % and % differs by % % on translation, but this group has no translation reserve account configured to carry it',
              v_class,
              (SELECT name FROM public.businesses WHERE id = v_a),
              (SELECT name FROM public.businesses WHERE id = v_b),
              abs(v_diff), v_group.presentation_currency
              USING ERRCODE = '22023';
          END IF;

          INSERT INTO public.consolidation_eliminations (
            organization_id, group_id, period_start, period_end, elimination_class,
            declaring_business_id, counterparty_business_id, group_account_id,
            group_account_code, group_account_name, account_type, presentation_currency,
            debit, credit, is_difference, source_evidence, generated_by)
          SELECT v_group.organization_id, _group_id, _date_from, _date_to, v_class,
                 v_a, v_b, a.id, a.code, a.name, 'equity'::public.account_type,
                 v_group.presentation_currency,
                 GREATEST(v_diff, 0), GREATEST(-v_diff, 0), true,
                 jsonb_build_object('reason', 'translation_residual_posted_to_cta',
                                    'difference', v_diff,
                                    'tolerance', v_tolerance,
                                    'within_tolerance', v_within_tolerance,
                                    'declaring_currency', v_cur_a,
                                    'counterparty_currency', v_cur_b,
                                    'presentation_currency', v_group.presentation_currency),
                 auth.uid()
            FROM public.accounts a
           WHERE a.id = v_group.cta_account_id;
        ELSE
          IF v_rule.difference_group_account_id IS NULL THEN
            RAISE EXCEPTION 'The two sides of the % position between % and % differ by % %, but no difference account is configured for this group.%',
              v_class,
              (SELECT name FROM public.businesses WHERE id = v_a),
              (SELECT name FROM public.businesses WHERE id = v_b),
              abs(v_diff), v_group.presentation_currency,
              COALESCE(v_remedy, '')
              USING ERRCODE = '22023';
          END IF;

          INSERT INTO public.consolidation_eliminations (
            organization_id, group_id, period_start, period_end, elimination_class,
            declaring_business_id, counterparty_business_id, group_account_id,
            group_account_code, group_account_name, account_type, presentation_currency,
            debit, credit, is_difference, source_evidence, generated_by)
          SELECT v_group.organization_id, _group_id, _date_from, _date_to, v_class,
                 v_a, v_b, a.id, a.code, a.name, a.account_type, v_group.presentation_currency,
                 GREATEST(v_diff, 0), GREATEST(-v_diff, 0), true,
                 jsonb_build_object('reason', 'reciprocal_positions_disagree',
                                    'difference', v_diff,
                                    'tolerance', v_tolerance,
                                    'within_tolerance', v_within_tolerance,
                                    'unrecognised_fx_at_members', v_remedy IS NOT NULL),
                 auth.uid()
            FROM public.consolidation_group_accounts a
           WHERE a.id = v_rule.difference_group_account_id;
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  FOR v_unbalanced IN
    SELECT * FROM public.consolidation_eliminations_balance(_group_id, _date_from, _date_to) b
     WHERE NOT b.is_balanced
  LOOP
    RAISE EXCEPTION 'The % eliminations generated for % to % do not balance: % debit against % credit, a difference of % %. The run has been rejected rather than unbalance the consolidated statements',
      v_unbalanced.elimination_class, _date_from, _date_to,
      v_unbalanced.total_debit, v_unbalanced.total_credit,
      v_unbalanced.out_of_balance, v_group.presentation_currency
      USING ERRCODE = '22023';
  END LOOP;

  INSERT INTO public.consolidation_elimination_events (
    organization_id, group_id, period_start, period_end, action, actor_id,
    presentation_currency, scope_snapshot, rule_snapshot,
    leg_count, difference_leg_count, total_debit, total_credit,
    replaced_leg_count, replaced_total_debit, replaced_total_credit)
  SELECT
    v_group.organization_id, _group_id, _date_from, _date_to,
    CASE WHEN v_prev_legs > 0 THEN 'regenerate' ELSE 'generate' END,
    auth.uid(),
    v_group.presentation_currency,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'business_id', m.business_id,
                'business_name', m.business_name,
                'base_currency', m.base_currency,
                'is_parent', m.is_parent,
                'method', m.method,
                'ownership_percentage', m.ownership_percentage))
                FROM public.resolve_consolidation_scope(_group_id, _date_to) m), '[]'::jsonb),
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'elimination_class', r.elimination_class,
                'is_active', r.is_active,
                'tolerance_amount', r.tolerance_amount,
                'tolerance_reason', r.tolerance_reason,
                'difference_policy', r.difference_policy,
                'difference_group_account_id', r.difference_group_account_id))
                FROM public.consolidation_elimination_rules r WHERE r.group_id = _group_id), '[]'::jsonb),
    (SELECT count(*)::int FROM public.consolidation_eliminations e
      WHERE e.group_id = _group_id AND e.period_start = _date_from AND e.period_end = _date_to),
    (SELECT count(*)::int FROM public.consolidation_eliminations e
      WHERE e.group_id = _group_id AND e.period_start = _date_from AND e.period_end = _date_to AND e.is_difference),
    (SELECT round(COALESCE(sum(e.debit), 0), 2) FROM public.consolidation_eliminations e
      WHERE e.group_id = _group_id AND e.period_start = _date_from AND e.period_end = _date_to),
    (SELECT round(COALESCE(sum(e.credit), 0), 2) FROM public.consolidation_eliminations e
      WHERE e.group_id = _group_id AND e.period_start = _date_from AND e.period_end = _date_to),
    v_prev_legs, v_prev_debit, v_prev_credit;

  PERFORM set_config('app.consolidation_elimination_engine', 'off', true);

  RETURN QUERY
  SELECT e.elimination_class,
         count(DISTINCT (e.declaring_business_id, e.counterparty_business_id))::int,
         count(*)::int,
         round(COALESCE(sum(e.debit), 0), 2),
         round(COALESCE(sum(e.credit), 0), 2),
         round(COALESCE(sum(CASE WHEN e.is_difference THEN e.credit - e.debit ELSE 0 END), 0), 2)
    FROM public.consolidation_eliminations e
   WHERE e.group_id = _group_id AND e.period_start = _date_from AND e.period_end = _date_to
   GROUP BY e.elimination_class;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.consolidation_generate_eliminations(uuid, date, date) FROM anon;