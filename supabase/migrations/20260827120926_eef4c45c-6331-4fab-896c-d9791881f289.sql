-- The generator is SECURITY INVOKER, so writes go through RLS as the caller.
CREATE POLICY consolidation_eliminations_write ON public.consolidation_eliminations
FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.consolidation_groups g
     WHERE g.id = consolidation_eliminations.group_id
       AND public.user_can_access_business(auth.uid(), g.parent_business_id)
  )
  AND (public.has_org_role(auth.uid(), organization_id, 'owner'::public.app_role)
    OR public.has_org_role(auth.uid(), organization_id, 'admin'::public.app_role)
    OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::public.app_role))
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.consolidation_groups g
     WHERE g.id = consolidation_eliminations.group_id
       AND public.user_can_access_business(auth.uid(), g.parent_business_id)
  )
  AND (public.has_org_role(auth.uid(), organization_id, 'owner'::public.app_role)
    OR public.has_org_role(auth.uid(), organization_id, 'admin'::public.app_role)
    OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::public.app_role))
);

GRANT INSERT, UPDATE, DELETE ON public.consolidation_eliminations TO authenticated;

REVOKE EXECUTE ON FUNCTION public._consolidation_elimination_rule_guard() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._consolidation_eliminations_engine_only() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Intercompany flows: ledger truth, translated by the existing consolidation
-- machinery. Balance-sheet accounts are cumulative to the period end (a
-- position), profit-and-loss accounts are period movement (a flow).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consolidation_intercompany_flows(
  _group_id uuid, _date_from date, _date_to date)
RETURNS TABLE (
  declaring_business_id uuid,
  declaring_business_name text,
  counterparty_business_id uuid,
  counterparty_business_name text,
  account_id uuid,
  account_code text,
  account_name text,
  account_type public.account_type,
  group_account_id uuid,
  group_account_code text,
  group_account_name text,
  presentation_currency text,
  rate_class text,
  rate_used numeric,
  basis text,
  debit_base numeric,
  credit_base numeric,
  debit_presentation numeric,
  credit_presentation numeric,
  entry_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_group public.consolidation_groups;
  v_blocker text;
  v_bad text;
BEGIN
  IF _group_id IS NULL OR _date_from IS NULL OR _date_to IS NULL THEN
    RAISE EXCEPTION 'consolidation_intercompany_flows: group and date range are required';
  END IF;
  IF _date_to < _date_from THEN
    RAISE EXCEPTION 'consolidation_intercompany_flows: date_to must not precede date_from';
  END IF;

  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found or not visible to you' USING ERRCODE = '42501';
  END IF;

  SELECT s.blocker INTO v_blocker
    FROM public.resolve_consolidation_scope(_group_id, _date_to) s
   WHERE s.blocker IS NOT NULL
   LIMIT 1;
  IF v_blocker IS NOT NULL THEN
    RAISE EXCEPTION 'Consolidation scope is not reportable: %', v_blocker USING ERRCODE = '42501';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _ic_flow_tb (
    business_id uuid, account_id uuid, account_code text, account_name text,
    account_type public.account_type, group_account_id uuid, group_account_code text,
    group_account_name text, presentation_currency text, rate_class text, rate_used numeric,
    business_name text
  ) ON COMMIT DROP;
  TRUNCATE _ic_flow_tb;
  INSERT INTO _ic_flow_tb
  SELECT t.business_id, t.account_id, t.account_code, t.account_name, t.account_type,
         t.group_account_id, t.group_account_code, t.group_account_name,
         t.presentation_currency, t.rate_class::text, t.rate_used, t.business_name
    FROM public.get_consolidated_trial_balance_translated(_group_id, _date_from, _date_to) t;

  CREATE TEMP TABLE IF NOT EXISTS _ic_flow_entries (
    journal_entry_id uuid, business_id uuid, counterparty_business_id uuid, entry_date date
  ) ON COMMIT DROP;
  TRUNCATE _ic_flow_entries;
  INSERT INTO _ic_flow_entries
  SELECT DISTINCT jl.journal_entry_id, p.business_id, p.counterparty_business_id, je.entry_date
    FROM public.consolidation_intercompany_partners p
    JOIN public.journal_entry_lines jl
      ON jl.contact_id = p.contact_id AND jl.business_id = p.business_id
    JOIN public.journal_entries je
      ON je.id = jl.journal_entry_id
     AND je.business_id = p.business_id
     AND je.status = 'posted'
     AND je.entry_date <= _date_to
   WHERE p.group_id = _group_id
     AND p.effective_from <= _date_to
     AND (p.effective_to IS NULL OR p.effective_to >= _date_from);

  -- One entry cannot be attributed to two sister companies at once; guessing a
  -- split would manufacture an elimination nobody can trace.
  SELECT string_agg(DISTINCT e.journal_entry_id::text, ', ')
    INTO v_bad
    FROM _ic_flow_entries e
   GROUP BY e.journal_entry_id
  HAVING count(DISTINCT e.counterparty_business_id) > 1
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Journal entry % is tagged to more than one group company; intercompany flows are refused rather than split by guesswork',
      v_bad USING ERRCODE = '22023';
  END IF;

  -- A flow on an account the consolidated trial balance does not report cannot
  -- be eliminated from it.
  SELECT string_agg(DISTINCT format('%s in %s', a.code, b.name), '; ')
    INTO v_bad
    FROM _ic_flow_entries e
    JOIN public.journal_entry_lines jl
      ON jl.journal_entry_id = e.journal_entry_id AND jl.business_id = e.business_id
    JOIN public.accounts a ON a.id = jl.account_id
    JOIN public.businesses b ON b.id = e.business_id
   WHERE NOT EXISTS (
     SELECT 1 FROM _ic_flow_tb t
      WHERE t.business_id = e.business_id AND t.account_id = jl.account_id
   );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Intercompany entries touch accounts the consolidated trial balance does not report (%); flows are refused rather than understated',
      v_bad USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH lines AS (
    SELECT e.business_id, e.counterparty_business_id, jl.account_id,
           jl.debit, jl.credit, e.entry_date, e.journal_entry_id
      FROM _ic_flow_entries e
      JOIN public.journal_entry_lines jl
        ON jl.journal_entry_id = e.journal_entry_id AND jl.business_id = e.business_id
  ),
  scoped AS (
    SELECT l.*, t.account_type,
           CASE WHEN t.account_type IN ('income', 'expense') THEN 'period' ELSE 'cumulative' END AS basis
      FROM lines l
      JOIN _ic_flow_tb t ON t.business_id = l.business_id AND t.account_id = l.account_id
     WHERE t.account_type NOT IN ('income', 'expense')
        OR l.entry_date BETWEEN _date_from AND _date_to
  ),
  agg AS (
    SELECT s.business_id, s.counterparty_business_id, s.account_id, s.basis,
           SUM(s.debit) AS debit_base, SUM(s.credit) AS credit_base,
           COUNT(DISTINCT s.journal_entry_id)::int AS entry_count
      FROM scoped s
     GROUP BY s.business_id, s.counterparty_business_id, s.account_id, s.basis
  )
  SELECT a.business_id, t.business_name, a.counterparty_business_id, cp.name,
         t.account_id, t.account_code, t.account_name, t.account_type,
         t.group_account_id, t.group_account_code, t.group_account_name,
         t.presentation_currency, t.rate_class, t.rate_used, a.basis,
         a.debit_base, a.credit_base,
         round(a.debit_base * t.rate_used, 2),
         round(a.credit_base * t.rate_used, 2),
         a.entry_count
    FROM agg a
    JOIN _ic_flow_tb t ON t.business_id = a.business_id AND t.account_id = a.account_id
    JOIN public.businesses cp ON cp.id = a.counterparty_business_id
   WHERE a.debit_base <> 0 OR a.credit_base <> 0
   ORDER BY t.business_name, cp.name, t.group_account_code, t.account_code;
END;
$$;

-- ---------------------------------------------------------------------------
-- The elimination engine.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consolidation_generate_eliminations(
  _group_id uuid, _date_from date, _date_to date)
RETURNS TABLE (
  elimination_class public.consolidation_elimination_class,
  pair_count integer,
  line_count integer,
  eliminated_debit numeric,
  eliminated_credit numeric,
  difference_amount numeric
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_group public.consolidation_groups;
  v_class public.consolidation_elimination_class;
  v_rule public.consolidation_elimination_rules;
  v_types public.account_type[];
  v_pair record;
  v_diff numeric;
  v_a uuid;
  v_b uuid;
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
        IF abs(v_diff) > COALESCE(v_rule.tolerance_amount, 0)
           AND COALESCE(v_rule.difference_policy, 'refuse') = 'refuse' THEN
          RAISE EXCEPTION 'The two sides of the % position between % and % differ by % %; raise the tolerance or name a difference account instead of consolidating a figure nobody agreed',
            v_class,
            (SELECT name FROM public.businesses WHERE id = v_a),
            (SELECT name FROM public.businesses WHERE id = v_b),
            abs(v_diff), v_group.presentation_currency
            USING ERRCODE = '22023';
        END IF;

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
$$;

-- ---------------------------------------------------------------------------
-- Statements after eliminations: aggregated, eliminated, consolidated.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_consolidated_statement_lines_eliminated(
  _group_id uuid, _date_from date, _date_to date)
RETURNS TABLE (
  statement text,
  section text,
  section_order integer,
  account_id uuid,
  account_code text,
  account_name text,
  account_type public.account_type,
  is_residual boolean,
  is_derived boolean,
  presentation_currency text,
  aggregated_amount numeric,
  elimination_amount numeric,
  consolidated_amount numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
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

    -- A group account fully created by an elimination difference still has to
    -- appear, even when it carried no aggregated balance.
    SELECT CASE WHEN el.account_type IN ('income', 'expense') THEN 'income_statement' ELSE 'balance_sheet' END,
           CASE WHEN el.account_type = 'income' THEN 'income'
                WHEN el.account_type = 'expense' THEN 'expense'
                ELSE el.account_type::text END,
           CASE el.account_type WHEN 'income' THEN 1 WHEN 'expense' THEN 2
                                WHEN 'asset' THEN 1 WHEN 'liability' THEN 2 ELSE 3 END,
           el.group_account_id, a.code, a.name, el.account_type, false, false,
           (SELECT g.presentation_currency FROM public.consolidation_groups g WHERE g.id = _group_id),
           0, el.amount
      FROM elim el
      JOIN public.consolidation_group_accounts a ON a.id = el.group_account_id
     WHERE NOT EXISTS (
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
$$;

CREATE OR REPLACE FUNCTION public.get_consolidated_statement_totals_eliminated(
  _group_id uuid, _date_from date, _date_to date)
RETURNS TABLE (
  presentation_currency text,
  total_income numeric,
  total_expense numeric,
  net_result numeric,
  total_assets numeric,
  total_liabilities numeric,
  total_equity numeric,
  eliminations_debit numeric,
  eliminations_credit numeric,
  balance_sheet_difference numeric,
  is_balanced boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH l AS (
    SELECT * FROM public.get_consolidated_statement_lines_eliminated(_group_id, _date_from, _date_to)
  ),
  e AS (
    SELECT COALESCE(sum(x.debit), 0) AS dr, COALESCE(sum(x.credit), 0) AS cr
      FROM public.consolidation_eliminations x
     WHERE x.group_id = _group_id AND x.period_start = _date_from AND x.period_end = _date_to
  ),
  agg AS (
    SELECT min(l.presentation_currency) AS presentation_currency,
           COALESCE(sum(l.consolidated_amount) FILTER (WHERE l.statement = 'income_statement' AND l.section = 'income'), 0) AS total_income,
           COALESCE(sum(l.consolidated_amount) FILTER (WHERE l.statement = 'income_statement' AND l.section = 'expense'), 0) AS total_expense,
           COALESCE(sum(l.consolidated_amount) FILTER (WHERE l.statement = 'balance_sheet' AND l.section = 'asset'), 0) AS total_assets,
           COALESCE(sum(l.consolidated_amount) FILTER (WHERE l.statement = 'balance_sheet' AND l.section = 'liability'), 0) AS total_liabilities,
           COALESCE(sum(l.consolidated_amount) FILTER (WHERE l.statement = 'balance_sheet' AND l.section = 'equity'), 0) AS total_equity
      FROM l
  )
  SELECT a.presentation_currency, a.total_income, a.total_expense,
         round(a.total_income - a.total_expense, 2),
         a.total_assets, a.total_liabilities, a.total_equity,
         e.dr, e.cr,
         round(a.total_assets - (a.total_liabilities + a.total_equity), 2),
         round(a.total_assets - (a.total_liabilities + a.total_equity), 2) = 0
    FROM agg a CROSS JOIN e;
$$;