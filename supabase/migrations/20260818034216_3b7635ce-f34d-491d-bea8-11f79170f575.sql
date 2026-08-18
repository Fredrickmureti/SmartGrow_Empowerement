-- =====================================================================
-- Banking Wave 1 — Phase 7: canonical cash position + lifecycle repair
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Canonical per-account position projection (D-7).
--    SECURITY INVOKER on purpose: RLS on bank_accounts / bank_transactions /
--    journal_* decides visibility. No denormalised balance is stored.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bank_account_positions(
  _business_id uuid,
  _as_of date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  bank_account_id uuid,
  currency text,
  opening_balance numeric,
  statement_balance numeric,
  last_statement_line_date date,
  gl_balance numeric,
  gl_shared boolean,
  unreconciled_count bigint,
  unreconciled_amount numeric,
  as_of date
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    a.id,
    a.currency,
    COALESCE(a.opening_balance, 0),
    COALESCE(a.opening_balance, 0) + COALESCE(t.net_amount, 0),
    t.last_line_date,
    CASE WHEN a.account_id IS NULL OR shared.n > 1 THEN NULL ELSE COALESCE(g.gl_net, 0) END,
    COALESCE(shared.n, 0) > 1,
    COALESCE(t.unreconciled_count, 0),
    COALESCE(t.unreconciled_amount, 0),
    _as_of
  FROM public.bank_accounts a
  LEFT JOIN LATERAL (
    SELECT
      SUM(bt.amount)                                                     AS net_amount,
      MAX(bt.transaction_date)                                           AS last_line_date,
      COUNT(*) FILTER (WHERE COALESCE(bt.is_reconciled, false) = false)  AS unreconciled_count,
      COALESCE(SUM(bt.amount) FILTER (WHERE COALESCE(bt.is_reconciled, false) = false), 0)
                                                                         AS unreconciled_amount
    FROM public.bank_transactions bt
    WHERE bt.bank_account_id = a.id
      AND bt.transaction_date <= _as_of
  ) t ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS n
    FROM public.bank_accounts sib
    WHERE sib.business_id = a.business_id
      AND sib.account_id IS NOT DISTINCT FROM a.account_id
      AND sib.account_id IS NOT NULL
      AND sib.lifecycle_status <> 'closed'
  ) shared ON TRUE
  LEFT JOIN LATERAL (
    SELECT SUM(jel.debit - jel.credit) AS gl_net
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE jel.account_id = a.account_id
      AND je.business_id = a.business_id
      AND je.status = 'posted'
      AND je.entry_date <= _as_of
  ) g ON TRUE
  WHERE a.business_id = _business_id;
$$;

REVOKE ALL ON FUNCTION public.bank_account_positions(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_account_positions(uuid, date) TO authenticated, service_role;

COMMENT ON FUNCTION public.bank_account_positions(uuid, date) IS
  'Canonical bank cash position. Every figure is reproducible from source rows: statement_balance from the account''s own bank_transactions, gl_balance from posted journal lines on the linked control account (NULL when that account is shared and cannot be attributed). Banking Wave 1 Phase 7 — replaces the unmaintained bank_accounts.current_balance column.';

-- ---------------------------------------------------------------------
-- 2. Drop the orphaned denormalised column (no writer, no dependent view).
-- ---------------------------------------------------------------------
ALTER TABLE public.bank_accounts DROP COLUMN IF EXISTS current_balance;

-- ---------------------------------------------------------------------
-- 3. Lifecycle repair (D-8): creating an account straight into `active`
--    must satisfy the same invariants as transitioning into `active`.
--    A draft does not post its opening balance; activation does.
-- ---------------------------------------------------------------------
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
  v_gl uuid := NULLIF(_payload->>'account_id','')::uuid;
  v_existing uuid;
BEGIN
  PERFORM public.assert_can_manage_bank_accounts(_business_id);

  SELECT organization_id, base_currency INTO v_org, v_base
    FROM public.businesses WHERE id = _business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Company % not found', _business_id USING ERRCODE = 'no_data_found';
  END IF;

  -- An active bank account without a ledger account cannot post anything;
  -- `bank_account_transition` already refuses it, so creation must too.
  IF v_activate AND v_gl IS NULL THEN
    RAISE EXCEPTION 'Link a Chart-of-Accounts entry before activating this bank account.'
      USING ERRCODE = 'check_violation', HINT = 'BANK_ACCOUNT_NEEDS_GL';
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

  -- Accounting only happens for an account that is live. A draft's opening
  -- balance is an intention; `bank_account_transition` posts it on activation.
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
$$;

REVOKE ALL ON FUNCTION public.bank_account_create(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_account_create(uuid, jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. The posting monopoly (ADR-0123) cannot hold while the journal tables
--    are writable by an unauthenticated role.
-- ---------------------------------------------------------------------
REVOKE ALL ON public.journal_entries FROM anon;
REVOKE ALL ON public.journal_entry_lines FROM anon;
