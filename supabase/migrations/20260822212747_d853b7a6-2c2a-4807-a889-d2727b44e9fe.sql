-- Trigger helpers are not an API surface
REVOKE ALL ON FUNCTION public._budgets_defaults() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._budgets_lifecycle_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._budget_items_normalize() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._budgets_audit() FROM PUBLIC, anon, authenticated;

-- ============================================================
-- Guarded lifecycle + revision API
-- ============================================================

CREATE OR REPLACE FUNCTION public._budget_assert_manage(_budget_id uuid)
RETURNS public.budgets
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  b public.budgets;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO b FROM public.budgets WHERE id = _budget_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Budget not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.user_can_access_business(auth.uid(), b.business_id)
     OR NOT public.user_has_module_permission(auth.uid(), b.organization_id, b.business_id, 'financials', 'write') THEN
    RAISE EXCEPTION 'You do not have permission to manage budgets for this business'
      USING ERRCODE = '42501';
  END IF;

  IF b.branch_id IS NOT NULL
     AND NOT public.user_can_access_branch(auth.uid(), b.branch_id)
     AND NOT public.has_finance_permission(auth.uid(), 'finance.view_consolidated', b.business_id) THEN
    RAISE EXCEPTION 'You do not have permission to manage budgets for this branch'
      USING ERRCODE = '42501';
  END IF;

  RETURN b;
END;
$$;

REVOKE ALL ON FUNCTION public._budget_assert_manage(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._budget_assert_manage(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_budget_status(_budget_id uuid, _status public.budget_status)
RETURNS public.budgets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  b public.budgets;
BEGIN
  b := public._budget_assert_manage(_budget_id);

  IF _status NOT IN ('active', 'closed') THEN
    RAISE EXCEPTION 'A budget can only be activated or closed' USING ERRCODE = '23514';
  END IF;

  IF _status = 'active' AND NOT EXISTS (
    SELECT 1 FROM public.budget_items WHERE budget_id = _budget_id
  ) THEN
    RAISE EXCEPTION 'A budget must have at least one line before it can be activated'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.budgets
  SET status = _status
  WHERE id = _budget_id
  RETURNING * INTO b;

  RETURN b;
END;
$$;

REVOKE ALL ON FUNCTION public.set_budget_status(uuid, public.budget_status) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_budget_status(uuid, public.budget_status) TO authenticated;

-- Apply a revision to an ACTIVE budget.
-- _lines: [{ "account_id": uuid, "period_month": int, "budgeted_amount": numeric }]
CREATE OR REPLACE FUNCTION public.apply_budget_revision(
  _budget_id uuid,
  _reason text,
  _lines jsonb,
  _note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
    v_month := (v_line->>'period_month')::int;
    v_amount := COALESCE((v_line->>'budgeted_amount')::numeric, 0);

    IF v_account_id IS NULL OR v_month IS NULL OR v_month < 1 OR v_month > 12 THEN
      RAISE EXCEPTION 'Each revision line needs an account and a period month 1-12'
        USING ERRCODE = '23514';
    END IF;

    SELECT budgeted_amount INTO v_prev
    FROM public.budget_items
    WHERE budget_id = _budget_id AND account_id = v_account_id AND period_month = v_month;

    IF FOUND THEN
      UPDATE public.budget_items
      SET budgeted_amount = v_amount
      WHERE budget_id = _budget_id AND account_id = v_account_id AND period_month = v_month
      RETURNING fiscal_period_id INTO v_period_id;
    ELSE
      v_prev := 0;
      INSERT INTO public.budget_items (budget_id, account_id, period_month, budgeted_amount)
      VALUES (_budget_id, v_account_id, v_month, v_amount)
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
$$;

REVOKE ALL ON FUNCTION public.apply_budget_revision(uuid, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_budget_revision(uuid, text, jsonb, text) TO authenticated;