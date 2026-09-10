CREATE OR REPLACE FUNCTION public.fa_dispose_asset(
  _business_id uuid,
  _asset_id uuid,
  _disposal_date date,
  _disposal_price numeric DEFAULT 0,
  _reason text DEFAULT NULL,
  _payment_method text DEFAULT 'bank'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org        uuid;
  v_ccy        text;
  v_actor      uuid := auth.uid();
  v_row        public.fixed_assets%ROWTYPE;
  v_cat        public.asset_categories%ROWTYPE;
  v_asset_acct uuid;
  v_accum_acct uuid;
  v_pay_acct   uuid;
  v_gl_acct    uuid;
  v_pay_key    text;
  v_proceeds   numeric;
  v_cost       numeric;
  v_accum      numeric;
  v_book       numeric;
  v_gain       numeric;
  v_lines      jsonb;
  v_je         uuid;
BEGIN
  PERFORM public.assert_can_manage_assets(_business_id);

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'FA_AUTH_REQUIRED: an authenticated user is required to dispose an asset' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id, base_currency INTO v_org, v_ccy FROM public.businesses WHERE id = _business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'FA_UNKNOWN_BUSINESS: business % not found', _business_id;
  END IF;

  IF _disposal_date IS NULL THEN
    RAISE EXCEPTION 'FA_DISPOSAL_DATE_REQUIRED: a disposal date is required' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(_disposal_price, 0) < 0 THEN
    RAISE EXCEPTION 'FA_INVALID_PROCEEDS: disposal proceeds cannot be negative' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('fa_dispose_' || _asset_id::text));

  SELECT * INTO v_row FROM public.fixed_assets
   WHERE id = _asset_id AND business_id = _business_id AND organization_id = v_org
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FA_UNKNOWN_ASSET: asset % does not belong to this company', _asset_id USING ERRCODE = '22023';
  END IF;

  IF v_row.status = 'disposed' OR EXISTS (
    SELECT 1 FROM public.journal_entries je
     WHERE je.source_type = 'asset_disposal' AND je.source_id = _asset_id
       AND COALESCE(je.status, 'posted') <> 'voided'
  ) THEN
    RAISE EXCEPTION 'FA_ALREADY_DISPOSED: asset % has already been disposed', v_row.asset_number USING ERRCODE = '22023';
  END IF;

  IF _disposal_date < v_row.purchase_date THEN
    RAISE EXCEPTION 'FA_DISPOSAL_BEFORE_PURCHASE: the disposal date cannot precede the purchase date' USING ERRCODE = '22023';
  END IF;

  IF public.is_period_locked(v_org, _business_id, _disposal_date) THEN
    RAISE EXCEPTION 'FA_PERIOD_CLOSED: the fiscal period containing % is closed; the disposal cannot be posted', _disposal_date
      USING ERRCODE = '22023';
  END IF;

  IF v_row.category_id IS NOT NULL THEN
    SELECT * INTO v_cat FROM public.asset_categories WHERE id = v_row.category_id;
  END IF;

  v_pay_key := CASE lower(COALESCE(_payment_method, 'bank'))
                 WHEN 'cash' THEN 'cash'
                 WHEN 'petty_cash' THEN 'cash'
                 WHEN 'mobile_money' THEN 'mobile_money'
                 WHEN 'mpesa' THEN 'mobile_money'
                 ELSE 'bank'
               END;

  v_asset_acct := COALESCE(v_cat.asset_account_id, public.get_default_account_id(v_org, _business_id, 'fixed_asset'));
  v_accum_acct := COALESCE(v_cat.accumulated_depreciation_account_id,
                           public.get_default_account_id(v_org, _business_id, 'accumulated_depreciation'));
  v_pay_acct   := public.get_default_account_id(v_org, _business_id, v_pay_key);

  IF v_asset_acct IS NULL OR v_accum_acct IS NULL THEN
    RAISE EXCEPTION 'FA_MISSING_GL_MAPPING: the fixed-asset and accumulated-depreciation accounts must be mapped before an asset can be disposed'
      USING ERRCODE = '22023';
  END IF;

  -- Stamp the disposal on the asset first: the currency trigger derives the
  -- base-currency proceeds at the disposal-date rate (IAS 21 monetary item).
  UPDATE public.fixed_assets
     SET status = 'disposed',
         disposal_date = _disposal_date,
         disposal_price = COALESCE(_disposal_price, 0),
         disposal_reason = _reason
   WHERE id = _asset_id;

  SELECT * INTO v_row FROM public.fixed_assets WHERE id = _asset_id;

  v_proceeds := ROUND(COALESCE(v_row.base_disposal_price, COALESCE(_disposal_price, 0)), 2);
  v_cost     := ROUND(COALESCE(v_row.base_purchase_price, v_row.purchase_price), 2);
  v_accum    := ROUND(COALESCE(v_row.accumulated_depreciation, 0), 2);
  v_book     := ROUND(v_cost - v_accum, 2);
  v_gain     := ROUND(v_proceeds - v_book, 2);

  IF v_proceeds > 0 AND v_pay_acct IS NULL THEN
    RAISE EXCEPTION 'FA_MISSING_GL_MAPPING: the % settlement account must be mapped before disposal proceeds can be posted', v_pay_key
      USING ERRCODE = '22023';
  END IF;

  IF ABS(v_gain) >= 0.01 THEN
    v_gl_acct := COALESCE(
      v_cat.gain_loss_account_id,
      public.get_default_account_id(v_org, _business_id,
        CASE WHEN v_gain > 0 THEN 'other_income' ELSE 'operating_expenses' END));
    IF v_gl_acct IS NULL THEN
      RAISE EXCEPTION 'FA_MISSING_GL_MAPPING: a gain/loss on disposal account must be mapped before this asset can be disposed'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  v_lines := '[]'::jsonb;
  IF v_proceeds > 0 THEN
    v_lines := v_lines || jsonb_build_object('account_id', v_pay_acct, 'debit', v_proceeds, 'credit', 0,
      'description', 'Disposal proceeds - ' || v_row.name);
  END IF;
  IF v_accum > 0 THEN
    v_lines := v_lines || jsonb_build_object('account_id', v_accum_acct, 'debit', v_accum, 'credit', 0,
      'description', 'Remove accumulated depreciation - ' || v_row.name);
  END IF;
  v_lines := v_lines || jsonb_build_object('account_id', v_asset_acct, 'debit', 0, 'credit', v_cost,
    'description', 'Asset disposal at cost - ' || v_row.name);
  IF ABS(v_gain) >= 0.01 THEN
    IF v_gain > 0 THEN
      v_lines := v_lines || jsonb_build_object('account_id', v_gl_acct, 'debit', 0, 'credit', v_gain,
        'description', 'Gain on disposal - ' || v_row.name);
    ELSE
      v_lines := v_lines || jsonb_build_object('account_id', v_gl_acct, 'debit', ABS(v_gain), 'credit', 0,
        'description', 'Loss on disposal - ' || v_row.name);
    END IF;
  END IF;

  v_je := public.post_journal_entry_atomic(
    _org_id          => v_org,
    _business_id     => _business_id,
    _entry_number    => public.get_next_journal_entry_number(v_org),
    _entry_date      => _disposal_date,
    _reference       => 'DISP-' || v_row.asset_number,
    _description     => 'Asset disposal: ' || v_row.name || COALESCE(' - ' || _reason, ''),
    _source_type     => 'asset_disposal',
    _source_id       => v_row.id,
    _created_by      => v_actor,
    _is_closing      => false,
    _is_adjusting    => false,
    _lines           => v_lines,
    _currency        => v_ccy,
    _exchange_rate   => 1,
    _source_subtype  => NULL,
    _branch_id       => v_row.branch_id,
    _is_opening_entry => false,
    _amounts_in_document_currency => NULL
  );

  IF v_je IS NULL THEN
    RAISE EXCEPTION 'FA_DISPOSAL_POSTING_FAILED: the ledger refused the disposal entry for %', v_row.asset_number;
  END IF;

  RETURN jsonb_build_object(
    'asset_id', v_row.id,
    'asset_number', v_row.asset_number,
    'journal_entry_id', v_je,
    'base_cost', v_cost,
    'accumulated_depreciation', v_accum,
    'book_value', v_book,
    'base_proceeds', v_proceeds,
    'gain_loss', v_gain
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fa_dispose_asset(uuid, uuid, date, numeric, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fa_dispose_asset(uuid, uuid, date, numeric, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public._fa_guard_asset_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(OLD.accumulated_depreciation, 0) <> 0
     OR EXISTS (SELECT 1 FROM public.depreciation_schedules d WHERE d.asset_id = OLD.id)
     OR EXISTS (SELECT 1 FROM public.depreciation_entries e WHERE e.asset_id = OLD.id)
     OR EXISTS (
          SELECT 1 FROM public.journal_entries je
           WHERE je.source_id = OLD.id
             AND je.source_type IN ('asset_acquisition', 'depreciation', 'asset_disposal')
             AND COALESCE(je.status, 'posted') <> 'voided')
  THEN
    RAISE EXCEPTION 'FA_ASSET_HAS_ACCOUNTING: asset % has posted accounting history and cannot be deleted; dispose or retire it instead', OLD.asset_number
      USING ERRCODE = '22023';
  END IF;
  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS fa_guard_asset_delete ON public.fixed_assets;
CREATE TRIGGER fa_guard_asset_delete
BEFORE DELETE ON public.fixed_assets
FOR EACH ROW EXECUTE FUNCTION public._fa_guard_asset_delete();