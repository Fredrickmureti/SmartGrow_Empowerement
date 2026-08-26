-- Brick 2: consolidated trial balance over a consolidation group.
-- No new accounting mathematics: balances come from get_ledger_opening_balances
-- and get_account_movements, the authoritative ledger engine. Both functions are
-- SECURITY INVOKER so the finance read checks inside those RPCs apply as the caller.

-- Total membership count as of a date, ignoring RLS. Used only to detect that RLS
-- hid a member from the caller, so the run can refuse instead of silently
-- narrowing the consolidation scope.
CREATE OR REPLACE FUNCTION public.consolidation_scope_member_count(_group_id uuid, _as_of date)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT count(*)::int
    FROM public.consolidation_group_members m
   WHERE m.group_id = _group_id
     AND m.effective_from <= _as_of
     AND (m.effective_to IS NULL OR m.effective_to >= _as_of);
$$;

REVOKE ALL ON FUNCTION public.consolidation_scope_member_count(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consolidation_scope_member_count(uuid, date) TO authenticated, service_role;

-- Resolve the consolidation scope as of a date: who is in, on what basis, and
-- what (if anything) blocks an honest consolidation today.
CREATE OR REPLACE FUNCTION public.resolve_consolidation_scope(_group_id uuid, _as_of date)
RETURNS TABLE(
  group_id uuid,
  group_name text,
  presentation_currency text,
  business_id uuid,
  business_name text,
  base_currency text,
  is_parent boolean,
  method public.consolidation_method,
  ownership_percent numeric,
  effective_from date,
  effective_to date,
  blocker text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_group public.consolidation_groups;
  v_visible int;
  v_total int;
BEGIN
  IF _group_id IS NULL OR _as_of IS NULL THEN
    RAISE EXCEPTION 'resolve_consolidation_scope: _group_id and _as_of are required';
  END IF;

  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found or not visible to you'
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::int INTO v_visible
    FROM public.consolidation_group_members m
   WHERE m.group_id = _group_id
     AND m.effective_from <= _as_of
     AND (m.effective_to IS NULL OR m.effective_to >= _as_of);

  v_total := public.consolidation_scope_member_count(_group_id, _as_of);

  IF v_visible = 0 THEN
    RAISE EXCEPTION 'Consolidation group % has no member companies as of %', v_group.name, _as_of;
  END IF;

  -- Never consolidate a partial scope: refuse the whole run.
  IF v_visible <> v_total THEN
    RAISE EXCEPTION 'You cannot access every company in group % as of % (% of % visible); consolidation refused',
      v_group.name, _as_of, v_visible, v_total
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    v_group.id,
    v_group.name,
    v_group.presentation_currency,
    b.id,
    b.name,
    b.base_currency,
    (b.id = v_group.parent_business_id) AS is_parent,
    m.method,
    m.ownership_percent,
    m.effective_from,
    m.effective_to,
    CASE
      WHEN m.method = 'equity' THEN 'equity_method_not_supported_yet'
      WHEN COALESCE(b.base_currency, '') = '' THEN 'member_has_no_base_currency'
      WHEN b.base_currency <> v_group.presentation_currency THEN 'currency_translation_required'
      WHEN m.ownership_percent IS NULL THEN 'ownership_percent_missing'
      ELSE NULL
    END AS blocker
  FROM public.consolidation_group_members m
  JOIN public.businesses b ON b.id = m.business_id
  WHERE m.group_id = _group_id
    AND m.effective_from <= _as_of
    AND (m.effective_to IS NULL OR m.effective_to >= _as_of)
  ORDER BY (b.id = v_group.parent_business_id) DESC, b.name;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_consolidation_scope(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_consolidation_scope(uuid, date) TO authenticated, service_role;

-- Consolidated trial balance: per member company, per account, from the
-- authoritative ledger engine only. Refuses on any scope blocker.
CREATE OR REPLACE FUNCTION public.get_consolidated_trial_balance(
  _group_id uuid,
  _date_from date,
  _date_to date
)
RETURNS TABLE(
  business_id uuid,
  business_name text,
  is_parent boolean,
  ownership_percent numeric,
  account_id uuid,
  account_code text,
  account_name text,
  account_type public.account_type,
  is_nominal boolean,
  opening_balance numeric,
  total_debit numeric,
  total_credit numeric,
  closing_balance numeric
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_org uuid;
  v_blocker text;
  v_member record;
BEGIN
  IF _group_id IS NULL OR _date_from IS NULL OR _date_to IS NULL THEN
    RAISE EXCEPTION 'get_consolidated_trial_balance: group and date range are required';
  END IF;
  IF _date_to < _date_from THEN
    RAISE EXCEPTION 'get_consolidated_trial_balance: date_to must not precede date_from';
  END IF;

  -- resolve_consolidation_scope enforces visibility of the group and of every
  -- member company; it raises when the scope cannot be resolved honestly.
  SELECT s.blocker INTO v_blocker
    FROM public.resolve_consolidation_scope(_group_id, _date_to) s
   WHERE s.blocker IS NOT NULL
   LIMIT 1;

  IF v_blocker IS NOT NULL THEN
    RAISE EXCEPTION 'Consolidation blocked: %', v_blocker;
  END IF;

  SELECT g.organization_id INTO v_org
    FROM public.consolidation_groups g WHERE g.id = _group_id;

  FOR v_member IN
    SELECT s.business_id, s.business_name, s.is_parent, s.ownership_percent
      FROM public.resolve_consolidation_scope(_group_id, _date_to) s
  LOOP
    RETURN QUERY
    WITH opening AS (
      SELECT o.account_id, o.opening_balance, o.is_nominal
        FROM public.get_ledger_opening_balances(v_org, v_member.business_id, _date_from, NULL) o
    ),
    movement AS (
      SELECT mv.account_id, mv.total_debit, mv.total_credit
        FROM public.get_account_movements(v_org, _date_from, _date_to, v_member.business_id, NULL) mv
    ),
    combined AS (
      SELECT COALESCE(o.account_id, mv.account_id) AS account_id,
             COALESCE(o.opening_balance, 0)        AS opening_balance,
             COALESCE(o.is_nominal, false)         AS is_nominal,
             COALESCE(mv.total_debit, 0)           AS total_debit,
             COALESCE(mv.total_credit, 0)          AS total_credit
        FROM opening o
        FULL JOIN movement mv ON mv.account_id = o.account_id
    )
    SELECT
      v_member.business_id,
      v_member.business_name,
      v_member.is_parent,
      v_member.ownership_percent,
      c.account_id,
      a.code,
      a.name,
      a.account_type,
      c.is_nominal,
      c.opening_balance,
      c.total_debit,
      c.total_credit,
      (c.opening_balance + c.total_debit - c.total_credit) AS closing_balance
    FROM combined c
    JOIN public.accounts a ON a.id = c.account_id
    WHERE a.organization_id = v_org
      AND (c.opening_balance <> 0 OR c.total_debit <> 0 OR c.total_credit <> 0);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.get_consolidated_trial_balance(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_consolidated_trial_balance(uuid, date, date) TO authenticated, service_role;