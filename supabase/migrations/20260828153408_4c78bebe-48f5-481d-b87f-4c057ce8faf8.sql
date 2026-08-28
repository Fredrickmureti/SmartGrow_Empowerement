-- ---------------------------------------------------------------------------
-- R4: bound the tolerance, attribute the change, and make difference_policy
-- authoritative both inside and outside tolerance.
-- ---------------------------------------------------------------------------

ALTER TABLE public.consolidation_elimination_rules
  ADD COLUMN IF NOT EXISTS tolerance_reason text,
  ADD COLUMN IF NOT EXISTS tolerance_set_by uuid,
  ADD COLUMN IF NOT EXISTS tolerance_set_at timestamptz;

COMMENT ON COLUMN public.consolidation_elimination_rules.tolerance_reason IS
  'Why this group accepts a difference of this size without it being treated as a disagreement. Required for any tolerance above zero.';

-- A tolerance exists to absorb rounding, not to absorb a real gap. Anything
-- larger than a rounding bound is a fitted plug and must be refused at
-- configuration time rather than discovered in the statements.
CREATE OR REPLACE FUNCTION public.consolidation_tolerance_cap()
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 100.00::numeric $$;

COMMENT ON FUNCTION public.consolidation_tolerance_cap() IS
  'Upper bound, in the group presentation currency, for an elimination tolerance. Rounding scale only.';

-- Existing fitted tolerances are brought inside the bound before the guard
-- starts enforcing it, with the reason recorded rather than assumed.
UPDATE public.consolidation_elimination_rules
   SET tolerance_amount = LEAST(tolerance_amount, public.consolidation_tolerance_cap()),
       tolerance_reason = COALESCE(
         tolerance_reason,
         'Reset from a fitted value to the rounding bound: the original amount had been sized to the observed residual rather than to rounding.'),
       tolerance_set_at = COALESCE(tolerance_set_at, now())
 WHERE tolerance_amount > public.consolidation_tolerance_cap();

CREATE OR REPLACE FUNCTION public._consolidation_elimination_rule_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_group public.consolidation_groups;
  v_changed boolean;
BEGIN
  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = NEW.group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_group.organization_id THEN
    RAISE EXCEPTION 'Elimination rule organisation must match its consolidation group';
  END IF;

  IF NEW.difference_policy = 'post_difference' AND NEW.difference_group_account_id IS NULL THEN
    RAISE EXCEPTION 'A rule that posts the difference must name the group account that carries it';
  END IF;

  IF NEW.difference_group_account_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.consolidation_group_accounts a
        WHERE a.id = NEW.difference_group_account_id
          AND a.group_id = NEW.group_id
          AND a.is_active
     ) THEN
    RAISE EXCEPTION 'The difference account must be an active group account of the same consolidation group';
  END IF;

  -- An intragroup trading mismatch is unrecorded revenue, unrealised profit or
  -- a cut-off difference. It is never what retranslation leaves behind, so the
  -- translation reserve may not be named as its destination.
  IF NEW.elimination_class = 'intercompany_trading' AND NEW.difference_policy = 'post_to_cta' THEN
    RAISE EXCEPTION 'A trading difference cannot be carried to the translation reserve: a mismatch between intragroup sales and purchases is unrecorded, unrealised or a cut-off difference, not a currency translation effect. Refuse it, or name a difference account that says what it is'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.tolerance_amount < 0 THEN
    RAISE EXCEPTION 'An elimination tolerance cannot be negative';
  END IF;

  IF NEW.tolerance_amount > public.consolidation_tolerance_cap() THEN
    RAISE EXCEPTION 'A tolerance of % % is larger than the rounding bound of % %. A tolerance absorbs rounding; a gap of this size is a real difference and has to be explained by the books, not widened away',
      NEW.tolerance_amount, v_group.presentation_currency,
      public.consolidation_tolerance_cap(), v_group.presentation_currency
      USING ERRCODE = '22023';
  END IF;

  IF NEW.tolerance_amount > 0
     AND (NEW.tolerance_reason IS NULL OR length(btrim(NEW.tolerance_reason)) < 20) THEN
    RAISE EXCEPTION 'A tolerance above zero has to say why this group accepts a difference of that size without treating it as a disagreement'
      USING ERRCODE = '22023';
  END IF;

  v_changed := TG_OP = 'INSERT'
            OR NEW.tolerance_amount IS DISTINCT FROM OLD.tolerance_amount
            OR NEW.difference_policy IS DISTINCT FROM OLD.difference_policy
            OR NEW.difference_group_account_id IS DISTINCT FROM OLD.difference_group_account_id;

  IF v_changed THEN
    NEW.tolerance_set_by := COALESCE(auth.uid(), NEW.tolerance_set_by);
    NEW.tolerance_set_at := now();

    INSERT INTO public.consolidation_group_change_log (
      organization_id, group_id, entity, action, actor_id, before_state, after_state)
    VALUES (
      v_group.organization_id, NEW.group_id, 'elimination_rule', lower(TG_OP), auth.uid(),
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE jsonb_build_object(
        'elimination_class', OLD.elimination_class,
        'tolerance_amount', OLD.tolerance_amount,
        'difference_policy', OLD.difference_policy,
        'difference_group_account_id', OLD.difference_group_account_id,
        'tolerance_reason', OLD.tolerance_reason) END,
      jsonb_build_object(
        'elimination_class', NEW.elimination_class,
        'tolerance_amount', NEW.tolerance_amount,
        'difference_policy', NEW.difference_policy,
        'difference_group_account_id', NEW.difference_group_account_id,
        'tolerance_reason', NEW.tolerance_reason));
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Engine: difference_policy decides inside tolerance too.
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

        -- The group's chosen handling governs every difference, however small.
        -- A tolerance says a difference of that size needs no separate
        -- explanation; it never says the difference may be handled by a rule
        -- the group did not choose.
        IF v_policy = 'refuse' THEN
          RAISE EXCEPTION 'The two sides of the % position between % and % differ by % %, and this group is set to refuse differences of this class%. Correct the position in the members'' books, or change this class''s difference handling to say where the gap belongs and why',
            v_class,
            (SELECT name FROM public.businesses WHERE id = v_a),
            (SELECT name FROM public.businesses WHERE id = v_b),
            abs(v_diff), v_group.presentation_currency,
            CASE WHEN v_within_tolerance
                 THEN format(' (the gap is inside the configured tolerance of %s %s, but a refusing group refuses regardless)', v_tolerance, v_group.presentation_currency)
                 ELSE format(' (the configured tolerance is %s %s)', v_tolerance, v_group.presentation_currency) END
            USING ERRCODE = '22023';
        END IF;

        IF v_policy = 'post_to_cta' THEN
          IF v_class = 'intercompany_trading' THEN
            RAISE EXCEPTION 'The intragroup trading position between % and % differs by % %. A trading mismatch is unrecorded revenue, unrealised profit or a cut-off difference; it cannot be carried to the translation reserve',
              (SELECT name FROM public.businesses WHERE id = v_a),
              (SELECT name FROM public.businesses WHERE id = v_b),
              abs(v_diff), v_group.presentation_currency
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
            RAISE EXCEPTION 'The two sides of the % position between % and % differ by % %, but no difference account is configured for this group',
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
                 v_a, v_b, a.id, a.code, a.name, a.account_type, v_group.presentation_currency,
                 GREATEST(v_diff, 0), GREATEST(-v_diff, 0), true,
                 jsonb_build_object('reason', 'reciprocal_positions_disagree',
                                    'difference', v_diff,
                                    'tolerance', v_tolerance,
                                    'within_tolerance', v_within_tolerance),
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
                'ownership_percent', m.ownership_percent,
                'requires_translation', m.requires_translation)
              ORDER BY m.business_name)
        FROM public.resolve_consolidation_scope(_group_id, _date_to) m), '[]'::jsonb),
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'elimination_class', r.elimination_class,
                'is_active', r.is_active,
                'tolerance_amount', r.tolerance_amount,
                'tolerance_reason', r.tolerance_reason,
                'difference_policy', r.difference_policy,
                'difference_group_account_id', r.difference_group_account_id,
                'is_system_default', r.is_system_default)
              ORDER BY r.elimination_class)
        FROM public.consolidation_elimination_rules r
       WHERE r.group_id = _group_id), '[]'::jsonb),
    (SELECT count(*)::int FROM public.consolidation_eliminations e
      WHERE e.group_id = _group_id AND e.period_start = _date_from AND e.period_end = _date_to),
    (SELECT count(*)::int FROM public.consolidation_eliminations e
      WHERE e.group_id = _group_id AND e.period_start = _date_from AND e.period_end = _date_to
        AND e.is_difference),
    (SELECT round(COALESCE(sum(e.debit), 0), 2) FROM public.consolidation_eliminations e
      WHERE e.group_id = _group_id AND e.period_start = _date_from AND e.period_end = _date_to),
    (SELECT round(COALESCE(sum(e.credit), 0), 2) FROM public.consolidation_eliminations e
      WHERE e.group_id = _group_id AND e.period_start = _date_from AND e.period_end = _date_to),
    v_prev_legs, v_prev_debit, v_prev_credit;

  PERFORM set_config('app.consolidation_elimination_engine', 'off', true);

  RETURN QUERY
  SELECT e.elimination_class,
         count(DISTINCT least(e.declaring_business_id::text, e.counterparty_business_id::text)
               || greatest(e.declaring_business_id::text, e.counterparty_business_id::text))::int,
         count(*)::int,
         round(sum(e.debit), 2),
         round(sum(e.credit), 2),
         round(COALESCE(sum(e.debit - e.credit) FILTER (WHERE e.is_difference), 0), 2)
    FROM public.consolidation_eliminations e
   WHERE e.group_id = _group_id AND e.period_start = _date_from AND e.period_end = _date_to
   GROUP BY e.elimination_class
   ORDER BY 1;
END;
$function$;