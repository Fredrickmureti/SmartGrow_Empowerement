CREATE OR REPLACE FUNCTION public.consolidation_reverse_eliminations(
  _group_id uuid, _date_from date, _date_to date, _reason text)
 RETURNS TABLE(reversed_leg_count integer, reversed_total_debit numeric, reversed_total_credit numeric)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group public.consolidation_groups;
  v_locked record;
  v_legs integer := 0;
  v_debit numeric := 0;
  v_credit numeric := 0;
BEGIN
  IF _group_id IS NULL OR _date_from IS NULL OR _date_to IS NULL THEN
    RAISE EXCEPTION 'consolidation_reverse_eliminations: group and date range are required';
  END IF;
  IF _date_to < _date_from THEN
    RAISE EXCEPTION 'consolidation_reverse_eliminations: date_to must not precede date_from';
  END IF;
  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'Withdrawing an elimination set is an accounting decision and must carry a reason'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found or not visible to you' USING ERRCODE = '42501';
  END IF;

  IF NOT (public.has_org_role(auth.uid(), v_group.organization_id, 'owner'::public.app_role)
       OR public.has_org_role(auth.uid(), v_group.organization_id, 'admin'::public.app_role)
       OR public.has_org_role(auth.uid(), v_group.organization_id, 'super_admin'::public.app_role)) THEN
    RAISE EXCEPTION 'You are not allowed to withdraw consolidation eliminations' USING ERRCODE = '42501';
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
    RAISE EXCEPTION 'The fiscal period covering % is closed for %, a member of this group. The eliminations for % to % cannot be withdrawn while a member period is closed',
      v_locked.locked_date, v_locked.business_name, _date_from, _date_to
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::int, round(COALESCE(sum(e.debit), 0), 2), round(COALESCE(sum(e.credit), 0), 2)
    INTO v_legs, v_debit, v_credit
    FROM public.consolidation_eliminations e
   WHERE e.group_id = _group_id AND e.period_start = _date_from AND e.period_end = _date_to;

  IF v_legs = 0 THEN
    RAISE EXCEPTION 'There is no generated elimination set for % to % to withdraw', _date_from, _date_to
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.consolidation_elimination_engine', 'on', true);

  DELETE FROM public.consolidation_eliminations e
   WHERE e.group_id = _group_id AND e.period_start = _date_from AND e.period_end = _date_to;

  INSERT INTO public.consolidation_elimination_events (
    organization_id, group_id, period_start, period_end, action, actor_id,
    presentation_currency, scope_snapshot, rule_snapshot,
    leg_count, difference_leg_count, total_debit, total_credit,
    replaced_leg_count, replaced_total_debit, replaced_total_credit, reason)
  VALUES (
    v_group.organization_id, _group_id, _date_from, _date_to, 'reverse', auth.uid(),
    v_group.presentation_currency, '[]'::jsonb, '[]'::jsonb,
    0, 0, 0, 0,
    v_legs, v_debit, v_credit, btrim(_reason));

  PERFORM set_config('app.consolidation_elimination_engine', 'off', true);

  RETURN QUERY SELECT v_legs, v_debit, v_credit;
END;
$function$;

REVOKE ALL ON FUNCTION public.consolidation_reverse_eliminations(uuid, date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consolidation_reverse_eliminations(uuid, date, date, text) TO authenticated, service_role;