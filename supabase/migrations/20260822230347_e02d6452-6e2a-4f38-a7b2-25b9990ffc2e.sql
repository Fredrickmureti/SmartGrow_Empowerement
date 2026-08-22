CREATE OR REPLACE FUNCTION public.apply_budget_revision(_budget_id uuid, _reason text, _lines jsonb, _note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  b public.budgets;
  v_revision_id uuid;
  v_revision_no integer;
  v_line jsonb;
  v_account_id uuid;
  v_month integer;
  v_amount numeric;
  v_prev numeric;
  v_period_id uuid;
  v_target_period uuid;
  v_changed integer := 0;
BEGIN
  b := public._budget_assert_manage(_budget_id);

  IF b.status <> 'active' THEN
    RAISE EXCEPTION 'Revisions apply only to active budgets. This budget is %.', b.status
      USING ERRCODE = '23514';
  END IF;

  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required for a budget revision' USING ERRCODE = '23514';
  END IF;

  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'At least one budget line change is required' USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(MAX(revision_number), 0) + 1 INTO v_revision_no
  FROM public.budget_revisions WHERE budget_id = _budget_id;

  INSERT INTO public.budget_revisions (
    budget_id, organization_id, business_id, revision_number, reason, note, created_by
  ) VALUES (
    _budget_id, b.organization_id, b.business_id, v_revision_no, btrim(_reason), _note, auth.uid()
  ) RETURNING id INTO v_revision_id;

  -- allow the line trigger to accept writes on an active budget for this call only
  PERFORM set_config('app.budget_revision', _budget_id::text, true);

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines)
  LOOP
    v_account_id := (v_line->>'account_id')::uuid;
    v_target_period := NULLIF(v_line->>'fiscal_period_id', '')::uuid;
    v_amount := COALESCE((v_line->>'budgeted_amount')::numeric, 0);

    -- The accounting period is the real identity of a budget line; the month
    -- number is only its label. When the caller names the period, that period
    -- is authoritative and the month is derived from it, so a non-January
    -- fiscal calendar can never revise the wrong month.
    IF v_target_period IS NOT NULL THEN
      SELECT m.period_month INTO v_month
      FROM public.budget_fiscal_months(b.business_id, b.fiscal_year) m
      WHERE m.period_id = v_target_period;

      IF v_month IS NULL THEN
        RAISE EXCEPTION 'Fiscal period % is not a monthly period of this budget''s year', v_target_period
          USING ERRCODE = '42501';
      END IF;
    ELSE
      v_month := (v_line->>'period_month')::int;
      IF v_month IS NULL OR v_month < 1 OR v_month > 12 THEN
        RAISE EXCEPTION 'Each revision line needs an account and either a fiscal period or a period month 1-12'
          USING ERRCODE = '23514';
      END IF;

      SELECT m.period_id INTO v_target_period
      FROM public.budget_fiscal_months(b.business_id, b.fiscal_year) m
      WHERE m.period_month = v_month
      ORDER BY m.start_date
      LIMIT 1;

      IF v_target_period IS NULL THEN
        RAISE EXCEPTION 'No monthly fiscal period exists for % / month % in this business. Provision fiscal periods first.',
          b.fiscal_year, v_month USING ERRCODE = '23503';
      END IF;
    END IF;

    IF v_account_id IS NULL THEN
      RAISE EXCEPTION 'Each revision line needs an account' USING ERRCODE = '23514';
    END IF;

    SELECT budgeted_amount INTO v_prev
    FROM public.budget_items
    WHERE budget_id = _budget_id AND account_id = v_account_id AND fiscal_period_id = v_target_period;

    IF FOUND THEN
      UPDATE public.budget_items
      SET budgeted_amount = v_amount
      WHERE budget_id = _budget_id AND account_id = v_account_id AND fiscal_period_id = v_target_period
      RETURNING fiscal_period_id INTO v_period_id;
    ELSE
      v_prev := 0;
      INSERT INTO public.budget_items (budget_id, account_id, period_month, fiscal_period_id, budgeted_amount)
      VALUES (_budget_id, v_account_id, v_month, v_target_period, v_amount)
      RETURNING fiscal_period_id INTO v_period_id;
    END IF;

    INSERT INTO public.budget_revision_lines (
      revision_id, account_id, fiscal_period_id, period_month, previous_amount, new_amount
    ) VALUES (
      v_revision_id, v_account_id, v_period_id, v_month, v_prev, v_amount
    )
    ON CONFLICT (revision_id, account_id, fiscal_period_id)
    DO UPDATE SET new_amount = EXCLUDED.new_amount;

    v_changed := v_changed + 1;
  END LOOP;

  PERFORM set_config('app.budget_revision', '', true);

  UPDATE public.budgets SET updated_at = now() WHERE id = _budget_id;

  INSERT INTO public.audit_logs (
    organization_id, business_id, user_id, action, entity_type, entity_id, entity_name,
    new_values, changes_summary
  ) VALUES (
    b.organization_id, b.business_id, auth.uid(), 'budget.revised', 'budget', _budget_id, b.name,
    jsonb_build_object('revision_id', v_revision_id, 'revision_number', v_revision_no, 'lines_changed', v_changed),
    format('Revision %s: %s line(s) changed — %s', v_revision_no, v_changed, btrim(_reason))
  );

  RETURN v_revision_id;
END;
$function$;