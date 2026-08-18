-- 1) Opening balance must carry a real, resolved rate for a non-base account.
CREATE OR REPLACE FUNCTION public._bank_account_post_opening_balance(_account_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  a record;
  v_equity uuid;
  v_je uuid;
  v_amount numeric;
  v_base text;
  v_date date;
  v_rate numeric;
BEGIN
  SELECT * INTO a FROM public.bank_accounts WHERE id = _account_id FOR UPDATE;
  IF a.id IS NULL THEN
    RAISE EXCEPTION 'Bank account % not found', _account_id USING ERRCODE = 'no_data_found';
  END IF;
  IF a.opening_balance_je_id IS NOT NULL THEN
    RETURN a.opening_balance_je_id;              -- idempotent
  END IF;

  v_amount := COALESCE(a.opening_balance, 0);
  IF v_amount = 0 THEN RETURN NULL; END IF;

  IF a.account_id IS NULL THEN
    RAISE EXCEPTION 'Bank account "%" needs a Chart-of-Accounts link before its opening balance can be posted.', a.name
      USING ERRCODE = 'check_violation', HINT = 'BANK_OPENING_BALANCE_NEEDS_GL';
  END IF;

  v_equity := public.ensure_opening_balance_equity_account(a.organization_id, a.business_id);
  v_date   := COALESCE(a.opening_balance_date, CURRENT_DATE);

  SELECT base_currency INTO v_base FROM public.businesses WHERE id = a.business_id;

  -- ADR 0136: a missing rate is a refusal, never parity. `require_exchange_rate`
  -- is the one authority; the browser never supplies a booking rate.
  IF a.currency IS NOT NULL AND v_base IS NOT NULL
     AND upper(a.currency) <> upper(v_base) THEN
    v_rate := public.require_exchange_rate(a.organization_id, a.business_id, a.currency, v_date);
  END IF;

  v_je := public.post_journal_entry_atomic(
    a.organization_id,
    a.business_id,
    NULL,
    v_date,
    'OB-BANK-' || LEFT(a.id::text, 8),
    'Opening balance - ' || a.name,
    'opening_balance',
    a.id,
    auth.uid(),
    false,
    false,
    jsonb_build_array(
      jsonb_build_object('account_id', a.account_id,
        'debit',  CASE WHEN v_amount > 0 THEN v_amount ELSE 0 END,
        'credit', CASE WHEN v_amount < 0 THEN -v_amount ELSE 0 END,
        'description', 'Opening balance - ' || a.name),
      jsonb_build_object('account_id', v_equity,
        'debit',  CASE WHEN v_amount < 0 THEN -v_amount ELSE 0 END,
        'credit', CASE WHEN v_amount > 0 THEN v_amount ELSE 0 END,
        'description', 'Opening balance - ' || a.name)
    ),
    a.currency,
    v_rate,
    'main',
    a.branch_id
  );

  UPDATE public.journal_entries SET is_opening_entry = true WHERE id = v_je;
  UPDATE public.bank_accounts SET opening_balance_je_id = v_je WHERE id = _account_id;

  PERFORM public.publish_business_event(
    a.organization_id, a.branch_id, NULL,
    'banking.account.opening_balance_posted', 'bank_account', a.id,
    jsonb_build_object('business_id', a.business_id, 'amount', v_amount,
                       'currency', a.currency, 'journal_entry_id', v_je,
                       'exchange_rate', v_rate),
    'bank-ob-' || a.id::text, auth.uid());

  RETURN v_je;
END;
$function$;

-- 2) One shared currency guard for the banking seams: the code must exist in
--    the canonical catalogue and still be active. This is the same set the
--    picker now shows, so the UI and the seam finally agree.
CREATE OR REPLACE FUNCTION public._assert_currency_is_active(_code text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF _code IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.currencies
     WHERE upper(code) = upper(_code) AND is_active
  ) THEN
    RAISE EXCEPTION 'Currency "%" is not an active currency in the platform catalogue.', _code
      USING ERRCODE = 'check_violation', HINT = 'CURRENCY_NOT_ACTIVE';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public._assert_currency_is_active(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._assert_currency_is_active(text) TO authenticated, service_role;

-- 3) Wire the guard into the two account write seams.
CREATE OR REPLACE FUNCTION public.bank_account_create(_business_id uuid, _payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid;
  v_base text;
  v_currency text;
  v_branch uuid;
  v_id uuid;
  v_activate boolean := COALESCE((_payload->>'activate')::boolean, true);
  v_opening numeric := COALESCE((_payload->>'opening_balance')::numeric, 0);
  v_provider uuid := NULLIF(_payload->>'provider_id','')::uuid;
  v_extid text := NULLIF(_payload->>'external_account_id','');
  v_acctno text := NULLIF(_payload->>'account_number','');
  v_gl uuid := NULLIF(_payload->>'account_id','')::uuid;
  v_existing uuid;
BEGIN
  PERFORM public.assert_can_manage_bank_accounts(_business_id);

  SELECT organization_id, base_currency INTO v_org, v_base
    FROM public.businesses WHERE id = _business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Company % not found', _business_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_activate AND v_gl IS NULL THEN
    RAISE EXCEPTION 'Link a Chart-of-Accounts entry before activating this bank account.'
      USING ERRCODE = 'check_violation', HINT = 'BANK_ACCOUNT_NEEDS_GL';
  END IF;

  v_currency := COALESCE(public.normalize_currency_code(_payload->>'currency'), v_base);
  PERFORM public._assert_currency_is_active(v_currency);
  v_branch   := NULLIF(_payload->>'branch_id','')::uuid;

  PERFORM pg_advisory_xact_lock(
    hashtext(_business_id::text || ':' || COALESCE(v_extid, v_acctno, '') || ':' || COALESCE(v_provider::text,'manual')));

  SELECT id INTO v_existing FROM public.bank_accounts
   WHERE business_id = _business_id
     AND ((v_extid IS NOT NULL AND external_account_id = v_extid AND provider_id IS NOT DISTINCT FROM v_provider)
       OR (v_extid IS NULL AND v_acctno IS NOT NULL AND account_number = v_acctno
           AND provider_id IS NOT DISTINCT FROM v_provider))
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'This bank account is already connected for this company.'
      USING ERRCODE = 'unique_violation', HINT = 'BANK_ACCOUNT_ALREADY_CONNECTED', DETAIL = v_existing::text;
  END IF;

  INSERT INTO public.bank_accounts (
    organization_id, business_id, branch_id, name, bank_name, account_number,
    routing_number, currency, account_type, account_id, provider_id,
    external_account_id, is_primary, opening_balance, opening_balance_date,
    sync_from_date, lifecycle_status, activated_at
  ) VALUES (
    v_org, _business_id, v_branch,
    _payload->>'name',
    NULLIF(_payload->>'bank_name',''),
    v_acctno,
    NULLIF(_payload->>'routing_number',''),
    v_currency,
    COALESCE(NULLIF(_payload->>'account_type',''), 'checking'),
    v_gl,
    v_provider,
    v_extid,
    COALESCE((_payload->>'is_primary')::boolean, false),
    v_opening,
    NULLIF(_payload->>'opening_balance_date','')::date,
    NULLIF(_payload->>'sync_from_date','')::date,
    CASE WHEN v_activate THEN 'active' ELSE 'draft' END::public.bank_account_lifecycle_status,
    CASE WHEN v_activate THEN now() END
  ) RETURNING id INTO v_id;

  IF v_activate AND v_opening <> 0 THEN
    PERFORM public._bank_account_post_opening_balance(v_id);
  END IF;

  IF v_activate THEN
    PERFORM public.publish_business_event(
      v_org, v_branch, NULL, 'banking.account.activated', 'bank_account', v_id,
      jsonb_build_object('business_id', _business_id, 'currency', v_currency),
      'bank-activated-' || v_id::text, auth.uid());
  END IF;

  RETURN public._bank_account_row(v_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.bank_account_update(_id uuid, _row_version integer, _payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  a record;
  v_currency text;
  v_locked boolean;
  v_opening numeric;
BEGIN
  SELECT * INTO a FROM public.bank_accounts WHERE id = _id FOR UPDATE;
  IF a.id IS NULL THEN
    RAISE EXCEPTION 'Bank account % not found', _id USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM public.assert_can_manage_bank_accounts(a.business_id);

  IF _row_version IS NOT NULL AND _row_version <> a.row_version THEN
    RAISE EXCEPTION 'This bank account was changed by someone else. Reload and try again.'
      USING ERRCODE = '40001', HINT = 'BANK_ACCOUNT_VERSION_CONFLICT';
  END IF;

  IF a.lifecycle_status = 'closed' THEN
    RAISE EXCEPTION 'Closed bank accounts cannot be edited.'
      USING ERRCODE = 'check_violation', HINT = 'BANK_ACCOUNT_CLOSED';
  END IF;

  v_locked := a.opening_balance_je_id IS NOT NULL
              OR EXISTS (SELECT 1 FROM public.bank_transactions WHERE bank_account_id = _id);

  v_currency := COALESCE(public.normalize_currency_code(_payload->>'currency'), a.currency);
  IF v_currency IS DISTINCT FROM a.currency THEN
    PERFORM public._assert_currency_is_active(v_currency);
  END IF;
  v_opening  := COALESCE((_payload->>'opening_balance')::numeric, a.opening_balance);

  IF v_locked AND (v_currency <> a.currency
                   OR v_opening IS DISTINCT FROM a.opening_balance
                   OR (_payload ? 'account_id'
                       AND NULLIF(_payload->>'account_id','')::uuid IS DISTINCT FROM a.account_id)) THEN
    RAISE EXCEPTION 'Currency, ledger account and opening balance are fixed once this account has posted activity. Post a correcting journal entry instead.'
      USING ERRCODE = 'check_violation', HINT = 'BANK_ACCOUNT_ACCOUNTING_LOCKED';
  END IF;

  UPDATE public.bank_accounts SET
    name              = COALESCE(NULLIF(_payload->>'name',''), name),
    bank_name         = CASE WHEN _payload ? 'bank_name' THEN NULLIF(_payload->>'bank_name','') ELSE bank_name END,
    account_number    = CASE WHEN _payload ? 'account_number' THEN NULLIF(_payload->>'account_number','') ELSE account_number END,
    routing_number    = CASE WHEN _payload ? 'routing_number' THEN NULLIF(_payload->>'routing_number','') ELSE routing_number END,
    account_type      = COALESCE(NULLIF(_payload->>'account_type',''), account_type),
    currency          = v_currency,
    account_id        = CASE WHEN _payload ? 'account_id' THEN NULLIF(_payload->>'account_id','')::uuid ELSE account_id END,
    branch_id         = CASE WHEN _payload ? 'branch_id' THEN NULLIF(_payload->>'branch_id','')::uuid ELSE branch_id END,
    is_primary        = COALESCE((_payload->>'is_primary')::boolean, is_primary),
    opening_balance   = v_opening,
    opening_balance_date = CASE WHEN _payload ? 'opening_balance_date'
                                THEN NULLIF(_payload->>'opening_balance_date','')::date
                                ELSE opening_balance_date END,
    sync_from_date    = CASE WHEN _payload ? 'sync_from_date'
                             THEN NULLIF(_payload->>'sync_from_date','')::date ELSE sync_from_date END,
    auto_sync_enabled = COALESCE((_payload->>'auto_sync_enabled')::boolean, auto_sync_enabled),
    sync_frequency    = COALESCE(NULLIF(_payload->>'sync_frequency',''), sync_frequency),
    updated_at        = now()
  WHERE id = _id;

  IF NOT v_locked AND v_opening <> 0 THEN
    PERFORM public._bank_account_post_opening_balance(_id);
  END IF;

  RETURN public._bank_account_row(_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.bank_account_create(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_account_update(uuid, integer, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._bank_account_post_opening_balance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_account_create(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bank_account_update(uuid, integer, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._bank_account_post_opening_balance(uuid) TO authenticated, service_role;