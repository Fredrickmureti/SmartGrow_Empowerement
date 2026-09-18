-- 1. Who may be a client's loan officer.
-- Branch assignment remains the rule for ordinary team members; owners and
-- admins hold authority over every branch of the institution, so they qualify
-- without an explicit assignment row.
CREATE OR REPLACE FUNCTION public.mf_officer_may_own_branch(
  p_business_id uuid,
  p_user uuid,
  p_branch uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
           SELECT 1 FROM public.user_branch_assignments a
            WHERE a.user_id = p_user
              AND a.business_id = p_business_id
              AND a.branch_id = p_branch
         )
      OR EXISTS (
           SELECT 1 FROM public.businesses b
            WHERE b.id = p_business_id
              AND (
                public.has_role(p_user, b.organization_id, 'owner'::app_role)
                OR public.has_role(p_user, b.organization_id, 'admin'::app_role)
                OR public.has_role(p_user, b.organization_id, 'super_admin'::app_role)
              )
         );
$$;

GRANT EXECUTE ON FUNCTION public.mf_officer_may_own_branch(uuid, uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.mf_register_client(p_business_id uuid, p_client jsonb, p_group_id uuid DEFAULT NULL::uuid, p_meeting_id uuid DEFAULT NULL::uuid)
 RETURNS mf_clients
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_branch uuid := (p_client->>'branch_id')::uuid;
  v_officer uuid := NULLIF(p_client->>'loan_officer_id','')::uuid;
  v_group RECORD;
  v_meeting RECORD;
  v_client public.mf_clients;
BEGIN
  IF v_branch IS NULL THEN
    RAISE EXCEPTION 'Choose the branch that will own this client.' USING ERRCODE = 'P0001';
  END IF;

  IF v_officer IS NOT NULL
     AND NOT public.mf_officer_may_own_branch(p_business_id, v_officer, v_branch) THEN
    RAISE EXCEPTION 'This loan officer is not assigned to the selected branch.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_group_id IS NOT NULL THEN
    SELECT business_id, branch_id, loan_officer_id, status INTO v_group
      FROM public.mf_groups WHERE id = p_group_id;
    IF NOT FOUND OR v_group.business_id IS DISTINCT FROM p_business_id THEN
      RAISE EXCEPTION 'That group is not available in this institution.' USING ERRCODE = 'P0001';
    END IF;
    IF v_group.branch_id IS DISTINCT FROM v_branch THEN
      RAISE EXCEPTION 'This group belongs to a different branch than the client.' USING ERRCODE = 'P0001';
    END IF;
    IF v_group.status = 'closed' THEN
      RAISE EXCEPTION 'This group is closed and cannot take new members.' USING ERRCODE = 'P0001';
    END IF;
    IF v_officer IS NOT NULL AND v_group.loan_officer_id IS NOT NULL
       AND v_group.loan_officer_id IS DISTINCT FROM v_officer THEN
      RAISE EXCEPTION 'This group is managed by a different loan officer.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_meeting_id IS NOT NULL THEN
    SELECT business_id, group_id, status INTO v_meeting
      FROM public.mf_group_meetings WHERE id = p_meeting_id;
    IF NOT FOUND OR v_meeting.business_id IS DISTINCT FROM p_business_id THEN
      RAISE EXCEPTION 'That meeting is not available in this institution.' USING ERRCODE = 'P0001';
    END IF;
    IF p_group_id IS NOT NULL AND v_meeting.group_id IS DISTINCT FROM p_group_id THEN
      RAISE EXCEPTION 'That meeting belongs to a different group.' USING ERRCODE = 'P0001';
    END IF;
    IF v_meeting.status NOT IN ('scheduled','in_progress') THEN
      RAISE EXCEPTION 'This meeting is already closed, so no new client can be recorded against it.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO public.mf_clients (
    business_id, branch_id, client_number, full_name, national_id, date_of_birth,
    gender, phone, email, physical_address, occupation, business_type,
    business_location, next_of_kin_name, next_of_kin_relationship,
    next_of_kin_phone, loan_officer_id, status, notes, onboarded_meeting_id, created_by
  ) VALUES (
    p_business_id,
    v_branch,
    COALESCE(NULLIF(p_client->>'client_number',''), ''),
    p_client->>'full_name',
    NULLIF(p_client->>'national_id',''),
    NULLIF(p_client->>'date_of_birth','')::date,
    NULLIF(p_client->>'gender',''),
    NULLIF(p_client->>'phone',''),
    NULLIF(p_client->>'email',''),
    NULLIF(p_client->>'physical_address',''),
    NULLIF(p_client->>'occupation',''),
    NULLIF(p_client->>'business_type',''),
    NULLIF(p_client->>'business_location',''),
    NULLIF(p_client->>'next_of_kin_name',''),
    NULLIF(p_client->>'next_of_kin_relationship',''),
    NULLIF(p_client->>'next_of_kin_phone',''),
    v_officer,
    COALESCE(NULLIF(p_client->>'status',''), 'prospect'),
    NULLIF(p_client->>'notes',''),
    p_meeting_id,
    auth.uid()
  )
  RETURNING * INTO v_client;

  IF p_group_id IS NOT NULL THEN
    INSERT INTO public.mf_group_members (business_id, group_id, client_id, role_in_group)
    VALUES (p_business_id, p_group_id, v_client.id, 'member');
  END IF;

  RETURN v_client;
END;
$function$;

CREATE OR REPLACE FUNCTION public.mf_register_client(p_business_id uuid, p_client jsonb, p_group_id uuid DEFAULT NULL::uuid)
 RETURNS mf_clients
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_client public.mf_clients;
BEGIN
  -- Legacy signature: delegates to the current implementation so both share
  -- one set of rules.
  v_client := public.mf_register_client(p_business_id, p_client, p_group_id, NULL::uuid);
  RETURN v_client;
END;
$function$;

-- 2. How a fixed asset acquisition was settled.
CREATE OR REPLACE FUNCTION public.fa_create_asset(_business_id uuid, _asset jsonb, _payment_method text DEFAULT 'bank'::text)
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
  v_vendor     uuid := NULLIF(_asset->>'vendor_id', '')::uuid;
  v_pay_key    text;
  v_pay_label  text;
  v_asset_acct uuid;
  v_pay_acct   uuid;
  v_base       text;
  v_je         uuid;
BEGIN
  PERFORM public.assert_can_manage_assets(_business_id);

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'FA_AUTH_REQUIRED: an authenticated user is required to create an asset' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id, upper(NULLIF(btrim(COALESCE(base_currency, '')), ''))
    INTO v_org, v_base
    FROM public.businesses WHERE id = _business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'FA_UNKNOWN_BUSINESS: business % not found', _business_id;
  END IF;
  IF v_base IS NULL THEN
    RAISE EXCEPTION 'FA_NO_BASE_CURRENCY: this company has no base currency set; set it in Currency Settings before capitalising an asset'
      USING ERRCODE = '22023';
  END IF;

  IF COALESCE(_asset->>'name', '') = '' THEN
    RAISE EXCEPTION 'FA_NAME_REQUIRED: an asset name is required' USING ERRCODE = '22023';
  END IF;
  IF v_pdate IS NULL THEN
    RAISE EXCEPTION 'FA_PURCHASE_DATE_REQUIRED: a purchase date is required' USING ERRCODE = '22023';
  END IF;
  IF v_pdate > CURRENT_DATE THEN
    RAISE EXCEPTION 'FA_FUTURE_PURCHASE_DATE: the purchase date cannot be in the future; an asset is capitalised when it is acquired'
      USING ERRCODE = '22023';
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

  -- The credit side follows however the purchase was actually settled. An asset
  -- invoiced by a supplier and not yet paid becomes a payable: it must never be
  -- shown as money leaving the bank.
  v_pay_key := CASE lower(COALESCE(NULLIF(btrim(_payment_method), ''), 'bank'))
                 WHEN 'cash' THEN 'cash'
                 WHEN 'petty_cash' THEN 'cash'
                 WHEN 'mobile_money' THEN 'mobile_money'
                 WHEN 'mpesa' THEN 'mobile_money'
                 WHEN 'credit' THEN 'accounts_payable'
                 WHEN 'payable' THEN 'accounts_payable'
                 WHEN 'accounts_payable' THEN 'accounts_payable'
                 WHEN 'on_account' THEN 'accounts_payable'
                 ELSE 'bank'
               END;

  IF v_pay_key = 'accounts_payable' AND v_vendor IS NULL THEN
    RAISE EXCEPTION 'FA_VENDOR_REQUIRED: name the supplier the asset is owed to before recording it as unpaid'
      USING ERRCODE = '22023';
  END IF;

  v_pay_label := CASE v_pay_key
                   WHEN 'cash' THEN 'Paid in cash'
                   WHEN 'mobile_money' THEN 'Paid by mobile money'
                   WHEN 'accounts_payable' THEN 'Owed to supplier'
                   ELSE 'Paid from bank'
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
    v_vendor, NULLIF(_asset->>'invoice_reference', ''),
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
                         'description', v_pay_label || ' - ' || v_num)
    ),
    _currency        => v_base,
    _exchange_rate   => 1,
    _source_subtype  => NULL,
    _branch_id       => v_row.branch_id,
    _is_opening_entry => false,
    _amounts_in_document_currency => false
  );

  IF v_je IS NULL THEN
    RAISE EXCEPTION 'FA_ACQUISITION_POSTING_FAILED: the ledger refused the acquisition entry for %', v_num;
  END IF;

  RETURN to_jsonb(v_row) || jsonb_build_object('journal_entry_id', v_je);
END;
$function$;