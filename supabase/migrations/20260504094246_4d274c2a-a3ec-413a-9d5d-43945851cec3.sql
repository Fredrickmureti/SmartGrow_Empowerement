
-- =========================================================================
-- Dashboard scope enforcement (Phase 7 — backend layer)
-- Adds: permission helper, scope-assertion helper, and three scoped RPCs
--       (get_dashboard_stats, get_dashboard_activity, get_executive_stats).
-- Additive only: no existing table or function is dropped or renamed.
-- =========================================================================

-- -----------------------------------------------------------------------
-- 1. Permission helper -- mirrors has_finance_permission shape
-- -----------------------------------------------------------------------
-- Permissions we recognize:
--   dashboard.view_branch        -- view a branch dashboard you are assigned to
--   dashboard.view_hq            -- view the HQ branch dashboard
--   dashboard.view_consolidated  -- view "All Branches (Consolidated)"
--   dashboard.view_executive     -- view org-wide multi-business overview
CREATE OR REPLACE FUNCTION public.has_dashboard_permission(
  _user_id      uuid,
  _perm         text,
  _business_id  uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ctx AS (
    SELECT
      -- Org-level admin/owner of the business's org
      EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = _user_id
          AND ur.is_active = true
          AND ur.role IN ('super_admin','owner','admin')
          AND (_business_id IS NULL OR ur.organization_id IN (
            SELECT organization_id FROM public.businesses WHERE id = _business_id
          ))
      ) AS is_admin,
      -- Accountant scope (sees consolidated finance numbers)
      EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = _user_id
          AND ur.is_active = true
          AND ur.role = 'accountant'
          AND (_business_id IS NULL OR ur.organization_id IN (
            SELECT organization_id FROM public.businesses WHERE id = _business_id
          ))
      ) AS is_accountant
  )
  SELECT CASE
    WHEN _perm = 'dashboard.view_branch' THEN
      -- Anyone with a role in the org can view a branch they're assigned to
      EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = _user_id AND ur.is_active = true
          AND (_business_id IS NULL OR ur.organization_id IN (
            SELECT organization_id FROM public.businesses WHERE id = _business_id
          ))
      )
    WHEN _perm = 'dashboard.view_hq' THEN
      -- HQ visibility goes to admins/owners and accountants
      (SELECT is_admin OR is_accountant FROM ctx)
    WHEN _perm = 'dashboard.view_consolidated' THEN
      -- Consolidated view requires admin/owner OR accountant
      (SELECT is_admin OR is_accountant FROM ctx)
    WHEN _perm = 'dashboard.view_executive' THEN
      -- Org-wide multi-business view: admin/owner only
      (SELECT is_admin FROM ctx)
    ELSE false
  END;
$$;

GRANT EXECUTE ON FUNCTION public.has_dashboard_permission(uuid, text, uuid) TO authenticated;

-- -----------------------------------------------------------------------
-- 2. Scope assertion -- raises 42501 on violation
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_can_view_dashboard_scope(
  _business_id uuid,
  _branch_id   uuid,
  _kind        text  -- 'branch_only' | 'all_branches' | 'business_only' | 'executive'
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_is_hq     boolean := false;
  v_assigned  boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF _kind NOT IN ('branch_only','all_branches','business_only','executive') THEN
    RAISE EXCEPTION 'Unknown dashboard scope: %', _kind USING ERRCODE = '22023';
  END IF;

  IF _kind = 'executive' THEN
    IF NOT public.has_dashboard_permission(v_uid, 'dashboard.view_executive', _business_id) THEN
      RAISE EXCEPTION 'INSUFFICIENT_PRIVILEGE_DASHBOARD_EXECUTIVE'
        USING ERRCODE = '42501';
    END IF;
    RETURN;
  END IF;

  IF _business_id IS NULL THEN
    RAISE EXCEPTION 'business_id is required for non-executive dashboard scopes'
      USING ERRCODE = '22023';
  END IF;

  IF _kind = 'all_branches' THEN
    IF NOT public.has_dashboard_permission(v_uid, 'dashboard.view_consolidated', _business_id) THEN
      RAISE EXCEPTION 'INSUFFICIENT_PRIVILEGE_DASHBOARD_CONSOLIDATED'
        USING ERRCODE = '42501';
    END IF;
    RETURN;
  END IF;

  IF _kind = 'business_only' THEN
    -- Business has zero branches; anyone with dashboard.view_branch can see it
    IF NOT public.has_dashboard_permission(v_uid, 'dashboard.view_branch', _business_id) THEN
      RAISE EXCEPTION 'INSUFFICIENT_PRIVILEGE_DASHBOARD_BUSINESS'
        USING ERRCODE = '42501';
    END IF;
    RETURN;
  END IF;

  -- branch_only path
  IF _branch_id IS NULL THEN
    RAISE EXCEPTION 'branch_id is required for branch_only dashboard scope'
      USING ERRCODE = '22023';
  END IF;

  -- Is this the HQ branch?
  SELECT b.is_headquarters INTO v_is_hq
  FROM public.branches b
  WHERE b.id = _branch_id AND b.business_id = _business_id;

  IF v_is_hq IS NULL THEN
    RAISE EXCEPTION 'Branch % not found in business %', _branch_id, _business_id
      USING ERRCODE = '22023';
  END IF;

  IF v_is_hq THEN
    IF NOT public.has_dashboard_permission(v_uid, 'dashboard.view_hq', _business_id) THEN
      RAISE EXCEPTION 'INSUFFICIENT_PRIVILEGE_DASHBOARD_HQ'
        USING ERRCODE = '42501';
    END IF;
    RETURN;
  END IF;

  -- Non-HQ branch: must be an admin OR explicitly assigned
  SELECT EXISTS (
    SELECT 1 FROM public.user_branch_assignments uba
    WHERE uba.user_id = v_uid
      AND uba.branch_id = _branch_id
      AND uba.business_id = _business_id
      AND uba.can_view = true
  ) INTO v_assigned;

  IF v_assigned OR public.is_org_admin_or_owner(v_uid, (
    SELECT organization_id FROM public.businesses WHERE id = _business_id
  )) THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'INSUFFICIENT_PRIVILEGE_DASHBOARD_BRANCH'
    USING ERRCODE = '42501';
END;
$$;

GRANT EXECUTE ON FUNCTION public.assert_can_view_dashboard_scope(uuid, uuid, text) TO authenticated;

-- -----------------------------------------------------------------------
-- 3. get_dashboard_stats -- scoped totals + 6-month series + outstanding
-- -----------------------------------------------------------------------
-- Behavior:
--   _kind = 'branch_only'   -> filter every transactional table by branch_id
--   _kind = 'all_branches'  -> no branch filter, business-level
--   _kind = 'business_only' -> no branch filter (business has no branches)
-- Revenue/expense come from posted journal entries (consistent with COA).
CREATE OR REPLACE FUNCTION public.get_dashboard_stats(
  _business_id  uuid,
  _branch_id    uuid,
  _kind         text,
  _from         date,
  _to           date,
  _monthly_from date  -- usually first day of (now - 5 months)
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_total_rev numeric := 0;
  v_total_exp numeric := 0;
  v_period_rev numeric := 0;
  v_period_exp numeric := 0;
  v_outstanding_amount numeric := 0;
  v_outstanding_count integer := 0;
  v_monthly jsonb;
BEGIN
  PERFORM public.assert_can_view_dashboard_scope(_business_id, _branch_id, _kind);

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = _business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Business not found' USING ERRCODE = '22023';
  END IF;

  -- All-time revenue/expense (posted JE only)
  SELECT
    COALESCE(SUM(CASE WHEN a.account_type = 'revenue' THEN jel.credit - jel.debit ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN a.account_type = 'expense' THEN jel.debit - jel.credit ELSE 0 END), 0)
  INTO v_total_rev, v_total_exp
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.accounts a ON a.id = jel.account_id
  WHERE je.organization_id = v_org
    AND je.business_id = _business_id
    AND je.status = 'posted'
    AND (_kind <> 'branch_only' OR jel.branch_id = _branch_id);

  -- Outstanding invoices (current period scope is "all open")
  SELECT COALESCE(SUM(i.total - i.amount_paid), 0), COUNT(*)
  INTO v_outstanding_amount, v_outstanding_count
  FROM public.invoices i
  WHERE i.organization_id = v_org
    AND i.business_id = _business_id
    AND i.status IN ('sent','viewed','partial','overdue','confirmed')
    AND (_kind <> 'branch_only' OR i.branch_id = _branch_id);

  -- 6-month series, scoped
  WITH months AS (
    SELECT generate_series(
      date_trunc('month', _monthly_from)::date,
      date_trunc('month', _to)::date,
      interval '1 month'
    )::date AS month_start
  ),
  je_scoped AS (
    SELECT je.entry_date, jel.debit, jel.credit, a.account_type
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.accounts a ON a.id = jel.account_id
    WHERE je.organization_id = v_org
      AND je.business_id = _business_id
      AND je.status = 'posted'
      AND je.entry_date >= _monthly_from
      AND je.entry_date <= _to
      AND (_kind <> 'branch_only' OR jel.branch_id = _branch_id)
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'month',    to_char(m.month_start, 'Mon'),
      'revenue',  COALESCE(SUM(CASE WHEN js.account_type = 'revenue'
                                    THEN js.credit - js.debit ELSE 0 END), 0),
      'expenses', COALESCE(SUM(CASE WHEN js.account_type = 'expense'
                                    THEN js.debit - js.credit ELSE 0 END), 0)
    ) ORDER BY m.month_start
  )
  INTO v_monthly
  FROM months m
  LEFT JOIN je_scoped js
    ON date_trunc('month', js.entry_date) = m.month_start
  GROUP BY m.month_start
  ORDER BY m.month_start;

  RETURN jsonb_build_object(
    'scope_kind',          _kind,
    'business_id',         _business_id,
    'branch_id',           _branch_id,
    'total_revenue',       v_total_rev,
    'total_expenses',      v_total_exp,
    'net_profit',          v_total_rev - v_total_exp,
    'outstanding_amount',  v_outstanding_amount,
    'outstanding_count',   v_outstanding_count,
    'monthly',             COALESCE(v_monthly, '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_dashboard_stats(uuid, uuid, text, date, date, date) TO authenticated;

-- -----------------------------------------------------------------------
-- 4. get_dashboard_activity -- scoped recent activity feed
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_dashboard_activity(
  _business_id uuid,
  _branch_id   uuid,
  _kind        text,
  _limit       integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_rows jsonb;
BEGIN
  PERFORM public.assert_can_view_dashboard_scope(_business_id, _branch_id, _kind);

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = _business_id;

  WITH inv AS (
    SELECT i.id::text AS id, 'invoice'::text AS type,
           ('Invoice ' || i.invoice_number || ' to ' || COALESCE(c.name, 'customer')) AS description,
           i.total AS amount, i.issue_date::timestamptz AS occurred_at,
           i.branch_id
    FROM public.invoices i
    LEFT JOIN public.contacts c ON c.id = i.contact_id
    WHERE i.organization_id = v_org AND i.business_id = _business_id
      AND (_kind <> 'branch_only' OR i.branch_id = _branch_id)
    ORDER BY i.issue_date DESC LIMIT _limit
  ),
  pay AS (
    SELECT p.id::text, 'payment',
           ('Payment received for ' || COALESCE(i.invoice_number, 'invoice')),
           p.amount, p.payment_date::timestamptz, p.branch_id
    FROM public.payments p
    LEFT JOIN public.invoices i ON i.id = p.invoice_id
    WHERE p.organization_id = v_org AND p.business_id = _business_id
      AND (_kind <> 'branch_only' OR p.branch_id = _branch_id)
    ORDER BY p.payment_date DESC LIMIT _limit
  ),
  exp AS (
    SELECT e.id::text, 'expense', e.description, e.amount, e.expense_date::timestamptz, e.branch_id
    FROM public.expenses e
    WHERE e.organization_id = v_org AND e.business_id = _business_id
      AND (_kind <> 'branch_only' OR e.branch_id = _branch_id)
    ORDER BY e.expense_date DESC LIMIT _limit
  ),
  bil AS (
    SELECT b.id::text, 'bill',
           ('Bill ' || b.bill_number || ' from ' || COALESCE(c.name, 'supplier')),
           b.total, b.bill_date::timestamptz, b.branch_id
    FROM public.bills b
    LEFT JOIN public.contacts c ON c.id = b.vendor_id
    WHERE b.organization_id = v_org AND b.business_id = _business_id
      AND (_kind <> 'branch_only' OR b.branch_id = _branch_id)
    ORDER BY b.bill_date DESC LIMIT _limit
  ),
  pos AS (
    SELECT t.id::text, 'payment',
           ('POS Sale ' || t.transaction_number),
           t.total, t.created_at, t.branch_id
    FROM public.pos_transactions t
    WHERE t.organization_id = v_org AND t.business_id = _business_id
      AND t.status = 'completed' AND t.invoice_id IS NULL
      AND (_kind <> 'branch_only' OR t.branch_id = _branch_id)
    ORDER BY t.created_at DESC LIMIT _limit
  ),
  unioned AS (
    SELECT * FROM inv UNION ALL SELECT * FROM pay UNION ALL
    SELECT * FROM exp UNION ALL SELECT * FROM bil UNION ALL SELECT * FROM pos
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', id, 'type', type, 'description', description,
      'amount', amount, 'date', occurred_at, 'branch_id', branch_id
    ) ORDER BY occurred_at DESC
  ), '[]'::jsonb)
  INTO v_rows
  FROM (SELECT * FROM unioned ORDER BY occurred_at DESC LIMIT _limit) s;

  RETURN jsonb_build_object(
    'scope_kind', _kind, 'business_id', _business_id, 'branch_id', _branch_id,
    'activity', COALESCE(v_rows, '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_dashboard_activity(uuid, uuid, text, integer) TO authenticated;

-- -----------------------------------------------------------------------
-- 5. get_executive_stats -- scoped exec KPIs (receivables/payables/cash)
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_executive_stats(
  _business_id uuid,
  _branch_id   uuid,
  _kind        text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_recv numeric := 0;
  v_pay  numeric := 0;
  v_cash numeric := 0;
  v_customers integer := 0;
  v_employees integer := 0;
BEGIN
  PERFORM public.assert_can_view_dashboard_scope(_business_id, _branch_id, _kind);
  SELECT organization_id INTO v_org FROM public.businesses WHERE id = _business_id;

  -- Receivables (open invoice balance)
  SELECT COALESCE(SUM(i.total - i.amount_paid), 0)
  INTO v_recv
  FROM public.invoices i
  WHERE i.organization_id = v_org AND i.business_id = _business_id
    AND i.status IN ('sent','viewed','partial','overdue','confirmed')
    AND (_kind <> 'branch_only' OR i.branch_id = _branch_id);

  -- Payables (open bill balance)
  SELECT COALESCE(SUM(b.total - b.amount_paid), 0)
  INTO v_pay
  FROM public.bills b
  WHERE b.organization_id = v_org AND b.business_id = _business_id
    AND b.status IN ('open','partial','overdue','approved','received')
    AND (_kind <> 'branch_only' OR b.branch_id = _branch_id);

  -- Cash position from posted JE on cash/bank accounts (business-level only;
  -- bank accounts are branch-scoped in the bank_accounts table separately,
  -- but COA cash balances are aggregate by business by design).
  SELECT COALESCE(SUM(jel.debit - jel.credit), 0)
  INTO v_cash
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.accounts a ON a.id = jel.account_id
  WHERE je.organization_id = v_org AND je.business_id = _business_id
    AND je.status = 'posted'
    AND a.account_type = 'asset'
    AND (a.detail_type IN ('bank','cash') OR a.cash_flow_category = 'operating')
    AND (_kind <> 'branch_only' OR jel.branch_id = _branch_id);

  -- Customer count (contacts table is business-level; branch_only returns
  -- customers who have at least one invoice in this branch).
  IF _kind = 'branch_only' THEN
    SELECT COUNT(DISTINCT i.contact_id)
    INTO v_customers
    FROM public.invoices i
    WHERE i.organization_id = v_org AND i.business_id = _business_id
      AND i.branch_id = _branch_id AND i.contact_id IS NOT NULL;
  ELSE
    SELECT COUNT(*)::int INTO v_customers
    FROM public.contacts c
    WHERE c.organization_id = v_org AND c.business_id = _business_id
      AND c.contact_type IN ('customer','both');
  END IF;

  -- Employees: business-level (HR is not branch-keyed in current schema).
  -- Returned as-is; UI labels this card "Business-level" in branch_only mode.
  BEGIN
    EXECUTE 'SELECT COUNT(*) FROM public.employees WHERE business_id = $1 AND ($2 OR true)'
      INTO v_employees USING _business_id, true;
  EXCEPTION WHEN undefined_table THEN
    v_employees := 0;
  END;

  RETURN jsonb_build_object(
    'scope_kind',     _kind,
    'business_id',    _business_id,
    'branch_id',      _branch_id,
    'receivables',    v_recv,
    'payables',       v_pay,
    'cash_position',  v_cash,
    'customer_count', v_customers,
    'employee_count', v_employees,
    'employee_scope', 'business' -- always business-level, see comment above
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_executive_stats(uuid, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.has_dashboard_permission(uuid, text, uuid) IS
  'Dashboard scope permissions: dashboard.view_branch / view_hq / view_consolidated / view_executive. See assert_can_view_dashboard_scope.';
COMMENT ON FUNCTION public.assert_can_view_dashboard_scope(uuid, uuid, text) IS
  'Raises 42501 if the current user is not allowed to view the requested dashboard scope. Used by get_dashboard_stats, get_dashboard_activity, get_executive_stats.';
