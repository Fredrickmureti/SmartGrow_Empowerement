
-- Phase 3: Review → Merit → Contract → Payroll chain

-- Extend talent_merit_apply to write contract_amendments + lifecycle event
CREATE OR REPLACE FUNCTION public.talent_merit_apply(_ids uuid[])
RETURNS SETOF public.merit_recommendations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _row public.merit_recommendations;
  _hist_id uuid;
  _before jsonb;
  _contract public.employee_contracts;
  _amend_id uuid;
BEGIN
  FOR _row IN SELECT * FROM public.merit_recommendations WHERE id = ANY(_ids) LOOP
    IF NOT public.is_talent_admin(auth.uid(), _row.organization_id) THEN
      RAISE EXCEPTION 'Not authorized to apply merit %', _row.id;
    END IF;
    IF _row.status <> 'approved' THEN
      RAISE EXCEPTION 'Merit % must be approved before apply (got %)', _row.id, _row.status;
    END IF;
    _before := to_jsonb(_row);

    -- 1. compensation history (unchanged)
    INSERT INTO public.employee_compensation_history (
      organization_id, business_id, employee_id, effective_date,
      basic_salary, allowances_json, currency_code, change_type, reason,
      approved_by, approved_at, submitted_by, submitted_at, created_by
    ) VALUES (
      _row.organization_id, _row.business_id, _row.employee_id, _row.effective_date,
      _row.new_salary, '{}'::jsonb, _row.currency_code,
      'merit_increase',
      COALESCE(_row.notes, 'Merit increase from performance cycle'),
      _row.approved_by, _row.approved_at, _row.proposed_by, _row.proposed_at, auth.uid()
    ) RETURNING id INTO _hist_id;

    -- 2. locate active contract (if any) and record salary_revision amendment
    SELECT * INTO _contract
    FROM public.employee_contracts
    WHERE employee_id = _row.employee_id
      AND organization_id = _row.organization_id
      AND COALESCE(status, 'active') IN ('active','pending','draft')
      AND (end_date IS NULL OR end_date >= _row.effective_date)
    ORDER BY (status='active') DESC, start_date DESC NULLS LAST
    LIMIT 1;

    IF _contract.id IS NOT NULL THEN
      INSERT INTO public.contract_amendments (
        organization_id, business_id, contract_id, employee_id,
        kind, effective_on, actor_user_id, summary,
        before_snapshot, after_snapshot
      ) VALUES (
        _row.organization_id, _row.business_id, _contract.id, _row.employee_id,
        'salary_revision', _row.effective_date, auth.uid(),
        format('Merit increase %s%% (%s → %s)',
               round(_row.recommended_pct::numeric, 2),
               _row.current_salary, _row.new_salary),
        jsonb_build_object('wage', _contract.wage, 'currency_code', _row.currency_code),
        jsonb_build_object('wage', _row.new_salary, 'currency_code', _row.currency_code,
                           'merit_recommendation_id', _row.id,
                           'compensation_history_id', _hist_id)
      ) RETURNING id INTO _amend_id;
    END IF;

    -- 3. lifecycle event
    INSERT INTO public.employee_lifecycle_events (
      organization_id, business_id, employee_id, event_type,
      occurred_at, effective_date, actor_user_id,
      source_table, source_id, summary, payload
    ) VALUES (
      _row.organization_id, _row.business_id, _row.employee_id, 'salary_revised',
      now(), _row.effective_date, auth.uid(),
      'merit_recommendations', _row.id,
      format('Salary revised via merit: %s → %s', _row.current_salary, _row.new_salary),
      jsonb_build_object(
        'merit_recommendation_id', _row.id,
        'compensation_history_id', _hist_id,
        'contract_amendment_id', _amend_id,
        'previous_salary', _row.current_salary,
        'new_salary', _row.new_salary,
        'pct', _row.recommended_pct
      )
    );

    UPDATE public.merit_recommendations
      SET status='applied', applied_by=auth.uid(), applied_at=now(),
          applied_history_id=_hist_id, updated_at=now()
      WHERE id = _row.id
      RETURNING * INTO _row;

    INSERT INTO public.talent_audit_log
      (organization_id, actor_user_id, action, entity_type, entity_id, before_state, after_state)
    VALUES (_row.organization_id, auth.uid(), 'merit.applied', 'merit_recommendation', _row.id,
            _before, to_jsonb(_row) || jsonb_build_object(
              'compensation_history_id', _hist_id,
              'contract_amendment_id', _amend_id));
    RETURN NEXT _row;
  END LOOP;
END;
$function$;

-- Draft a merit recommendation from a completed review
CREATE OR REPLACE FUNCTION public.talent_merit_draft_from_review(
  _review_id uuid,
  _cycle_id uuid,
  _effective_date date,
  _default_pct numeric DEFAULT NULL
) RETURNS public.merit_recommendations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _review public.performance_reviews;
  _contract public.employee_contracts;
  _current_salary numeric;
  _pct numeric;
  _new_salary numeric;
  _amount numeric;
  _org uuid;
  _biz uuid;
  _existing public.merit_recommendations;
  _out public.merit_recommendations;
BEGIN
  SELECT * INTO _review FROM public.performance_reviews WHERE id = _review_id;
  IF _review.id IS NULL THEN
    RAISE EXCEPTION 'Review % not found', _review_id;
  END IF;
  _org := _review.organization_id;
  _biz := _review.business_id;
  IF NOT public.is_talent_admin(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _review.final_rating IS NULL THEN
    RAISE EXCEPTION 'Review has no final rating yet';
  END IF;

  SELECT * INTO _existing FROM public.merit_recommendations
   WHERE review_id = _review_id AND cycle_id = _cycle_id
   LIMIT 1;
  IF _existing.id IS NOT NULL THEN
    RETURN _existing;
  END IF;

  SELECT * INTO _contract
  FROM public.employee_contracts
  WHERE employee_id = _review.employee_id
    AND organization_id = _org
    AND COALESCE(status,'active') IN ('active','pending','draft')
  ORDER BY (status='active') DESC, start_date DESC NULLS LAST
  LIMIT 1;
  _current_salary := COALESCE(_contract.wage, 0);

  _pct := COALESCE(_default_pct,
    CASE
      WHEN _review.final_rating >= 4.5 THEN 8
      WHEN _review.final_rating >= 4.0 THEN 6
      WHEN _review.final_rating >= 3.0 THEN 4
      WHEN _review.final_rating >= 2.0 THEN 2
      ELSE 0
    END);
  _amount := round(_current_salary * _pct / 100.0, 2);
  _new_salary := _current_salary + _amount;

  INSERT INTO public.merit_recommendations (
    organization_id, business_id, cycle_id, employee_id, review_id,
    final_rating, current_salary, recommended_pct, recommended_amount, new_salary,
    currency_code, effective_date, status, notes,
    proposed_by, proposed_at, created_by
  ) VALUES (
    _org, _biz, _cycle_id, _review.employee_id, _review_id,
    _review.final_rating, _current_salary, _pct, _amount, _new_salary,
    NULL, _effective_date, 'proposed',
    format('Drafted from review %s (rating %s)', _review_id, _review.final_rating),
    auth.uid(), now(), auth.uid()
  ) RETURNING * INTO _out;

  INSERT INTO public.talent_audit_log
    (organization_id, actor_user_id, action, entity_type, entity_id, before_state, after_state)
  VALUES (_org, auth.uid(), 'merit.drafted_from_review', 'merit_recommendation', _out.id,
          to_jsonb(_review), to_jsonb(_out));

  RETURN _out;
END;
$function$;

REVOKE ALL ON FUNCTION public.talent_merit_draft_from_review(uuid, uuid, date, numeric) FROM public;
GRANT EXECUTE ON FUNCTION public.talent_merit_draft_from_review(uuid, uuid, date, numeric) TO authenticated;
