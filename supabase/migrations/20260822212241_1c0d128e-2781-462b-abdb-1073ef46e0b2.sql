-- ============================================================
-- Phase 0: Budget security hotfix
-- ============================================================

-- 1. budget_items SELECT: business/branch scoped (was organization-wide)
DROP POLICY IF EXISTS "Users can view budget items" ON public.budget_items;

CREATE POLICY budget_items_select_v3
ON public.budget_items
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.budgets b
    WHERE b.id = budget_items.budget_id
      AND public.user_can_access_business(auth.uid(), b.business_id)
      AND public.user_has_module_permission(auth.uid(), b.organization_id, b.business_id, 'financials', 'read')
      AND (
        b.branch_id IS NULL
        OR public.user_can_access_branch(auth.uid(), b.branch_id)
        OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', b.business_id)
      )
  )
);

-- 2. budget_actuals: read-only for app users, business/branch scoped
DROP POLICY IF EXISTS budget_actuals_select ON public.budget_actuals;
DROP POLICY IF EXISTS budget_actuals_insert ON public.budget_actuals;
DROP POLICY IF EXISTS budget_actuals_update ON public.budget_actuals;
DROP POLICY IF EXISTS budget_actuals_delete ON public.budget_actuals;

CREATE POLICY budget_actuals_select_v3
ON public.budget_actuals
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.budgets b
    WHERE b.id = budget_actuals.budget_id
      AND b.business_id = budget_actuals.business_id
      AND public.user_can_access_business(auth.uid(), b.business_id)
      AND public.user_has_module_permission(auth.uid(), b.organization_id, b.business_id, 'financials', 'read')
      AND (
        b.branch_id IS NULL
        OR public.user_can_access_branch(auth.uid(), b.branch_id)
        OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', b.business_id)
      )
  )
);

REVOKE INSERT, UPDATE, DELETE ON public.budget_actuals FROM authenticated;
REVOKE ALL ON public.budget_actuals FROM anon;
GRANT SELECT ON public.budget_actuals TO authenticated;
GRANT ALL ON public.budget_actuals TO service_role;

-- 3. check_budget_variance: authorize the caller, scope to business/branch,
--    use the authoritative ledger visibility rule, exclude closing/opening
--    and sample journal activity.
DROP FUNCTION IF EXISTS public.check_budget_variance(uuid, uuid[], numeric[], date);

CREATE OR REPLACE FUNCTION public.check_budget_variance(
  _org_id uuid,
  _business_id uuid,
  _account_ids uuid[],
  _amounts numeric[],
  _entry_date date,
  _branch_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _fiscal_year int;
  _month int;
  _result jsonb := '[]'::jsonb;
  _i int;
  _account_id uuid;
  _amount numeric;
  _budget_amount numeric;
  _actual_amount numeric;
  _budget_name text;
  _account_name text;
BEGIN
  IF _org_id IS NULL OR _business_id IS NULL THEN
    RAISE EXCEPTION 'check_budget_variance: _org_id and _business_id are required'
      USING ERRCODE = '22023';
  END IF;

  IF NOT public.finance_can_read_scope(_org_id, _business_id)
     OR NOT public.finance_can_read_branch(_org_id, _business_id, _branch_id)
     OR NOT public.finance_can_read_financials(_org_id, _business_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.businesses b
    WHERE b.id = _business_id AND b.organization_id = _org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'check_budget_variance: business % does not belong to org %', _business_id, _org_id
      USING ERRCODE = '42501';
  END IF;

  IF _branch_id IS NOT NULL THEN
    PERFORM 1 FROM public.branches br
      WHERE br.id = _branch_id
        AND br.organization_id = _org_id
        AND br.business_id = _business_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'check_budget_variance: branch % does not belong to business %', _branch_id, _business_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF _account_ids IS NULL OR array_length(_account_ids, 1) IS NULL THEN
    RETURN _result;
  END IF;

  _fiscal_year := EXTRACT(YEAR FROM _entry_date)::int;
  _month := EXTRACT(MONTH FROM _entry_date)::int;

  FOR _i IN 1..array_length(_account_ids, 1) LOOP
    _account_id := _account_ids[_i];
    _amount := COALESCE(_amounts[_i], 0);

    -- Active budget for this business (+branch, falling back to the
    -- business-wide budget) covering this account/month/year.
    SELECT bi.budgeted_amount, b.name, a.name
    INTO _budget_amount, _budget_name, _account_name
    FROM public.budget_items bi
    JOIN public.budgets b ON b.id = bi.budget_id
    JOIN public.accounts a ON a.id = bi.account_id
    WHERE bi.account_id = _account_id
      AND bi.period_month = _month
      AND b.fiscal_year = _fiscal_year
      AND b.organization_id = _org_id
      AND b.business_id = _business_id
      AND b.status = 'active'
      AND (_branch_id IS NULL OR b.branch_id IS NULL OR b.branch_id = _branch_id)
    ORDER BY (b.branch_id IS NOT NULL) DESC, b.created_at DESC
    LIMIT 1;

    IF _budget_amount IS NOT NULL THEN
      SELECT COALESCE(SUM(
        CASE WHEN a2.account_type IN ('asset','expense') THEN jel.debit - jel.credit
             ELSE jel.credit - jel.debit END
      ), 0)
      INTO _actual_amount
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      JOIN public.accounts a2 ON a2.id = jel.account_id
      WHERE jel.account_id = _account_id
        AND je.organization_id = _org_id
        AND je.business_id = _business_id
        AND (_branch_id IS NULL OR je.branch_id = _branch_id)
        AND je.status = ANY (public.ledger_visible_journal_statuses())
        AND COALESCE(je.is_closing, false) = false
        AND COALESCE(je.is_closing_entry, false) = false
        AND COALESCE(je.is_opening_entry, false) = false
        AND COALESCE(je.is_sample_data, false) = false
        AND EXTRACT(YEAR FROM je.entry_date) = _fiscal_year
        AND EXTRACT(MONTH FROM je.entry_date) = _month;

      IF (_actual_amount + _amount) > _budget_amount THEN
        _result := _result || jsonb_build_object(
          'account_id', _account_id,
          'account_name', _account_name,
          'budget_name', _budget_name,
          'budgeted', _budget_amount,
          'actual_before', _actual_amount,
          'posting_amount', _amount,
          'projected_total', _actual_amount + _amount,
          'exceeded', true
        );
      END IF;
    END IF;
  END LOOP;

  RETURN _result;
END;
$function$;

REVOKE ALL ON FUNCTION public.check_budget_variance(uuid, uuid, uuid[], numeric[], date, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.check_budget_variance(uuid, uuid, uuid[], numeric[], date, uuid) TO authenticated;