-- ---------------------------------------------------------------------------
-- fa_post_depreciation: same authoritative calculation, hardened event write.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fa_post_depreciation(_business_id uuid, _period_date date, _branch_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
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
  v_cnt      integer;
  v_posted   integer := 0;
  v_skipped  integer := 0;
  v_total    numeric := 0;
  v_errors   jsonb := '[]'::jsonb;
  v_entries  jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.assert_can_manage_assets(_business_id);

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'FA_AUTH_REQUIRED: an authenticated user is required to post depreciation' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = _business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'FA_UNKNOWN_BUSINESS: business % not found', _business_id;
  END IF;

  IF _branch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.branches b WHERE b.id = _branch_id AND b.business_id = _business_id
  ) THEN
    RAISE EXCEPTION 'FA_BRANCH_SCOPE: branch % does not belong to business %', _branch_id, _business_id USING ERRCODE = '22023';
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
    PERFORM 1 FROM public.fixed_assets WHERE id = r.asset_id FOR UPDATE;

    IF r.blocker = 'ALREADY_POSTED' THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    IF r.blocker IN ('MISSING_GL_MAPPING', 'INVALID_USEFUL_LIFE', 'UNSUPPORTED_METHOD') THEN
      v_errors := v_errors || jsonb_build_object('asset_number', r.asset_number, 'reason', r.blocker);
      CONTINUE;
    END IF;

    -- Recompute from authoritative inputs; the caller supplies no amount.
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
      _source_subtype  => to_char(v_ps, 'YYYY-MM'),
      _branch_id       => r.branch_id,
      _is_opening_entry => false,
      _amounts_in_document_currency => NULL
    );

    IF v_je IS NULL THEN
      RAISE EXCEPTION 'FA_JOURNAL_POSTING_FAILED: the ledger refused the depreciation entry for %', r.asset_number;
    END IF;

    -- One event per asset + month. A projected (unposted) row is finalised in
    -- place; a posted row must never be overwritten — abort the whole run so
    -- the journal above is rolled back with it.
    INSERT INTO public.depreciation_schedules (
      organization_id, business_id, branch_id, asset_id,
      period_start, period_end, depreciation_amount,
      accumulated_depreciation, book_value,
      journal_entry_id, is_posted, posted_at, posted_by
    ) VALUES (
      v_org, _business_id, r.branch_id, r.asset_id,
      v_ps, v_pe, v_amount, v_accum, v_book,
      v_je, true, now(), v_actor
    )
    ON CONFLICT (asset_id, period_start) DO UPDATE
      SET business_id = EXCLUDED.business_id,
          branch_id = EXCLUDED.branch_id,
          period_end = EXCLUDED.period_end,
          depreciation_amount = EXCLUDED.depreciation_amount,
          accumulated_depreciation = EXCLUDED.accumulated_depreciation,
          book_value = EXCLUDED.book_value,
          journal_entry_id = EXCLUDED.journal_entry_id,
          is_posted = true,
          posted_at = now(),
          posted_by = EXCLUDED.posted_by
      WHERE COALESCE(depreciation_schedules.is_posted, false) = false;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    IF v_cnt = 0 THEN
      RAISE EXCEPTION 'FA_DUPLICATE_DEPRECIATION: % already has posted depreciation for %', r.asset_number, to_char(v_ps, 'YYYY-MM')
        USING ERRCODE = '23505';
    END IF;

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

-- ---------------------------------------------------------------------------
-- fa_create_asset: asset row + acquisition journal in one transaction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fa_create_asset(_business_id uuid, _asset jsonb, _payment_method text DEFAULT 'bank')
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org        uuid;
  v_actor      uuid := auth.uid();
  v_cat        public.asset_categories%ROWTYPE;
  v_row        public.fixed_assets%ROWTYPE;
  v_num        text;
  v_branch     uuid := NULLIF(_asset->>'branch_id', '')::uuid;
  v_cat_id     uuid := NULLIF(_asset->>'category_id', '')::uuid;
  v_pdate      date := NULLIF(_asset->>'purchase_date', '')::date;
  v_price      numeric := NULLIF(_asset->>'purchase_price', '')::numeric;
  v_pay_key    text;
  v_asset_acct uuid;
  v_pay_acct   uuid;
  v_je         uuid;
BEGIN
  PERFORM public.assert_can_manage_assets(_business_id);

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'FA_AUTH_REQUIRED: an authenticated user is required to create an asset' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = _business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'FA_UNKNOWN_BUSINESS: business % not found', _business_id;
  END IF;

  IF COALESCE(_asset->>'name', '') = '' THEN
    RAISE EXCEPTION 'FA_NAME_REQUIRED: an asset name is required' USING ERRCODE = '22023';
  END IF;
  IF v_pdate IS NULL THEN
    RAISE EXCEPTION 'FA_PURCHASE_DATE_REQUIRED: a purchase date is required' USING ERRCODE = '22023';
  END IF;
  IF v_price IS NULL OR v_price <= 0 THEN
    RAISE EXCEPTION 'FA_INVALID_COST: the purchase price must be greater than zero' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(NULLIF(_asset->>'residual_value', '')::numeric, 0) < 0
     OR COALESCE(NULLIF(_asset->>'residual_value', '')::numeric, 0) >= v_price THEN
    RAISE EXCEPTION 'FA_INVALID_RESIDUAL: the residual value must be between zero and the purchase price' USING ERRCODE = '22023';
  END IF;

  IF v_cat_id IS NOT NULL THEN
    SELECT * INTO v_cat FROM public.asset_categories
     WHERE id = v_cat_id AND business_id = _business_id AND organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'FA_UNKNOWN_CATEGORY: asset category % does not belong to this company', v_cat_id USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_branch IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.branches b WHERE b.id = v_branch AND b.business_id = _business_id
  ) THEN
    RAISE EXCEPTION 'FA_BRANCH_SCOPE: branch % does not belong to business %', v_branch, _business_id USING ERRCODE = '22023';
  END IF;

  IF public.is_period_locked(v_org, _business_id, v_pdate) THEN
    RAISE EXCEPTION 'FA_PERIOD_CLOSED: the fiscal period containing % is closed; the acquisition cannot be posted', v_pdate
      USING ERRCODE = '22023';
  END IF;

  v_pay_key := CASE lower(COALESCE(_payment_method, 'bank'))
                 WHEN 'cash' THEN 'cash'
                 WHEN 'petty_cash' THEN 'cash'
                 WHEN 'mobile_money' THEN 'mobile_money'
                 WHEN 'mpesa' THEN 'mobile_money'
                 ELSE 'bank'
               END;
  v_asset_acct := COALESCE(v_cat.asset_account_id, public.get_default_account_id(v_org, _business_id, 'fixed_asset'));
  v_pay_acct   := public.get_default_account_id(v_org, _business_id, v_pay_key);
  IF v_asset_acct IS NULL OR v_pay_acct IS NULL THEN
    RAISE EXCEPTION 'FA_MISSING_GL_MAPPING: the fixed-asset account and the % settlement account must be mapped before an asset can be capitalised', v_pay_key
      USING ERRCODE = '22023';
  END IF;

  v_num := public.get_next_asset_number(v_org);

  INSERT INTO public.fixed_assets (
    organization_id, business_id, branch_id, asset_number, name, description, category_id,
    purchase_date, purchase_price, currency, residual_value, useful_life_years, depreciation_method,
    depreciation_start_date, serial_number, location, vendor_id, invoice_reference, assigned_to,
    barcode, insurance_value, insurance_policy, insurance_expiry, warranty_expiry, notes,
    accumulated_depreciation, status, created_by
  ) VALUES (
    v_org, _business_id, v_branch, v_num, _asset->>'name', NULLIF(_asset->>'description', ''), v_cat_id,
    v_pdate, v_price, NULLIF(_asset->>'currency', ''),
    COALESCE(NULLIF(_asset->>'residual_value', '')::numeric, 0),
    COALESCE(NULLIF(_asset->>'useful_life_years', '')::integer, v_cat.useful_life_years, 5),
    COALESCE(NULLIF(_asset->>'depreciation_method', ''), v_cat.depreciation_method, 'straight_line'),
    NULLIF(_asset->>'depreciation_start_date', '')::date,
    NULLIF(_asset->>'serial_number', ''), NULLIF(_asset->>'location', ''),
    NULLIF(_asset->>'vendor_id', '')::uuid, NULLIF(_asset->>'invoice_reference', ''),
    NULLIF(_asset->>'assigned_to', '')::uuid,
    NULLIF(_asset->>'barcode', ''), NULLIF(_asset->>'insurance_value', '')::numeric,
    NULLIF(_asset->>'insurance_policy', ''), NULLIF(_asset->>'insurance_expiry', '')::date,
    NULLIF(_asset->>'warranty_expiry', '')::date, NULLIF(_asset->>'notes', ''),
    0, 'active', v_actor
  )
  RETURNING * INTO v_row;

  -- Re-read: the currency trigger stamps the base-currency cost the ledger uses.
  SELECT * INTO v_row FROM public.fixed_assets WHERE id = v_row.id;

  v_je := public.post_journal_entry_atomic(
    _org_id          => v_org,
    _business_id     => _business_id,
    _entry_number    => public.get_next_journal_entry_number(v_org),
    _entry_date      => v_row.purchase_date,
    _reference       => v_num,
    _description     => 'Fixed asset acquisition: ' || v_row.name,
    _source_type     => 'asset_acquisition',
    _source_id       => v_row.id,
    _created_by      => v_actor,
    _is_closing      => false,
    _is_adjusting    => false,
    _lines           => jsonb_build_array(
      jsonb_build_object('account_id', v_asset_acct, 'debit', v_row.base_purchase_price, 'credit', 0,
                         'description', 'Asset acquisition - ' || v_row.name),
      jsonb_build_object('account_id', v_pay_acct, 'debit', 0, 'credit', v_row.base_purchase_price,
                         'description', 'Payment for asset - ' || v_num)
    ),
    _currency        => NULL,
    _exchange_rate   => NULL,
    _source_subtype  => NULL,
    _branch_id       => v_row.branch_id,
    _is_opening_entry => false,
    _amounts_in_document_currency => NULL
  );

  IF v_je IS NULL THEN
    RAISE EXCEPTION 'FA_ACQUISITION_POSTING_FAILED: the ledger refused the acquisition entry for %', v_num;
  END IF;

  RETURN to_jsonb(v_row) || jsonb_build_object('journal_entry_id', v_je);
END;
$function$;

REVOKE ALL ON FUNCTION public.fa_create_asset(uuid, jsonb, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fa_create_asset(uuid, jsonb, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fa_post_depreciation(uuid, date, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fa_post_depreciation(uuid, date, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fa_depreciation_plan(uuid, date, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fa_depreciation_plan(uuid, date, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Depreciation events are written only by the server routines from now on.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS depreciation_schedules_insert_perm_v3 ON public.depreciation_schedules;
DROP POLICY IF EXISTS depreciation_schedules_update_perm_v3 ON public.depreciation_schedules;
DROP POLICY IF EXISTS depreciation_schedules_delete_perm_v3 ON public.depreciation_schedules;
REVOKE INSERT, UPDATE, DELETE ON public.depreciation_schedules FROM authenticated, anon;