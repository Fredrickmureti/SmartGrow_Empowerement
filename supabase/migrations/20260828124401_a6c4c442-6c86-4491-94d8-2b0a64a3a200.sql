CREATE OR REPLACE FUNCTION public.consolidation_create_run(
  _group_id uuid,
  _date_from date,
  _date_to date,
  _notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_group public.consolidation_groups;
  v_locked record;
  v_run_id uuid;
  v_bal record;
BEGIN
  IF _group_id IS NULL OR _date_from IS NULL OR _date_to IS NULL THEN
    RAISE EXCEPTION 'consolidation_create_run: group and date range are required';
  END IF;
  IF _date_to < _date_from THEN
    RAISE EXCEPTION 'consolidation_create_run: date_to must not precede date_from';
  END IF;

  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found or not visible to you' USING ERRCODE = '42501';
  END IF;

  IF NOT (public.has_org_role(auth.uid(), v_group.organization_id, 'owner'::public.app_role)
       OR public.has_org_role(auth.uid(), v_group.organization_id, 'admin'::public.app_role)
       OR public.has_org_role(auth.uid(), v_group.organization_id, 'super_admin'::public.app_role)) THEN
    RAISE EXCEPTION 'You are not allowed to create consolidation runs' USING ERRCODE = '42501';
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
    RAISE EXCEPTION 'The fiscal period covering % is closed for %, a member of this group. A consolidation run for % to % cannot be created while a member period is closed: reopen that period, or run the consolidation for a period the member''s books are still open for',
      v_locked.locked_date, v_locked.business_name, _date_from, _date_to
      USING ERRCODE = '42501';
  END IF;

  -- Idempotence: the same actor asking again for the same basis within a minute
  -- is a repeated click, not a second run.
  SELECT r.id INTO v_run_id
    FROM public.consolidation_runs r
   WHERE r.group_id = _group_id
     AND r.period_start = _date_from
     AND r.period_end = _date_to
     AND r.state = 'draft'
     AND r.created_by IS NOT DISTINCT FROM auth.uid()
     AND r.created_at > now() - interval '1 minute'
   ORDER BY r.created_at DESC
   LIMIT 1;
  IF v_run_id IS NOT NULL THEN
    RETURN v_run_id;
  END IF;

  SELECT round(COALESCE(sum(b.total_debit), 0), 2)  AS total_debit,
         round(COALESCE(sum(b.total_credit), 0), 2) AS total_credit,
         round(COALESCE(sum(b.out_of_balance), 0), 2) AS out_of_balance,
         bool_and(b.is_balanced)                    AS is_balanced
    INTO v_bal
    FROM public.consolidation_eliminations_balance(_group_id, _date_from, _date_to) b;

  INSERT INTO public.consolidation_runs (
    organization_id, group_id, period_start, period_end, presentation_currency,
    state, eliminations_debit, eliminations_credit, balance_difference, is_balanced,
    notes, created_by
  ) VALUES (
    v_group.organization_id, _group_id, _date_from, _date_to, v_group.presentation_currency,
    'draft', COALESCE(v_bal.total_debit, 0), COALESCE(v_bal.total_credit, 0),
    COALESCE(v_bal.out_of_balance, 0), COALESCE(v_bal.is_balanced, true),
    NULLIF(btrim(COALESCE(_notes, '')), ''), auth.uid()
  ) RETURNING id INTO v_run_id;

  -- Member scope as resolved at run time.
  INSERT INTO public.consolidation_run_members (
    run_id, business_id, business_name, base_currency, is_parent, method,
    ownership_percent, requires_translation, effective_from, effective_to
  )
  SELECT v_run_id, m.business_id, m.business_name, m.base_currency, m.is_parent, m.method,
         m.ownership_percent, m.requires_translation, m.effective_from, m.effective_to
    FROM public.resolve_consolidation_scope(_group_id, _date_to) m;

  -- FX basis actually used, per member.
  INSERT INTO public.consolidation_run_rates (
    run_id, business_id, from_currency, to_currency, closing_rate, opening_rate,
    average_rate, prior_average_rate, historical_rate, historical_date
  )
  SELECT v_run_id, rm.business_id, t.from_currency, t.to_currency, t.closing_rate, t.opening_rate,
         t.average_rate, t.prior_average_rate, t.historical_rate, t.historical_date
    FROM public.consolidation_run_members rm
    CROSS JOIN LATERAL public.consolidation_member_translation_rates(
      _group_id, rm.business_id, _date_from, _date_to
    ) t
   WHERE rm.run_id = v_run_id;

  -- Frozen statement lines with the member contributions behind each one.
  INSERT INTO public.consolidation_run_lines (
    run_id, statement, section, section_order, group_account_id, account_code, account_name,
    account_type, is_residual, is_derived, presentation_currency,
    aggregated_amount, elimination_amount, consolidated_amount, member_contributions, line_order
  )
  SELECT v_run_id, l.statement, l.section, l.section_order, l.account_id, l.account_code, l.account_name,
         l.account_type, l.is_residual, l.is_derived, l.presentation_currency,
         l.aggregated_amount, l.elimination_amount, l.consolidated_amount,
         COALESCE(c.contributions, '[]'::jsonb),
         row_number() OVER (ORDER BY l.statement, l.section_order, l.account_code)
    FROM public.get_consolidated_statement_lines_eliminated(_group_id, _date_from, _date_to) l
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'business_id', tb.business_id,
               'business_name', tb.business_name,
               'base_currency', tb.base_currency,
               'rate_class', tb.rate_class,
               'rate_used', tb.rate_used,
               'closing_balance', tb.closing_balance,
               'translated_closing', tb.translated_closing
             ) ORDER BY tb.business_name) AS contributions
        FROM public.get_consolidated_trial_balance_translated(_group_id, _date_from, _date_to) tb
       WHERE tb.group_account_id IS NOT DISTINCT FROM l.account_id
    ) c ON true;

  UPDATE public.consolidation_runs r
     SET line_count = (SELECT count(*) FROM public.consolidation_run_lines x WHERE x.run_id = v_run_id),
         member_count = (SELECT count(*) FROM public.consolidation_run_members x WHERE x.run_id = v_run_id)
   WHERE r.id = v_run_id;

  RETURN v_run_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.consolidation_finalize_run(_run_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_run public.consolidation_runs;
  v_unmapped record;
  v_locked record;
BEGIN
  SELECT * INTO v_run FROM public.consolidation_runs r WHERE r.id = _run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation run not found or not visible to you' USING ERRCODE = '42501';
  END IF;

  IF NOT (public.has_org_role(auth.uid(), v_run.organization_id, 'owner'::public.app_role)
       OR public.has_org_role(auth.uid(), v_run.organization_id, 'admin'::public.app_role)
       OR public.has_org_role(auth.uid(), v_run.organization_id, 'super_admin'::public.app_role)) THEN
    RAISE EXCEPTION 'You are not allowed to finalize consolidation runs' USING ERRCODE = '42501';
  END IF;

  IF v_run.state = 'final' THEN
    RETURN v_run.id;
  END IF;
  IF v_run.state <> 'draft' THEN
    RAISE EXCEPTION 'This consolidation run is % and cannot be finalized. Create a new run for this group and period', v_run.state
      USING ERRCODE = '42501';
  END IF;

  SELECT m.business_name AS business_name, d::date AS locked_date
    INTO v_locked
    FROM public.consolidation_run_members m
    CROSS JOIN LATERAL unnest(
      ARRAY(SELECT generate_series(date_trunc('month', v_run.period_start)::date, v_run.period_end, interval '1 month')::date)
      || ARRAY[v_run.period_end]
    ) AS d
   WHERE m.run_id = v_run.id
     AND public.is_period_locked(v_run.organization_id, m.business_id, d)
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'The fiscal period covering % is closed for %, a member of this group. This run cannot be finalized while a member period is closed: reopen that period, or create a run for a period the member''s books are still open for',
      v_locked.locked_date, v_locked.business_name
      USING ERRCODE = '42501';
  END IF;

  SELECT u.business_name, u.account_code, u.account_name
    INTO v_unmapped
    FROM public.consolidation_unmapped_accounts(v_run.group_id, v_run.period_start, v_run.period_end) u
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Account % (%) of % is not mapped to a group account, so it carries no balance into these figures. Map every member account to the group chart before finalizing, then create a fresh run',
      v_unmapped.account_code, v_unmapped.account_name, v_unmapped.business_name
      USING ERRCODE = '42501';
  END IF;

  IF NOT COALESCE(v_run.is_balanced, false) THEN
    RAISE EXCEPTION 'The eliminations behind this run are out of balance by %. Resolve the intercompany difference and create a fresh run before finalizing',
      v_run.balance_difference
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.consolidation_runs r
     SET state = 'superseded',
         superseded_at = now(),
         superseded_by_run_id = v_run.id
   WHERE r.group_id = v_run.group_id
     AND r.period_start = v_run.period_start
     AND r.period_end = v_run.period_end
     AND r.state = 'final'
     AND r.id <> v_run.id;

  UPDATE public.consolidation_runs r
     SET state = 'final', finalized_by = auth.uid(), finalized_at = now()
   WHERE r.id = v_run.id;

  RETURN v_run.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.consolidation_supersede_run(
  _run_id uuid,
  _superseded_by_run_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_run public.consolidation_runs;
  v_next public.consolidation_runs;
BEGIN
  SELECT * INTO v_run FROM public.consolidation_runs r WHERE r.id = _run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation run not found or not visible to you' USING ERRCODE = '42501';
  END IF;

  IF NOT (public.has_org_role(auth.uid(), v_run.organization_id, 'owner'::public.app_role)
       OR public.has_org_role(auth.uid(), v_run.organization_id, 'admin'::public.app_role)
       OR public.has_org_role(auth.uid(), v_run.organization_id, 'super_admin'::public.app_role)) THEN
    RAISE EXCEPTION 'You are not allowed to supersede consolidation runs' USING ERRCODE = '42501';
  END IF;

  IF v_run.state = 'superseded' THEN
    RETURN v_run.id;
  END IF;

  IF _superseded_by_run_id IS NOT NULL THEN
    SELECT * INTO v_next FROM public.consolidation_runs r WHERE r.id = _superseded_by_run_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The replacing consolidation run was not found or is not visible to you' USING ERRCODE = '42501';
    END IF;
    IF v_next.group_id <> v_run.group_id
       OR v_next.period_start <> v_run.period_start
       OR v_next.period_end <> v_run.period_end THEN
      RAISE EXCEPTION 'A consolidation run can only be superseded by a run for the same group and period'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE public.consolidation_runs r
     SET state = 'superseded',
         superseded_at = now(),
         superseded_by_run_id = _superseded_by_run_id
   WHERE r.id = v_run.id;

  RETURN v_run.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.consolidation_create_run(uuid, date, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consolidation_finalize_run(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consolidation_supersede_run(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consolidation_create_run(uuid, date, date, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.consolidation_finalize_run(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.consolidation_supersede_run(uuid, uuid) TO authenticated, service_role;