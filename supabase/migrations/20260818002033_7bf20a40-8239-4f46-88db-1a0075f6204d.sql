-- ══ Banking Wave 1 / Step 2 — the single server-owned write seam ══

CREATE OR REPLACE FUNCTION public._bank_account_row(_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT to_jsonb(b) FROM public.bank_accounts b WHERE b.id = _id;
$$;

-- ── Opening balance: posted through the canonical engine, never by a client ──
CREATE OR REPLACE FUNCTION public._bank_account_post_opening_balance(_account_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a record;
  v_equity uuid;
  v_je uuid;
  v_amount numeric;
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

  v_je := public.post_journal_entry_atomic(
    a.organization_id,
    a.business_id,
    NULL,
    COALESCE(a.opening_balance_date, CURRENT_DATE),
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
    NULL,
    'main',
    a.branch_id
  );

  UPDATE public.journal_entries SET is_opening_entry = true WHERE id = v_je;
  UPDATE public.bank_accounts SET opening_balance_je_id = v_je WHERE id = _account_id;

  PERFORM public.publish_business_event(
    a.organization_id, a.branch_id, NULL,
    'banking.account.opening_balance_posted', 'bank_account', a.id,
    jsonb_build_object('business_id', a.business_id, 'amount', v_amount,
                       'currency', a.currency, 'journal_entry_id', v_je),
    'bank-ob-' || a.id::text, auth.uid());

  RETURN v_je;
END;
$$;

-- ── Create ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bank_account_create(_business_id uuid, _payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  v_existing uuid;
BEGIN
  PERFORM public.assert_can_manage_bank_accounts(_business_id);

  SELECT organization_id, base_currency INTO v_org, v_base
    FROM public.businesses WHERE id = _business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Company % not found', _business_id USING ERRCODE = 'no_data_found';
  END IF;

  v_currency := COALESCE(public.normalize_currency_code(_payload->>'currency'), v_base);
  v_branch   := NULLIF(_payload->>'branch_id','')::uuid;

  -- Concurrency: serialise duplicate-connection races per company + identity.
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
    NULLIF(_payload->>'account_id','')::uuid,
    v_provider,
    v_extid,
    COALESCE((_payload->>'is_primary')::boolean, false),
    v_opening,
    NULLIF(_payload->>'opening_balance_date','')::date,
    NULLIF(_payload->>'sync_from_date','')::date,
    CASE WHEN v_activate THEN 'active' ELSE 'draft' END::public.bank_account_lifecycle_status,
    CASE WHEN v_activate THEN now() END
  ) RETURNING id INTO v_id;

  IF v_opening <> 0 THEN
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
$$;

-- ── Update ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bank_account_update(_id uuid, _row_version integer, _payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- Accounting identity freezes once the account has posted history.
  v_locked := a.opening_balance_je_id IS NOT NULL
              OR EXISTS (SELECT 1 FROM public.bank_transactions WHERE bank_account_id = _id);

  v_currency := COALESCE(public.normalize_currency_code(_payload->>'currency'), a.currency);
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

  -- A draft's opening balance may still be settled through the engine.
  IF NOT v_locked AND v_opening <> 0 THEN
    PERFORM public._bank_account_post_opening_balance(_id);
  END IF;

  RETURN public._bank_account_row(_id);
END;
$$;

-- ── Lifecycle transitions ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bank_account_transition(
  _id uuid,
  _target public.bank_account_lifecycle_status,
  _reason text DEFAULT NULL,
  _row_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a record;
  v_unreconciled bigint;
  v_open_sessions bigint;
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

  IF a.lifecycle_status = _target THEN
    RETURN public._bank_account_row(_id);              -- idempotent
  END IF;

  IF NOT (
    (a.lifecycle_status = 'draft'     AND _target IN ('active','closed'))
    OR (a.lifecycle_status = 'active'    AND _target IN ('suspended','closed'))
    OR (a.lifecycle_status = 'suspended' AND _target IN ('active','closed'))
  ) THEN
    RAISE EXCEPTION 'Bank account cannot move from % to %.', a.lifecycle_status, _target
      USING ERRCODE = 'check_violation', HINT = 'BANK_ACCOUNT_INVALID_TRANSITION';
  END IF;

  IF _target = 'active' THEN
    IF a.account_id IS NULL THEN
      RAISE EXCEPTION 'Link a Chart-of-Accounts entry before activating "%".', a.name
        USING ERRCODE = 'check_violation', HINT = 'BANK_ACCOUNT_NEEDS_GL';
    END IF;
    IF COALESCE(a.opening_balance,0) <> 0 AND a.opening_balance_je_id IS NULL THEN
      PERFORM public._bank_account_post_opening_balance(_id);
    END IF;
  END IF;

  IF _target = 'closed' THEN
    SELECT count(*) INTO v_unreconciled FROM public.bank_transactions
      WHERE bank_account_id = _id AND COALESCE(is_reconciled,false) = false;
    IF v_unreconciled > 0 THEN
      RAISE EXCEPTION 'Cannot close "%": % unreconciled bank transaction(s) remain.', a.name, v_unreconciled
        USING ERRCODE = 'check_violation', HINT = 'BANK_ACCOUNT_UNRECONCILED';
    END IF;
    SELECT count(*) INTO v_open_sessions FROM public.bank_reconciliation_sessions
      WHERE bank_account_id = _id AND COALESCE(status,'open') <> 'completed';
    IF v_open_sessions > 0 THEN
      RAISE EXCEPTION 'Cannot close "%": an open reconciliation session exists.', a.name
        USING ERRCODE = 'check_violation', HINT = 'BANK_ACCOUNT_OPEN_RECONCILIATION';
    END IF;
  END IF;

  UPDATE public.bank_accounts SET
    lifecycle_status  = _target,
    activated_at      = CASE WHEN _target = 'active' THEN COALESCE(activated_at, now()) ELSE activated_at END,
    closed_at         = CASE WHEN _target = 'closed' THEN now() ELSE NULL END,
    closed_reason     = CASE WHEN _target = 'closed' THEN _reason ELSE NULL END,
    auto_sync_enabled = CASE WHEN _target IN ('suspended','closed') THEN false ELSE auto_sync_enabled END,
    updated_at        = now()
  WHERE id = _id;

  PERFORM public.publish_business_event(
    a.organization_id, a.branch_id, NULL,
    'banking.account.' || CASE _target WHEN 'active' THEN 'activated'
                                      WHEN 'suspended' THEN 'suspended'
                                      ELSE 'closed' END,
    'bank_account', _id,
    jsonb_build_object('business_id', a.business_id, 'from', a.lifecycle_status,
                       'to', _target, 'reason', _reason),
    'bank-' || _target::text || '-' || _id::text || '-' || (a.row_version + 1)::text,
    auth.uid());

  RETURN public._bank_account_row(_id);
END;
$$;

-- ── Delete: only an untouched draft; anything else must be closed ─────────
CREATE OR REPLACE FUNCTION public.bank_account_delete_draft(_id uuid, _row_version integer DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE a record;
BEGIN
  SELECT * INTO a FROM public.bank_accounts WHERE id = _id FOR UPDATE;
  IF a.id IS NULL THEN RETURN; END IF;
  PERFORM public.assert_can_manage_bank_accounts(a.business_id);

  IF _row_version IS NOT NULL AND _row_version <> a.row_version THEN
    RAISE EXCEPTION 'This bank account was changed by someone else. Reload and try again.'
      USING ERRCODE = '40001', HINT = 'BANK_ACCOUNT_VERSION_CONFLICT';
  END IF;

  IF a.lifecycle_status <> 'draft'
     OR a.opening_balance_je_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.bank_transactions WHERE bank_account_id = _id) THEN
    RAISE EXCEPTION 'This bank account has financial history and cannot be deleted. Close it instead.'
      USING ERRCODE = 'check_violation', HINT = 'BANK_ACCOUNT_NOT_DELETABLE';
  END IF;

  DELETE FROM public.bank_accounts WHERE id = _id;
END;
$$;

-- ── Withdraw direct table writes: the RPCs above are the only seam ────────
REVOKE INSERT, UPDATE, DELETE ON public.bank_accounts FROM authenticated;
GRANT SELECT ON public.bank_accounts TO authenticated;
GRANT ALL ON public.bank_accounts TO service_role;

REVOKE ALL ON FUNCTION public._bank_account_post_opening_balance(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bank_account_create(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_account_update(uuid, integer, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_account_transition(uuid, public.bank_account_lifecycle_status, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_account_delete_draft(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public._bank_account_row(uuid) TO authenticated;