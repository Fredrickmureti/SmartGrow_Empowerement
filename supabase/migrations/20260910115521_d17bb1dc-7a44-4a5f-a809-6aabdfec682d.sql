-- ============================================================
-- Fixed Assets: authoritative depreciation calculation + posting
-- ============================================================

-- 1) The single calculation authority. Pure function: no table access,
--    so preview and posting cannot diverge.
CREATE OR REPLACE FUNCTION public.fa_calc_period_depreciation(
  _method text,
  _base_cost numeric,
  _base_residual numeric,
  _useful_life_years integer,
  _depreciation_rate numeric,
  _prior_accumulated numeric,
  _dep_start date,
  _period_start date,
  _period_end date
) RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_cost        numeric := COALESCE(_base_cost, 0);
  v_residual    numeric := GREATEST(COALESCE(_base_residual, 0), 0);
  v_prior       numeric := GREATEST(COALESCE(_prior_accumulated, 0), 0);
  v_depreciable numeric;
  v_remaining   numeric;
  v_life        integer := COALESCE(_useful_life_years, 0);
  v_rate        numeric;
  v_monthly     numeric;
  v_eff_start   date;
  v_days        integer;
  v_month_days  integer;
  v_amount      numeric;
BEGIN
  IF _period_start IS NULL OR _period_end IS NULL OR _period_end < _period_start THEN
    RAISE EXCEPTION 'FA_INVALID_PERIOD: depreciation period is invalid';
  END IF;

  v_depreciable := GREATEST(v_cost - v_residual, 0);
  v_remaining   := v_depreciable - v_prior;
  IF v_remaining <= 0 THEN
    RETURN 0;                       -- fully depreciated / at residual floor
  END IF;

  IF _dep_start IS NULL OR _dep_start > _period_end THEN
    RETURN 0;                       -- not yet in service for this period
  END IF;

  v_eff_start  := GREATEST(_dep_start, _period_start);
  v_days       := (_period_end - v_eff_start) + 1;
  v_month_days := (_period_end - _period_start) + 1;
  IF v_days <= 0 OR v_month_days <= 0 THEN
    RETURN 0;
  END IF;

  IF _method = 'straight_line' THEN
    IF v_life <= 0 THEN
      RAISE EXCEPTION 'FA_INVALID_USEFUL_LIFE: straight-line depreciation requires a useful life of at least one year'
        USING ERRCODE = '22023';
    END IF;
    v_monthly := v_depreciable / (v_life * 12);

  ELSIF _method IN ('reducing_balance', 'declining_balance') THEN
    v_rate := COALESCE(_depreciation_rate, CASE WHEN v_life > 0 THEN 100::numeric / v_life ELSE NULL END);
    IF v_rate IS NULL OR v_rate <= 0 THEN
      RAISE EXCEPTION 'FA_INVALID_DEPRECIATION_RATE: reducing-balance depreciation requires a positive rate or useful life'
        USING ERRCODE = '22023';
    END IF;
    v_monthly := ((v_cost - v_prior) * (v_rate / 100)) / 12;

  ELSE
    RAISE EXCEPTION 'FA_UNSUPPORTED_METHOD: depreciation method % is not supported', _method
      USING ERRCODE = '22023';
  END IF;

  v_amount := ROUND(v_monthly * v_days::numeric / v_month_days::numeric, 2);
  RETURN LEAST(GREATEST(v_amount, 0), ROUND(v_remaining, 2));
END;
$function$;

REVOKE ALL ON FUNCTION public.fa_calc_period_depreciation(text, numeric, numeric, integer, numeric, numeric, date, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fa_calc_period_depreciation(text, numeric, numeric, integer, numeric, numeric, date, date, date) TO authenticated, service_role;

-- 2) Read-only preview. Writes nothing.
CREATE OR REPLACE FUNCTION public.fa_depreciation_plan(
  _business_id uuid,
  _period_date date,
  _branch_id uuid DEFAULT NULL
) RETURNS TABLE (
  asset_id uuid,
  asset_number text,
  asset_name text,
  category_id uuid,
  category_name text,
  method text,
  base_cost numeric,
  base_residual numeric,
  useful_life_years integer,
  depreciation_rate numeric,
  depreciation_start_date date,
  prior_accumulated numeric,
  period_start date,
  period_end date,
  depreciation_amount numeric,
  remaining_depreciable numeric,
  expense_account_id uuid,
  accumulated_account_id uuid,
  business_id uuid,
  branch_id uuid,
  already_posted boolean,
  blocker text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid;
  v_ps  date := date_trunc('month', _period_date)::date;
  v_pe  date := (date_trunc('month', _period_date) + interval '1 month - 1 day')::date;
BEGIN
  PERFORM public.assert_can_manage_assets(_business_id);

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = _business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'FA_UNKNOWN_BUSINESS: business % not found', _business_id;
  END IF;

  RETURN QUERY
  WITH src AS (
    SELECT
      a.id,
      a.asset_number,
      a.name,
      a.category_id,
      c.name AS category_name,
      COALESCE(a.depreciation_method, c.depreciation_method, 'straight_line') AS method,
      COALESCE(a.base_purchase_price, a.purchase_price, 0)                    AS base_cost,
      COALESCE(a.base_residual_value, a.residual_value, 0)                    AS base_residual,
      COALESCE(a.useful_life_years, c.useful_life_years)                      AS useful_life_years,
      c.depreciation_rate,
      COALESCE(a.depreciation_start_date, a.purchase_date)                    AS dep_start,
      COALESCE(a.accumulated_depreciation, 0)                                 AS prior_accumulated,
      a.business_id,
      a.branch_id,
      COALESCE(c.depreciation_account_id,
               public.get_default_account_id(v_org, a.business_id, 'depreciation_expense'))            AS expense_account_id,
      COALESCE(c.accumulated_depreciation_account_id,
               public.get_default_account_id(v_org, a.business_id, 'accumulated_depreciation'))        AS accumulated_account_id,
      EXISTS (
        SELECT 1 FROM public.depreciation_schedules ds
         WHERE ds.asset_id = a.id AND ds.period_start = v_ps AND COALESCE(ds.is_posted, false)
      ) AS already_posted
    FROM public.fixed_assets a
    LEFT JOIN public.asset_categories c ON c.id = a.category_id
    WHERE a.business_id = _business_id
      AND a.organization_id = v_org
      AND a.status = 'active'
      AND (_branch_id IS NULL OR a.branch_id = _branch_id)
  )
  SELECT
    s.id, s.asset_number, s.name, s.category_id, s.category_name, s.method,
    s.base_cost, s.base_residual, s.useful_life_years, s.depreciation_rate,
    s.dep_start, s.prior_accumulated, v_ps, v_pe,
    CASE
      WHEN s.method = 'straight_line' AND COALESCE(s.useful_life_years, 0) <= 0 THEN 0
      WHEN s.method NOT IN ('straight_line', 'reducing_balance', 'declining_balance') THEN 0
      ELSE public.fa_calc_period_depreciation(
             s.method, s.base_cost, s.base_residual, s.useful_life_years,
             s.depreciation_rate, s.prior_accumulated, s.dep_start, v_ps, v_pe)
    END AS depreciation_amount,
    GREATEST(GREATEST(s.base_cost - s.base_residual, 0) - s.prior_accumulated, 0) AS remaining_depreciable,
    s.expense_account_id, s.accumulated_account_id, s.business_id, s.branch_id,
    s.already_posted,
    CASE
      WHEN s.already_posted THEN 'ALREADY_POSTED'
      WHEN s.method NOT IN ('straight_line', 'reducing_balance', 'declining_balance') THEN 'UNSUPPORTED_METHOD'
      WHEN s.method = 'straight_line' AND COALESCE(s.useful_life_years, 0) <= 0 THEN 'INVALID_USEFUL_LIFE'
      WHEN s.expense_account_id IS NULL OR s.accumulated_account_id IS NULL THEN 'MISSING_GL_MAPPING'
      WHEN s.dep_start IS NULL OR s.dep_start > v_pe THEN 'NOT_IN_SERVICE'
      WHEN GREATEST(s.base_cost - s.base_residual, 0) - s.prior_accumulated <= 0 THEN 'FULLY_DEPRECIATED'
      ELSE NULL
    END AS blocker
  FROM src s
  ORDER BY s.asset_number;
END;
$function$;

REVOKE ALL ON FUNCTION public.fa_depreciation_plan(uuid, date, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fa_depreciation_plan(uuid, date, uuid) TO authenticated, service_role;

-- 3) Authoritative posting. Accepts NO amount from the caller.
CREATE OR REPLACE FUNCTION public.fa_post_depreciation(
  _business_id uuid,
  _period_date date,
  _branch_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org      uuid;
  v_ps       date := date_trunc('month', _period_date)::date;
  v_pe       date := (date_trunc('month', _period_date) + interval '1 month - 1 day')::date;
  v_actor    uuid := auth.uid();
  r          record;
  v_amount   numeric;
  v_je       uuid;
  v_accum    numeric;
  v_book     numeric;
  v_posted   integer := 0;
  v_skipped  integer := 0;
  v_total    numeric := 0;
  v_errors   jsonb := '[]'::jsonb;
  v_entries  jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.assert_can_manage_assets(_business_id);

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = _business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'FA_UNKNOWN_BUSINESS: business % not found', _business_id;
  END IF;

  IF public.is_period_locked(v_org, _business_id, v_pe) THEN
    RAISE EXCEPTION 'FA_PERIOD_CLOSED: the fiscal period containing % is closed; depreciation cannot be posted', v_pe
      USING ERRCODE = '22023';
  END IF;

  -- Serialise concurrent runs for this business + period.
  PERFORM pg_advisory_xact_lock(hashtext('fa_depreciation_' || _business_id::text || '_' || v_ps::text));

  FOR r IN
    SELECT * FROM public.fa_depreciation_plan(_business_id, _period_date, _branch_id)
  LOOP
    -- Lock the asset row so its balances cannot be updated underneath us.
    PERFORM 1 FROM public.fixed_assets WHERE id = r.asset_id FOR UPDATE;

    IF r.blocker = 'ALREADY_POSTED' THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    IF r.blocker IN ('MISSING_GL_MAPPING', 'INVALID_USEFUL_LIFE', 'UNSUPPORTED_METHOD') THEN
      v_errors := v_errors || jsonb_build_object('asset_number', r.asset_number, 'reason', r.blocker);
      CONTINUE;
    END IF;

    -- Recompute here from authoritative inputs; the plan value is only advisory.
    v_amount := public.fa_calc_period_depreciation(
      r.method, r.base_cost, r.base_residual, r.useful_life_years,
      r.depreciation_rate, r.prior_accumulated, r.depreciation_start_date, v_ps, v_pe);

    IF v_amount IS NULL OR v_amount <= 0 THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_accum := ROUND(r.prior_accumulated + v_amount, 2);
    v_book  := GREATEST(ROUND(r.base_cost - v_accum, 2), r.base_residual);

    v_je := public.post_journal_entry_atomic(
      _org_id          => v_org,
      _business_id     => _business_id,
      _entry_number    => public.get_next_journal_entry_number(v_org),
      _entry_date      => v_pe,
      _reference       => 'DEP-' || r.asset_number || '-' || to_char(v_ps, 'YYYY-MM'),
      _description     => 'Depreciation ' || to_char(v_ps, 'Mon YYYY') || ': ' || r.asset_name,
      _source_type     => 'depreciation',
      _source_id       => r.asset_id,
      _created_by      => v_actor,
      _is_closing      => false,
      _is_adjusting    => false,
      _lines           => jsonb_build_array(
        jsonb_build_object('account_id', r.expense_account_id, 'debit', v_amount, 'credit', 0,
                           'description', 'Depreciation expense - ' || r.asset_name),
        jsonb_build_object('account_id', r.accumulated_account_id, 'debit', 0, 'credit', v_amount,
                           'description', 'Accumulated depreciation - ' || r.asset_name)
      ),
      _currency        => NULL,
      _exchange_rate   => NULL,
      -- Per-period subtype: without it the ledger's source idempotency would
      -- return January's entry for every later month of the same asset.
      _source_subtype  => to_char(v_ps, 'YYYY-MM'),
      _branch_id       => r.branch_id
    );

    IF v_je IS NULL THEN
      v_errors := v_errors || jsonb_build_object('asset_number', r.asset_number, 'reason', 'JOURNAL_POSTING_FAILED');
      CONTINUE;
    END IF;

    BEGIN
      INSERT INTO public.depreciation_schedules (
        organization_id, business_id, branch_id, asset_id,
        period_start, period_end, depreciation_amount,
        accumulated_depreciation, book_value,
        journal_entry_id, is_posted, posted_at, posted_by
      ) VALUES (
        v_org, _business_id, r.branch_id, r.asset_id,
        v_ps, v_pe, v_amount, v_accum, v_book,
        v_je, true, now(), v_actor
      );
    EXCEPTION WHEN unique_violation THEN
      -- Concurrent run won the race; nothing further to do for this asset.
      v_skipped := v_skipped + 1;
      CONTINUE;
    END;

    UPDATE public.fixed_assets
       SET accumulated_depreciation = v_accum,
           book_value = v_book,
           updated_at = now()
     WHERE id = r.asset_id;

    v_posted  := v_posted + 1;
    v_total   := v_total + v_amount;
    v_entries := v_entries || jsonb_build_object(
      'asset_id', r.asset_id, 'asset_number', r.asset_number,
      'amount', v_amount, 'journal_entry_id', v_je,
      'accumulated_depreciation', v_accum, 'book_value', v_book);
  END LOOP;

  RETURN jsonb_build_object(
    'period_start', v_ps,
    'period_end', v_pe,
    'posted', v_posted,
    'skipped', v_skipped,
    'total_amount', v_total,
    'entries', v_entries,
    'errors', v_errors
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fa_post_depreciation(uuid, date, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fa_post_depreciation(uuid, date, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fa_post_depreciation(uuid, date, uuid) IS
  'Authoritative fixed-asset depreciation posting. Takes no amount from the caller: recalculates via fa_calc_period_depreciation, enforces permission, fiscal-period lock, GL mappings and per-asset/period idempotency, and posts through post_journal_entry_atomic.';