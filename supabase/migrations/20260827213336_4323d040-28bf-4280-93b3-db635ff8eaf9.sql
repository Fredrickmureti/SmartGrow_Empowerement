-- Step 7.2 — Balanced eliminations invariant.
--
-- An elimination set is a journal entry: it must balance. The previous engine
-- accepted a within-tolerance gap and left it *unrecorded*, which injected the
-- gap straight into the consolidated balance sheet (the live 2026-08 set was
-- out of balance by 40,000 KES). A tolerance may only decide *where* the plug
-- goes and whether a human has to approve it -- never whether it exists.

CREATE OR REPLACE FUNCTION public.consolidation_eliminations_balance(
  _group_id uuid, _date_from date, _date_to date)
RETURNS TABLE(
  elimination_class public.consolidation_elimination_class,
  total_debit numeric,
  total_credit numeric,
  out_of_balance numeric,
  is_balanced boolean)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
  SELECT e.elimination_class,
         round(sum(e.debit), 2),
         round(sum(e.credit), 2),
         round(sum(e.debit - e.credit), 2),
         round(sum(e.debit - e.credit), 2) = 0
    FROM public.consolidation_eliminations e
   WHERE e.group_id = _group_id
     AND e.period_start = _date_from
     AND e.period_end = _date_to
   GROUP BY e.elimination_class
   ORDER BY 1
$function$;

REVOKE ALL ON FUNCTION public.consolidation_eliminations_balance(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consolidation_eliminations_balance(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.consolidation_eliminations_balance(uuid, date, date) TO service_role;

COMMENT ON FUNCTION public.consolidation_eliminations_balance(uuid, date, date) IS
'Debit/credit totals of a generated elimination set per class. is_balanced false means the set would unbalance the consolidated statements; the generator refuses to leave such a set behind.';

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

    -- Each unordered pair of companies is settled once, from both sides.
    FOR v_pair IN
      SELECT least(f.declaring_business_id::text, f.counterparty_business_id::text)::uuid AS a,
             greatest(f.declaring_business_id::text, f.counterparty_business_id::text)::uuid AS b
        FROM _ic_flows_run f
       WHERE f.account_type = ANY (v_types)
       GROUP BY 1, 2
    LOOP
      v_a := v_pair.a;
      v_b := v_pair.b;

      -- Reverse every leg in full: an elimination that removes only one side
      -- would leave the consolidated balance sheet out of balance.
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

        -- A translation residual can only arise when at least one side of the
        -- pair keeps its books in a currency other than the group's. When both
        -- report in the presentation currency, a gap is a genuine disagreement
        -- and no reserve may absorb it.
        SELECT b.base_currency INTO v_cur_a FROM public.businesses b WHERE b.id = v_a;
        SELECT b.base_currency INTO v_cur_b FROM public.businesses b WHERE b.id = v_b;
        v_cross_currency := (v_cur_a IS DISTINCT FROM v_cur_b)
                         OR (v_cur_a IS DISTINCT FROM v_group.presentation_currency)
                         OR (v_cur_b IS DISTINCT FROM v_group.presentation_currency);

        IF v_within_tolerance THEN
          -- A tolerance decides that nobody has to *approve* the plug, not that
          -- the plug may be skipped. Cross-currency rounding is a translation
          -- effect and belongs in the reserve; anything else goes to the group's
          -- named difference account.
          IF v_cross_currency AND v_group.cta_account_id IS NOT NULL THEN
            INSERT INTO public.consolidation_eliminations (
              organization_id, group_id, period_start, period_end, elimination_class,
              declaring_business_id, counterparty_business_id, group_account_id,
              group_account_code, group_account_name, account_type, presentation_currency,
              debit, credit, is_difference, source_evidence, generated_by)
            SELECT v_group.organization_id, _group_id, _date_from, _date_to, v_class,
                   v_a, v_b, a.id, a.code, a.name, 'equity'::public.account_type,
                   v_group.presentation_currency,
                   GREATEST(v_diff, 0), GREATEST(-v_diff, 0), true,
                   jsonb_build_object('reason', 'rounding_within_tolerance_posted_to_cta',
                                      'difference', v_diff,
                                      'tolerance', v_tolerance,
                                      'declaring_currency', v_cur_a,
                                      'counterparty_currency', v_cur_b,
                                      'presentation_currency', v_group.presentation_currency),
                   auth.uid()
              FROM public.accounts a
             WHERE a.id = v_group.cta_account_id;
          ELSIF v_rule.difference_group_account_id IS NOT NULL THEN
            INSERT INTO public.consolidation_eliminations (
              organization_id, group_id, period_start, period_end, elimination_class,
              declaring_business_id, counterparty_business_id, group_account_id,
              group_account_code, group_account_name, account_type, presentation_currency,
              debit, credit, is_difference, source_evidence, generated_by)
            SELECT v_group.organization_id, _group_id, _date_from, _date_to, v_class,
                   v_a, v_b, a.id, a.code, a.name, a.account_type, v_group.presentation_currency,
                   GREATEST(v_diff, 0), GREATEST(-v_diff, 0), true,
                   jsonb_build_object('reason', 'rounding_within_tolerance_posted_to_difference',
                                      'difference', v_diff,
                                      'tolerance', v_tolerance),
                   auth.uid()
              FROM public.consolidation_group_accounts a
             WHERE a.id = v_rule.difference_group_account_id;
          ELSE
            RAISE EXCEPTION 'The two sides of the % position between % and % differ by % %, which is inside this class''s tolerance of % %, but the group has nowhere to carry it: an elimination that leaves the gap unrecorded would unbalance the consolidated statements. Name a translation reserve account for the group, or a difference account for this class',
              v_class,
              (SELECT name FROM public.businesses WHERE id = v_a),
              (SELECT name FROM public.businesses WHERE id = v_b),
              abs(v_diff), v_group.presentation_currency,
              v_tolerance, v_group.presentation_currency
              USING ERRCODE = '22023';
          END IF;
        ELSE
          IF v_policy = 'post_to_cta' AND NOT v_cross_currency THEN
            RAISE EXCEPTION 'The two sides of the % position between % and % differ by % %, and both companies already report in %; that gap is a real disagreement, not a translation difference, so it cannot be carried to the translation reserve',
              v_class,
              (SELECT name FROM public.businesses WHERE id = v_a),
              (SELECT name FROM public.businesses WHERE id = v_b),
              abs(v_diff), v_group.presentation_currency, v_group.presentation_currency
              USING ERRCODE = '22023';
          END IF;

          IF v_policy = 'refuse' THEN
            IF v_cross_currency THEN
              RAISE EXCEPTION 'The two sides of the % position between % and % differ by % % (% reports in %, % reports in %, the group reports in %). A gap of this kind is what currency retranslation leaves behind, not a figure the companies disagree on: set this class''s difference handling to carry the difference to the translation reserve, or raise the tolerance above % % if you consider it immaterial',
                v_class,
                (SELECT name FROM public.businesses WHERE id = v_a),
                (SELECT name FROM public.businesses WHERE id = v_b),
                abs(v_diff), v_group.presentation_currency,
                (SELECT name FROM public.businesses WHERE id = v_a), v_cur_a,
                (SELECT name FROM public.businesses WHERE id = v_b), v_cur_b,
                v_group.presentation_currency,
                abs(v_diff), v_group.presentation_currency
                USING ERRCODE = '22023';
            ELSE
              RAISE EXCEPTION 'The two sides of the % position between % and % differ by % %; raise the tolerance or name a difference account instead of consolidating a figure nobody agreed',
                v_class,
                (SELECT name FROM public.businesses WHERE id = v_a),
                (SELECT name FROM public.businesses WHERE id = v_b),
                abs(v_diff), v_group.presentation_currency
                USING ERRCODE = '22023';
            END IF;
          END IF;

          IF v_policy = 'post_to_cta' THEN
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
                                      'tolerance', v_tolerance),
                   auth.uid()
              FROM public.consolidation_group_accounts a
             WHERE a.id = v_rule.difference_group_account_id;
          END IF;
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  -- Hard invariant: a generated set that does not balance may never survive the
  -- transaction, whatever policy produced it.
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

CREATE OR REPLACE FUNCTION public.consolidation_diagnose_eliminations(_group_id uuid, _date_from date, _date_to date)
 RETURNS TABLE(finding_kind text, elimination_class consolidation_elimination_class, business_a_id uuid, business_a_name text, business_a_currency text, business_b_id uuid, business_b_name text, business_b_currency text, presentation_currency text, difference_signed numeric, difference_amount numeric, effective_tolerance numeric, effective_policy text, rule_exists boolean, is_cross_currency boolean, cause text, would_refuse boolean, suggested_tolerance numeric, remedies text[], message text)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group public.consolidation_groups;
  v_class public.consolidation_elimination_class;
  v_rule public.consolidation_elimination_rules;
  v_types public.account_type[];
  v_pair record;
  v_diff numeric;
  v_tol numeric;
  v_policy text;
  v_cur_a text;
  v_cur_b text;
  v_name_a text;
  v_name_b text;
  v_cross boolean;
  v_cause text;
  v_refuse boolean;
  v_remedies text[];
  v_message text;
  v_has_cta boolean;
  v_has_diff_account boolean;
BEGIN
  IF _group_id IS NULL OR _date_from IS NULL OR _date_to IS NULL THEN
    RAISE EXCEPTION 'consolidation_diagnose_eliminations: group and date range are required';
  END IF;
  IF _date_to < _date_from THEN
    RAISE EXCEPTION 'consolidation_diagnose_eliminations: date_to must not precede date_from';
  END IF;

  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found or not visible to you' USING ERRCODE = '42501';
  END IF;

  IF NOT (public.has_org_role(auth.uid(), v_group.organization_id, 'owner'::public.app_role)
       OR public.has_org_role(auth.uid(), v_group.organization_id, 'admin'::public.app_role)
       OR public.has_org_role(auth.uid(), v_group.organization_id, 'super_admin'::public.app_role)) THEN
    RAISE EXCEPTION 'You are not allowed to diagnose consolidation eliminations' USING ERRCODE = '42501';
  END IF;

  v_has_cta := v_group.cta_account_id IS NOT NULL;

  CREATE TEMP TABLE IF NOT EXISTS _ic_flows_diag (
    declaring_business_id uuid, counterparty_business_id uuid, group_account_id uuid,
    account_type public.account_type, net_debit numeric
  ) ON COMMIT DROP;
  TRUNCATE _ic_flows_diag;

  BEGIN
    INSERT INTO _ic_flows_diag
    SELECT f.declaring_business_id, f.counterparty_business_id, f.group_account_id,
           f.account_type,
           round(sum(f.debit_presentation - f.credit_presentation), 2)
      FROM public.consolidation_intercompany_flows(_group_id, _date_from, _date_to) f
     GROUP BY f.declaring_business_id, f.counterparty_business_id, f.group_account_id, f.account_type;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY
    SELECT CASE WHEN SQLSTATE = '42501' THEN 'scope_not_reportable' ELSE 'flows_refused' END,
           NULL::public.consolidation_elimination_class,
           NULL::uuid, NULL::text, NULL::text,
           NULL::uuid, NULL::text, NULL::text,
           v_group.presentation_currency,
           NULL::numeric, NULL::numeric, NULL::numeric, NULL::text, NULL::boolean, NULL::boolean,
           CASE WHEN SQLSTATE = '42501' THEN 'scope_not_reportable' ELSE 'intercompany_flows_refused' END,
           true,
           NULL::numeric,
           CASE WHEN SQLSTATE = '42501'
                THEN ARRAY['review_group_membership']
                ELSE ARRAY['review_intercompany'] END,
           SQLERRM;
    RETURN;
  END;

  DELETE FROM _ic_flows_diag WHERE net_debit = 0;

  FOREACH v_class IN ARRAY ARRAY['intercompany_balance', 'intercompany_trading']::public.consolidation_elimination_class[]
  LOOP
    SELECT * INTO v_rule
      FROM public.consolidation_elimination_rules r
     WHERE r.group_id = _group_id AND r.elimination_class = v_class;

    IF v_rule.id IS NOT NULL AND NOT v_rule.is_active THEN
      CONTINUE;
    END IF;

    v_tol := COALESCE(v_rule.tolerance_amount, 0);
    v_policy := COALESCE(v_rule.difference_policy::text, 'refuse');
    v_has_diff_account := v_rule.difference_group_account_id IS NOT NULL;

    v_types := CASE WHEN v_class = 'intercompany_balance'
                    THEN ARRAY['asset', 'liability']::public.account_type[]
                    ELSE ARRAY['income', 'expense']::public.account_type[] END;

    FOR v_pair IN
      SELECT least(f.declaring_business_id::text, f.counterparty_business_id::text)::uuid AS a,
             greatest(f.declaring_business_id::text, f.counterparty_business_id::text)::uuid AS b,
             round(sum(f.net_debit), 2) AS diff
        FROM _ic_flows_diag f
       WHERE f.account_type = ANY (v_types)
       GROUP BY 1, 2
    LOOP
      v_diff := v_pair.diff;
      CONTINUE WHEN v_diff = 0;

      SELECT b.base_currency, b.name INTO v_cur_a, v_name_a FROM public.businesses b WHERE b.id = v_pair.a;
      SELECT b.base_currency, b.name INTO v_cur_b, v_name_b FROM public.businesses b WHERE b.id = v_pair.b;

      v_cross := (v_cur_a IS DISTINCT FROM v_cur_b)
              OR (v_cur_a IS DISTINCT FROM v_group.presentation_currency)
              OR (v_cur_b IS DISTINCT FROM v_group.presentation_currency);

      IF abs(v_diff) <= v_tol THEN
        -- Within tolerance the plug is posted without asking anyone, but it is
        -- still posted: the engine needs a destination for it.
        IF v_cross AND v_has_cta THEN
          v_cause := 'rounding_posted_to_cta';
          v_refuse := false;
          v_remedies := ARRAY[]::text[];
          v_message := format(
            'The two sides of the %s position between %s and %s differ by %s %s, within the tolerance of %s %s in force, so the run carries it to the group''s translation reserve automatically.',
            v_class, v_name_a, v_name_b, abs(v_diff), v_group.presentation_currency,
            v_tol, v_group.presentation_currency);
        ELSIF v_has_diff_account THEN
          v_cause := 'rounding_posted_to_difference';
          v_refuse := false;
          v_remedies := ARRAY[]::text[];
          v_message := format(
            'The two sides of the %s position between %s and %s differ by %s %s, within the tolerance of %s %s in force, so the run posts it to this class''s difference account automatically.',
            v_class, v_name_a, v_name_b, abs(v_diff), v_group.presentation_currency,
            v_tol, v_group.presentation_currency);
        ELSE
          v_cause := 'missing_rounding_destination';
          v_refuse := true;
          v_remedies := CASE WHEN v_cross
                             THEN ARRAY['configure_cta_account', 'configure_difference_account']
                             ELSE ARRAY['configure_difference_account'] END;
          v_message := format(
            'The two sides of the %s position between %s and %s differ by %s %s, inside the tolerance of %s %s, but the group has nowhere to carry it. Leaving it unrecorded would unbalance the consolidated statements, so the run refuses until a translation reserve or difference account is named.',
            v_class, v_name_a, v_name_b, abs(v_diff), v_group.presentation_currency,
            v_tol, v_group.presentation_currency);
        END IF;
      ELSIF v_policy = 'post_to_cta' AND NOT v_cross THEN
        v_cause := 'genuine_disagreement';
        v_refuse := true;
        v_remedies := ARRAY['raise_tolerance']
                   || CASE WHEN v_has_diff_account
                           THEN ARRAY['set_policy_post_difference']
                           ELSE ARRAY['configure_difference_account'] END;
        v_message := format(
          'Both %s and %s already report in %s, so their %s gap of %s %s is a real disagreement and cannot be carried to the translation reserve.',
          v_name_a, v_name_b, v_group.presentation_currency, v_class,
          abs(v_diff), v_group.presentation_currency);
      ELSIF v_policy = 'post_to_cta' AND NOT v_has_cta THEN
        v_cause := 'missing_cta_account';
        v_refuse := true;
        v_remedies := ARRAY['configure_cta_account', 'raise_tolerance'];
        v_message := format(
          'The %s position between %s and %s differs by %s %s on translation, but this group has no translation reserve account to carry it.',
          v_class, v_name_a, v_name_b, abs(v_diff), v_group.presentation_currency);
      ELSIF v_policy = 'post_difference' AND NOT v_has_diff_account THEN
        v_cause := 'missing_difference_account';
        v_refuse := true;
        v_remedies := ARRAY['configure_difference_account', 'raise_tolerance'];
        v_message := format(
          'The %s position between %s and %s differs by %s %s, but no difference account is configured for this group.',
          v_class, v_name_a, v_name_b, abs(v_diff), v_group.presentation_currency);
      ELSIF v_policy <> 'refuse' THEN
        v_cause := 'residual_disclosed';
        v_refuse := false;
        v_remedies := ARRAY[]::text[];
        v_message := format(
          'The %s position between %s and %s differs by %s %s; the policy in force carries that residual to a named account, where it stays visible.',
          v_class, v_name_a, v_name_b, abs(v_diff), v_group.presentation_currency);
      ELSIF v_cross THEN
        v_cause := 'translation_residual';
        v_refuse := true;
        v_remedies := CASE WHEN v_has_cta
                           THEN ARRAY['set_policy_post_to_cta']
                           ELSE ARRAY['configure_cta_account'] END
                   || ARRAY['raise_tolerance'];
        v_message := format(
          '%s keeps its books in %s and %s in %s while the group reports in %s, so the %s gap of %s %s is what retranslation leaves behind rather than a figure the two companies disagree on.',
          v_name_a, v_cur_a, v_name_b, v_cur_b, v_group.presentation_currency,
          v_class, abs(v_diff), v_group.presentation_currency);
      ELSE
        v_cause := 'genuine_disagreement';
        v_refuse := true;
        v_remedies := ARRAY['raise_tolerance']
                   || CASE WHEN v_has_diff_account
                           THEN ARRAY['set_policy_post_difference']
                           ELSE ARRAY['configure_difference_account'] END;
        v_message := format(
          'Both %s and %s report in %s, so their %s gap of %s %s is a figure the two companies genuinely disagree on and no reserve may absorb it.',
          v_name_a, v_name_b, v_group.presentation_currency, v_class,
          abs(v_diff), v_group.presentation_currency);
      END IF;

      RETURN QUERY SELECT
        'pair_difference'::text,
        v_class,
        v_pair.a, v_name_a, v_cur_a,
        v_pair.b, v_name_b, v_cur_b,
        v_group.presentation_currency,
        v_diff, abs(v_diff),
        v_tol, v_policy, v_rule.id IS NOT NULL,
        v_cross, v_cause, v_refuse,
        abs(v_diff),
        v_remedies,
        v_message;
    END LOOP;
  END LOOP;
END;
$function$;