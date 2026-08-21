-- 1) Read boundary: match history is business- and branch-scoped, not org-wide.
DROP POLICY IF EXISTS bank_recon_matches_select ON public.bank_reconciliation_matches;

CREATE POLICY bank_recon_matches_select_perm_v1
ON public.bank_reconciliation_matches
FOR SELECT
TO authenticated
USING (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND (
    branch_id IS NULL
    OR public.user_can_access_branch(auth.uid(), branch_id)
    OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id)
  )
);

-- 2) Internal scope assertion shared by the two history readers.
CREATE OR REPLACE FUNCTION public._assert_can_read_bank_history(_business_id uuid, _branch_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'BANK_HISTORY_UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;
  IF _business_id IS NULL OR NOT public.user_can_access_business(auth.uid(), _business_id) THEN
    RAISE EXCEPTION 'BANK_HISTORY_OUT_OF_SCOPE' USING ERRCODE = '42501';
  END IF;
  IF _branch_id IS NOT NULL
     AND NOT public.user_can_access_branch(auth.uid(), _branch_id)
     AND NOT public.has_finance_permission(auth.uid(), 'finance.view_consolidated', _business_id) THEN
    RAISE EXCEPTION 'BANK_HISTORY_OUT_OF_BRANCH_SCOPE' USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._assert_can_read_bank_history(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._assert_can_read_bank_history(uuid, uuid) FROM anon;

-- Actor display name, resolved once, inside the boundary.
CREATE OR REPLACE FUNCTION public._bank_history_actor(_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(NULLIF(p.full_name, ''), p.email, 'Unknown user')
  FROM public.profiles p
  WHERE p.user_id = _user_id
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public._bank_history_actor(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._bank_history_actor(uuid) FROM anon;

-- Decision record for one match row, timeline included. Read-only.
CREATE OR REPLACE FUNCTION public._bank_match_history_row(_m public.bank_reconciliation_matches)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _events jsonb := '[]'::jsonb;
  _rule_name text;
BEGIN
  SELECT r.name INTO _rule_name
  FROM public.bank_reconciliation_rules r
  WHERE r.id = _m.rule_id;

  _events := _events || jsonb_build_object(
    'event', 'proposed',
    'at', _m.created_at,
    'actor_id', COALESCE(_m.proposed_by, _m.created_by),
    'actor', public._bank_history_actor(COALESCE(_m.proposed_by, _m.created_by)),
    'basis', CASE WHEN _m.rule_id IS NOT NULL THEN COALESCE(_rule_name, 'rule') ELSE 'manual' END,
    'detail', _m.notes
  );

  IF _m.confirmed_at IS NOT NULL THEN
    _events := _events || jsonb_build_object(
      'event', 'confirmed',
      'at', _m.confirmed_at,
      'actor_id', _m.confirmed_by,
      'actor', public._bank_history_actor(_m.confirmed_by),
      'basis', NULL,
      'detail', NULL
    );
  END IF;

  IF _m.rejected_at IS NOT NULL THEN
    _events := _events || jsonb_build_object(
      'event', 'rejected',
      'at', _m.rejected_at,
      'actor_id', _m.rejected_by,
      'actor', public._bank_history_actor(_m.rejected_by),
      'basis', NULL,
      'detail', _m.notes
    );
  END IF;

  IF _m.reversed_at IS NOT NULL THEN
    _events := _events || jsonb_build_object(
      'event', 'reversed',
      'at', _m.reversed_at,
      'actor_id', _m.reversed_by,
      'actor', public._bank_history_actor(_m.reversed_by),
      'basis', NULL,
      'detail', _m.notes
    );
  END IF;

  RETURN jsonb_build_object(
    'match_id', _m.id,
    'bank_transaction_id', _m.bank_transaction_id,
    'status', _m.status,
    'match_type', _m.match_type,
    'matched_amount', _m.matched_amount,
    'residual_amount', _m.residual_amount,
    'fee_amount', _m.fee_amount,
    'fee_account_id', _m.fee_account_id,
    'exchange_rate', _m.exchange_rate,
    'confidence', _m.confidence,
    'rule_id', _m.rule_id,
    'rule_name', _rule_name,
    'origin', CASE WHEN _m.rule_id IS NOT NULL THEN 'rule' ELSE 'manual' END,
    'allocations', COALESCE(_m.allocations, '[]'::jsonb),
    'evidence', COALESCE(_m.evidence, '{}'::jsonb),
    'journal_entry_id', _m.matched_journal_entry_id,
    'fee_journal_entry_id', _m.fee_journal_entry_id,
    'adjustment_journal_entry_id', _m.adjustment_journal_entry_id,
    'is_reversed', (_m.reversed_at IS NOT NULL),
    'created_at', _m.created_at,
    'updated_at', _m.updated_at,
    'events', (
      SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'at')), '[]'::jsonb)
      FROM jsonb_array_elements(_events) e
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public._bank_match_history_row(public.bank_reconciliation_matches) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._bank_match_history_row(public.bank_reconciliation_matches) FROM anon;

-- 3) Per bank line: every decision ever taken on it, oldest first.
CREATE OR REPLACE FUNCTION public.bank_match_history(p_bank_transaction_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _txn public.bank_transactions;
  _decisions jsonb;
BEGIN
  SELECT * INTO _txn FROM public.bank_transactions WHERE id = p_bank_transaction_id;
  IF _txn.id IS NULL THEN
    RAISE EXCEPTION 'BANK_TRANSACTION_NOT_FOUND' USING ERRCODE = '22023';
  END IF;

  PERFORM public._assert_can_read_bank_history(_txn.business_id, _txn.branch_id);

  SELECT COALESCE(jsonb_agg(public._bank_match_history_row(m) ORDER BY m.created_at), '[]'::jsonb)
  INTO _decisions
  FROM public.bank_reconciliation_matches m
  WHERE m.bank_transaction_id = p_bank_transaction_id;

  RETURN jsonb_build_object(
    'bank_transaction_id', _txn.id,
    'transaction_date', _txn.transaction_date,
    'description', _txn.description,
    'reference', _txn.reference,
    'amount', _txn.amount,
    'transaction_type', _txn.transaction_type,
    'match_source', _txn.match_source,
    'decisions', _decisions
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bank_match_history(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bank_match_history(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.bank_match_history(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_match_history(uuid) TO service_role;

-- 4) Per reconciliation session: the audit trail of every line it touched.
CREATE OR REPLACE FUNCTION public.bank_match_session_history(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _s public.bank_reconciliation_sessions;
  _lines jsonb;
BEGIN
  SELECT * INTO _s FROM public.bank_reconciliation_sessions WHERE id = p_session_id;
  IF _s.id IS NULL THEN
    RAISE EXCEPTION 'BANK_RECONCILIATION_SESSION_NOT_FOUND' USING ERRCODE = '22023';
  END IF;

  PERFORM public._assert_can_read_bank_history(_s.business_id, _s.branch_id);

  SELECT COALESCE(jsonb_agg(x.entry ORDER BY x.sort_at), '[]'::jsonb)
  INTO _lines
  FROM (
    SELECT
      m.created_at AS sort_at,
      jsonb_build_object(
        'bank_transaction_id', t.id,
        'transaction_date', t.transaction_date,
        'description', t.description,
        'reference', t.reference,
        'amount', t.amount,
        'transaction_type', t.transaction_type,
        'match_source', t.match_source,
        'decision', public._bank_match_history_row(m)
      ) AS entry
    FROM public.bank_reconciliation_items i
    JOIN public.bank_transactions t ON t.id = i.transaction_id
    JOIN public.bank_reconciliation_matches m ON m.bank_transaction_id = t.id
    WHERE i.session_id = p_session_id
  ) x;

  RETURN jsonb_build_object(
    'session_id', _s.id,
    'statement_date', _s.statement_date,
    'status', _s.status,
    'opening_balance', _s.opening_balance,
    'closing_balance', _s.closing_balance,
    'difference', _s.difference,
    'completed_at', _s.completed_at,
    'completed_by', _s.completed_by,
    'completed_by_name', public._bank_history_actor(_s.completed_by),
    'cancelled_at', _s.cancelled_at,
    'cancelled_by_name', public._bank_history_actor(_s.cancelled_by),
    'cancel_reason', _s.cancel_reason,
    'entries', _lines
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bank_match_session_history(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bank_match_session_history(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.bank_match_session_history(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_match_session_history(uuid) TO service_role;