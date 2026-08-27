ALTER TYPE public.consolidation_elimination_difference_policy ADD VALUE IF NOT EXISTS 'post_to_cta';

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
  v_diff numeric;
  v_a uuid;
  v_b uuid;
  v_policy text;
  v_cur_a text;
  v_cur_b text;
  v_cross_currency boolean;
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

        -- A translation residual can only arise when at least one side of the
        -- pair keeps its books in a currency other than the group's. When both
        -- report in the presentation currency, a gap is a genuine disagreement
        -- and no reserve may absorb it.
        SELECT b.base_currency INTO v_cur_a FROM public.businesses b WHERE b.id = v_a;
        SELECT b.base_currency INTO v_cur_b FROM public.businesses b WHERE b.id = v_b;
        v_cross_currency := (v_cur_a IS DISTINCT FROM v_cur_b)
                         OR (v_cur_a IS DISTINCT FROM v_group.presentation_currency)
                         OR (v_cur_b IS DISTINCT FROM v_group.presentation_currency);

        IF v_policy = 'post_to_cta' AND abs(v_diff) > COALESCE(v_rule.tolerance_amount, 0)
           AND NOT v_cross_currency THEN
          RAISE EXCEPTION 'The two sides of the % position between % and % differ by % %, and both companies already report in %; that gap is a real disagreement, not a translation difference, so it cannot be carried to the translation reserve',
            v_class,
            (SELECT name FROM public.businesses WHERE id = v_a),
            (SELECT name FROM public.businesses WHERE id = v_b),
            abs(v_diff), v_group.presentation_currency, v_group.presentation_currency
            USING ERRCODE = '22023';
        END IF;

        IF abs(v_diff) > COALESCE(v_rule.tolerance_amount, 0) AND v_policy = 'refuse' THEN
          RAISE EXCEPTION 'The two sides of the % position between % and % differ by % %; raise the tolerance or name a difference account instead of consolidating a figure nobody agreed',
            v_class,
            (SELECT name FROM public.businesses WHERE id = v_a),
            (SELECT name FROM public.businesses WHERE id = v_b),
            abs(v_diff), v_group.presentation_currency
            USING ERRCODE = '22023';
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
                                    'tolerance', COALESCE(v_rule.tolerance_amount, 0),
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
                                    'tolerance', COALESCE(v_rule.tolerance_amount, 0)),
                 auth.uid()
            FROM public.consolidation_group_accounts a
           WHERE a.id = v_rule.difference_group_account_id;
        END IF;
      END IF;
    END LOOP;
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

CREATE OR REPLACE FUNCTION public.get_consolidated_statement_lines_eliminated(_group_id uuid, _date_from date, _date_to date)
 RETURNS TABLE(statement text, section text, section_order integer, account_id uuid, account_code text, account_name text, account_type account_type, is_residual boolean, is_derived boolean, presentation_currency text, aggregated_amount numeric, elimination_amount numeric, consolidated_amount numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT * FROM public.get_consolidated_statement_lines(_group_id, _date_from, _date_to)
  ),
  -- Eliminations carry their natural sign per account type, exactly as the
  -- statement lines do, so the two are directly additive.
  elim AS (
    SELECT e.group_account_id,
           e.account_type,
           round(sum(CASE WHEN e.account_type IN ('asset', 'expense')
                          THEN e.debit - e.credit ELSE e.credit - e.debit END), 2) AS amount
      FROM public.consolidation_eliminations e
     WHERE e.group_id = _group_id AND e.period_start = _date_from AND e.period_end = _date_to
     GROUP BY e.group_account_id, e.account_type
  ),
  result_effect AS (
    SELECT COALESCE(round(sum(CASE WHEN el.account_type = 'income' THEN el.amount
                                   WHEN el.account_type = 'expense' THEN -el.amount
                                   ELSE 0 END), 2), 0) AS amount
      FROM elim el
  ),
  joined AS (
    SELECT b.statement, b.section, b.section_order, b.account_id, b.account_code,
           b.account_name, b.account_type, b.is_residual, b.is_derived,
           b.presentation_currency,
           b.amount AS aggregated_amount,
           CASE
             WHEN b.is_derived AND b.statement = 'balance_sheet'
               THEN (SELECT amount FROM result_effect)
             WHEN b.is_derived THEN 0
             ELSE COALESCE(el.amount, 0)
           END AS elimination_amount
      FROM base b
      LEFT JOIN elim el ON el.group_account_id = b.account_id AND el.account_type = b.account_type

    UNION ALL

    -- An account fully created by an elimination difference still has to
    -- appear, even when it carried no aggregated balance. The difference may
    -- sit on a group account, or — for a translation residual carried to the
    -- reserve — on the group's translation adjustment account itself.
    SELECT CASE WHEN el.account_type IN ('income', 'expense') THEN 'income_statement' ELSE 'balance_sheet' END,
           CASE WHEN el.account_type = 'income' THEN 'income'
                WHEN el.account_type = 'expense' THEN 'expense'
                ELSE el.account_type::text END,
           CASE el.account_type WHEN 'income' THEN 1 WHEN 'expense' THEN 2
                                WHEN 'asset' THEN 1 WHEN 'liability' THEN 2 ELSE 3 END,
           el.group_account_id, COALESCE(a.code, ac.code), COALESCE(a.name, ac.name),
           el.account_type, (a.id IS NULL), false,
           (SELECT g.presentation_currency FROM public.consolidation_groups g WHERE g.id = _group_id),
           0, el.amount
      FROM elim el
      LEFT JOIN public.consolidation_group_accounts a ON a.id = el.group_account_id
      LEFT JOIN public.accounts ac ON ac.id = el.group_account_id
     WHERE COALESCE(a.name, ac.name) IS NOT NULL
       AND NOT EXISTS (
       SELECT 1 FROM base b
        WHERE b.account_id = el.group_account_id AND b.account_type = el.account_type
     )
  )
  SELECT j.statement, j.section, j.section_order, j.account_id, j.account_code,
         j.account_name, j.account_type, j.is_residual, j.is_derived,
         j.presentation_currency, j.aggregated_amount, j.elimination_amount,
         round(j.aggregated_amount + j.elimination_amount, 2)
    FROM joined j
   WHERE round(j.aggregated_amount, 2) <> 0 OR round(j.elimination_amount, 2) <> 0
   ORDER BY j.statement, j.section_order, j.is_derived, j.account_code NULLS LAST, j.account_name;
$function$;