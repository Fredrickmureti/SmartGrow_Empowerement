-- ═══════════════════════════════════════════════════════════════════════════
-- Banking Phase 4 — Reconciliation hardening.
--
-- The reconciliation session lifecycle was browser-orchestrated: the client
-- inserted sessions, toggled cleared items, computed the cleared balance,
-- posted service-charge / interest / write-off journal entries through the
-- client GL helper, flipped `bank_transactions.is_reconciled` in bulk and then
-- marked the session complete — five separate round trips, any of which could
-- fail and leave a half-reconciled account. It also wrote `reconciled_balance`
-- with an opening-balance-inclusive figure while the stored generated column
-- `difference = closing - opening - reconciled_balance` assumes a *net
-- movement*, so persisted differences were wrong even when the UI balanced.
--
-- This migration moves the whole lifecycle behind SECURITY DEFINER RPCs that
-- own the arithmetic, the gates (permission, account lifecycle, fiscal period
-- lock) and the GL posting in one transaction, and revokes direct writes.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.bank_reconciliation_sessions
  ADD COLUMN IF NOT EXISTS cancelled_at    timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by    uuid,
  ADD COLUMN IF NOT EXISTS cancel_reason   text,
  ADD COLUMN IF NOT EXISTS writeoff_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS writeoff_je_id  uuid;

-- ── Canonical arithmetic ──────────────────────────────────────────────────
-- reconciled_balance is the NET CLEARED MOVEMENT for the session (credits
-- positive, debits negative) plus the statement adjustments, so the stored
-- generated `difference` column is meaningful without the client doing math.
CREATE OR REPLACE FUNCTION public._bank_reconciliation_recompute(_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s            record;
  v_movement   numeric := 0;
  v_count      int     := 0;
  v_balance    numeric;
  v_diff       numeric;
BEGIN
  SELECT * INTO s FROM public.bank_reconciliation_sessions WHERE id = _session_id FOR UPDATE;
  IF s.id IS NULL THEN
    RAISE EXCEPTION 'Reconciliation session % not found', _session_id
      USING ERRCODE = 'no_data_found', HINT = 'BANK_RECON_SESSION_NOT_FOUND';
  END IF;

  SELECT
    COALESCE(SUM(CASE WHEN t.transaction_type = 'credit' THEN ABS(t.amount) ELSE -ABS(t.amount) END), 0),
    COUNT(*)
  INTO v_movement, v_count
  FROM public.bank_transactions t
  WHERE t.bank_account_id = s.bank_account_id
    AND t.transaction_date <= s.statement_date
    AND (
      t.is_reconciled = true
      OR EXISTS (
        SELECT 1 FROM public.bank_reconciliation_items i
        WHERE i.session_id = s.id AND i.transaction_id = t.id AND i.status = 'cleared')
    );

  v_balance := v_movement
             - COALESCE(s.service_charge_amount, 0)
             + COALESCE(s.interest_earned_amount, 0)
             + COALESCE(s.writeoff_amount, 0);

  UPDATE public.bank_reconciliation_sessions
     SET reconciled_balance = v_balance, updated_at = now()
   WHERE id = s.id;

  v_diff := (s.closing_balance - s.opening_balance) - v_balance;

  RETURN jsonb_build_object(
    'session_id',         s.id,
    'cleared_count',      v_count,
    'cleared_movement',   v_movement,
    'reconciled_balance', v_balance,
    'cleared_balance',    s.opening_balance + v_balance,
    'difference',         v_diff,
    'is_balanced',        ABS(v_diff) <= 0.01
  );
END;
$$;

-- ── Guard helper: the caller may reconcile this account, and the account is
-- in a state that accepts reconciliation activity. ────────────────────────
CREATE OR REPLACE FUNCTION public._bank_reconciliation_assert_account(_bank_account_id uuid)
RETURNS public.bank_accounts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE a public.bank_accounts;
BEGIN
  SELECT * INTO a FROM public.bank_accounts WHERE id = _bank_account_id FOR SHARE;
  IF a.id IS NULL THEN
    RAISE EXCEPTION 'Bank account % not found', _bank_account_id
      USING ERRCODE = 'no_data_found', HINT = 'BANK_ACCOUNT_NOT_FOUND';
  END IF;

  IF auth.uid() IS NULL AND current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Bank reconciliation requires an authenticated caller'
      USING ERRCODE = '42501', HINT = 'BANK_RECON_NO_ACTOR';
  END IF;
  IF auth.uid() IS NOT NULL THEN
    PERFORM public.assert_can_reconcile_bank(a.business_id);
  END IF;

  IF a.lifecycle_status <> 'active' THEN
    RAISE EXCEPTION 'Bank account "%" is % — only active accounts can be reconciled.',
      a.name, a.lifecycle_status
      USING ERRCODE = 'check_violation', HINT = 'BANK_ACCOUNT_NOT_ACTIVE';
  END IF;

  RETURN a;
END;
$$;

-- ── Start ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bank_reconciliation_session_start(
  _bank_account_id  uuid,
  _statement_date   date,
  _opening_balance  numeric,
  _closing_balance  numeric,
  _adjustments      jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a          public.bank_accounts;
  v_id       uuid;
  v_sc_amt   numeric := COALESCE(NULLIF(_adjustments->>'service_charge_amount', '')::numeric, 0);
  v_int_amt  numeric := COALESCE(NULLIF(_adjustments->>'interest_earned_amount', '')::numeric, 0);
  v_sc_acct  uuid    := NULLIF(_adjustments->>'service_charge_account_id', '')::uuid;
  v_int_acct uuid    := NULLIF(_adjustments->>'interest_earned_account_id', '')::uuid;
  v_sc_date  date    := NULLIF(_adjustments->>'service_charge_date', '')::date;
  v_int_date date    := NULLIF(_adjustments->>'interest_earned_date', '')::date;
BEGIN
  a := public._bank_reconciliation_assert_account(_bank_account_id);

  IF _statement_date IS NULL THEN
    RAISE EXCEPTION 'A statement date is required to start a reconciliation'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'BANK_RECON_NO_STATEMENT_DATE';
  END IF;

  IF public.is_period_locked(a.organization_id, a.business_id, _statement_date) THEN
    RAISE EXCEPTION 'Accounting period for % is locked — reconciliation cannot be started.',
      to_char(_statement_date, 'YYYY-MM-DD')
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_PERIOD_LOCKED';
  END IF;

  IF v_sc_amt < 0 OR v_int_amt < 0 THEN
    RAISE EXCEPTION 'Statement adjustments must be positive amounts'
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_BAD_ADJUSTMENT';
  END IF;
  IF v_sc_amt > 0 AND v_sc_acct IS NULL THEN
    RAISE EXCEPTION 'A service charge amount needs an expense account'
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_SC_NEEDS_ACCOUNT';
  END IF;
  IF v_int_amt > 0 AND v_int_acct IS NULL THEN
    RAISE EXCEPTION 'An interest earned amount needs an income account'
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_INT_NEEDS_ACCOUNT';
  END IF;
  IF v_sc_acct IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.accounts x WHERE x.id = v_sc_acct AND x.organization_id = a.organization_id) THEN
    RAISE EXCEPTION 'Service charge account does not belong to this organization'
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_ACCOUNT_SCOPE';
  END IF;
  IF v_int_acct IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.accounts x WHERE x.id = v_int_acct AND x.organization_id = a.organization_id) THEN
    RAISE EXCEPTION 'Interest earned account does not belong to this organization'
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_ACCOUNT_SCOPE';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.bank_reconciliation_sessions
    WHERE bank_account_id = a.id AND status = 'in_progress') THEN
    RAISE EXCEPTION 'A reconciliation is already in progress for "%" — resume or cancel it first.', a.name
      USING ERRCODE = 'unique_violation', HINT = 'bank_reconciliation_one_open_per_account';
  END IF;

  INSERT INTO public.bank_reconciliation_sessions (
    organization_id, business_id, branch_id, bank_account_id,
    statement_date, opening_balance, closing_balance, reconciled_balance,
    status, created_by,
    service_charge_amount, service_charge_date, service_charge_account_id,
    interest_earned_amount, interest_earned_date, interest_earned_account_id
  ) VALUES (
    a.organization_id, a.business_id, a.branch_id, a.id,
    _statement_date, COALESCE(_opening_balance, 0), COALESCE(_closing_balance, 0), 0,
    'in_progress', auth.uid(),
    NULLIF(v_sc_amt, 0), v_sc_date, v_sc_acct,
    NULLIF(v_int_amt, 0), v_int_date, v_int_acct
  ) RETURNING id INTO v_id;

  PERFORM public.publish_business_event(
    a.organization_id, a.branch_id, NULL,
    'banking.reconciliation.started', 'bank_reconciliation_session', v_id,
    jsonb_build_object('business_id', a.business_id, 'bank_account_id', a.id,
                       'statement_date', _statement_date,
                       'opening_balance', COALESCE(_opening_balance, 0),
                       'closing_balance', COALESCE(_closing_balance, 0)),
    'bank-recon-start-' || v_id::text, auth.uid());

  RETURN public._bank_reconciliation_recompute(v_id)
       || jsonb_build_object('session',
            (SELECT to_jsonb(s) FROM public.bank_reconciliation_sessions s WHERE s.id = v_id));
END;
$$;

-- ── Clear / unclear a single statement line ───────────────────────────────
CREATE OR REPLACE FUNCTION public.bank_reconciliation_item_set(
  _session_id     uuid,
  _transaction_id uuid,
  _cleared        boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s record;
  t record;
  a public.bank_accounts;
BEGIN
  SELECT * INTO s FROM public.bank_reconciliation_sessions WHERE id = _session_id;
  IF s.id IS NULL THEN
    RAISE EXCEPTION 'Reconciliation session % not found', _session_id
      USING ERRCODE = 'no_data_found', HINT = 'BANK_RECON_SESSION_NOT_FOUND';
  END IF;
  IF s.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Reconciliation session is % — cleared items can only change while in progress.', s.status
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_SESSION_CLOSED';
  END IF;

  a := public._bank_reconciliation_assert_account(s.bank_account_id);

  SELECT * INTO t FROM public.bank_transactions WHERE id = _transaction_id;
  IF t.id IS NULL THEN
    RAISE EXCEPTION 'Bank transaction % not found', _transaction_id
      USING ERRCODE = 'no_data_found', HINT = 'BANK_TXN_NOT_FOUND';
  END IF;
  IF t.bank_account_id <> s.bank_account_id THEN
    RAISE EXCEPTION 'Transaction belongs to a different bank account than this reconciliation'
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_TXN_SCOPE';
  END IF;
  IF t.transaction_date > s.statement_date THEN
    RAISE EXCEPTION 'Transaction dated % is after the statement date %',
      to_char(t.transaction_date, 'YYYY-MM-DD'), to_char(s.statement_date, 'YYYY-MM-DD')
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_TXN_AFTER_STATEMENT';
  END IF;
  IF t.is_reconciled THEN
    RAISE EXCEPTION 'Transaction is already reconciled — it cannot be re-cleared in this session'
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_TXN_ALREADY_RECONCILED';
  END IF;

  IF _cleared THEN
    INSERT INTO public.bank_reconciliation_items (
      session_id, transaction_id, status, cleared_at, cleared_by, branch_id)
    VALUES (s.id, t.id, 'cleared', now(), auth.uid(), s.branch_id)
    ON CONFLICT (session_id, transaction_id) DO UPDATE
      SET status = 'cleared', cleared_at = now(), cleared_by = auth.uid();
  ELSE
    DELETE FROM public.bank_reconciliation_items
     WHERE session_id = s.id AND transaction_id = t.id;
  END IF;

  RETURN public._bank_reconciliation_recompute(s.id);
END;
$$;

-- ── Write off a small residual difference ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.bank_reconciliation_session_writeoff(
  _session_id uuid,
  _max_amount numeric DEFAULT 5.00
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s      record;
  a      public.bank_accounts;
  v_calc jsonb;
  v_diff numeric;
  v_abs  numeric;
  v_je   uuid;
BEGIN
  SELECT * INTO s FROM public.bank_reconciliation_sessions WHERE id = _session_id;
  IF s.id IS NULL THEN
    RAISE EXCEPTION 'Reconciliation session % not found', _session_id
      USING ERRCODE = 'no_data_found', HINT = 'BANK_RECON_SESSION_NOT_FOUND';
  END IF;
  IF s.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Reconciliation session is % — nothing can be written off.', s.status
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_SESSION_CLOSED';
  END IF;
  IF COALESCE(s.writeoff_amount, 0) <> 0 THEN
    RAISE EXCEPTION 'This reconciliation already has a write-off posted'
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_WRITEOFF_EXISTS';
  END IF;

  a := public._bank_reconciliation_assert_account(s.bank_account_id);

  IF public.is_period_locked(a.organization_id, a.business_id, s.statement_date) THEN
    RAISE EXCEPTION 'Accounting period for % is locked — a write-off cannot be posted.',
      to_char(s.statement_date, 'YYYY-MM-DD')
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_PERIOD_LOCKED';
  END IF;
  IF a.account_id IS NULL THEN
    RAISE EXCEPTION 'Bank account "%" needs a Chart-of-Accounts link before a write-off can post.', a.name
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_NEEDS_GL';
  END IF;
  IF s.service_charge_account_id IS NULL THEN
    RAISE EXCEPTION 'No write-off account configured for this reconciliation'
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_WRITEOFF_NEEDS_ACCOUNT';
  END IF;

  v_calc := public._bank_reconciliation_recompute(s.id);
  v_diff := (v_calc->>'difference')::numeric;
  v_abs  := ABS(v_diff);

  IF v_abs <= 0.01 THEN
    RAISE EXCEPTION 'Reconciliation is already balanced — nothing to write off'
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_ALREADY_BALANCED';
  END IF;
  IF v_abs > COALESCE(_max_amount, 5.00) THEN
    RAISE EXCEPTION 'Difference of % exceeds the write-off threshold of %', v_abs, COALESCE(_max_amount, 5.00)
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_WRITEOFF_TOO_LARGE';
  END IF;

  v_je := public.post_journal_entry_atomic(
    a.organization_id, a.business_id, NULL, s.statement_date,
    'Recon-WO-' || to_char(s.statement_date, 'YYYY-MM-DD'),
    'Reconciliation write-off - ' || a.name,
    'bank_recon', s.id, auth.uid(), false, false,
    CASE WHEN v_diff > 0 THEN
      jsonb_build_array(
        jsonb_build_object('account_id', a.account_id, 'debit', v_abs, 'credit', 0,
                           'description', 'Reconciliation write-off'),
        jsonb_build_object('account_id', s.service_charge_account_id, 'debit', 0, 'credit', v_abs,
                           'description', 'Reconciliation write-off'))
    ELSE
      jsonb_build_array(
        jsonb_build_object('account_id', s.service_charge_account_id, 'debit', v_abs, 'credit', 0,
                           'description', 'Reconciliation write-off'),
        jsonb_build_object('account_id', a.account_id, 'debit', 0, 'credit', v_abs,
                           'description', 'Reconciliation write-off'))
    END,
    a.currency, NULL, 'writeoff', a.branch_id);

  UPDATE public.bank_reconciliation_sessions
     SET writeoff_amount = v_diff, writeoff_je_id = v_je, updated_at = now()
   WHERE id = s.id;

  RETURN public._bank_reconciliation_recompute(s.id)
       || jsonb_build_object('writeoff_amount', v_diff, 'journal_entry_id', v_je);
END;
$$;

-- ── Complete ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bank_reconciliation_session_complete(
  _session_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s        record;
  a        public.bank_accounts;
  v_calc   jsonb;
  v_diff   numeric;
  v_sc_je  uuid;
  v_int_je uuid;
  v_marked int := 0;
  v_date   date;
BEGIN
  SELECT * INTO s FROM public.bank_reconciliation_sessions WHERE id = _session_id FOR UPDATE;
  IF s.id IS NULL THEN
    RAISE EXCEPTION 'Reconciliation session % not found', _session_id
      USING ERRCODE = 'no_data_found', HINT = 'BANK_RECON_SESSION_NOT_FOUND';
  END IF;
  IF s.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Reconciliation session is already %', s.status
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_SESSION_CLOSED';
  END IF;

  a := public._bank_reconciliation_assert_account(s.bank_account_id);

  IF public.is_period_locked(a.organization_id, a.business_id, s.statement_date) THEN
    RAISE EXCEPTION 'Accounting period for % is locked — reconciliation cannot be completed.',
      to_char(s.statement_date, 'YYYY-MM-DD')
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_PERIOD_LOCKED';
  END IF;

  v_calc := public._bank_reconciliation_recompute(s.id);
  v_diff := (v_calc->>'difference')::numeric;
  IF ABS(v_diff) > 0.01 THEN
    RAISE EXCEPTION 'Cannot complete: an unexplained difference of % remains', round(v_diff, 2)
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_NOT_BALANCED';
  END IF;

  -- Statement adjustments post through the canonical engine, in this
  -- transaction, idempotently (source_type/source_id/source_subtype).
  IF COALESCE(s.service_charge_amount, 0) > 0 THEN
    IF a.account_id IS NULL OR s.service_charge_account_id IS NULL THEN
      RAISE EXCEPTION 'Service charge cannot post without both a bank GL account and an expense account'
        USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_NEEDS_GL';
    END IF;
    v_date := COALESCE(s.service_charge_date, s.statement_date);
    IF public.is_period_locked(a.organization_id, a.business_id, v_date) THEN
      RAISE EXCEPTION 'Accounting period for the service charge date % is locked',
        to_char(v_date, 'YYYY-MM-DD')
        USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_PERIOD_LOCKED';
    END IF;
    v_sc_je := public.post_journal_entry_atomic(
      a.organization_id, a.business_id, NULL, v_date,
      'Recon-SC-' || to_char(s.statement_date, 'YYYY-MM-DD'),
      'Bank service charge - reconciliation ' || to_char(s.statement_date, 'YYYY-MM-DD'),
      'bank_recon', s.id, auth.uid(), false, false,
      jsonb_build_array(
        jsonb_build_object('account_id', s.service_charge_account_id,
          'debit', s.service_charge_amount, 'credit', 0, 'description', 'Bank service charge'),
        jsonb_build_object('account_id', a.account_id,
          'debit', 0, 'credit', s.service_charge_amount, 'description', 'Bank service charge')),
      a.currency, NULL, 'service_charge', a.branch_id);
  END IF;

  IF COALESCE(s.interest_earned_amount, 0) > 0 THEN
    IF a.account_id IS NULL OR s.interest_earned_account_id IS NULL THEN
      RAISE EXCEPTION 'Interest earned cannot post without both a bank GL account and an income account'
        USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_NEEDS_GL';
    END IF;
    v_date := COALESCE(s.interest_earned_date, s.statement_date);
    IF public.is_period_locked(a.organization_id, a.business_id, v_date) THEN
      RAISE EXCEPTION 'Accounting period for the interest date % is locked',
        to_char(v_date, 'YYYY-MM-DD')
        USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_PERIOD_LOCKED';
    END IF;
    v_int_je := public.post_journal_entry_atomic(
      a.organization_id, a.business_id, NULL, v_date,
      'Recon-INT-' || to_char(s.statement_date, 'YYYY-MM-DD'),
      'Interest earned - reconciliation ' || to_char(s.statement_date, 'YYYY-MM-DD'),
      'bank_recon', s.id, auth.uid(), false, false,
      jsonb_build_array(
        jsonb_build_object('account_id', a.account_id,
          'debit', s.interest_earned_amount, 'credit', 0, 'description', 'Interest earned'),
        jsonb_build_object('account_id', s.interest_earned_account_id,
          'debit', 0, 'credit', s.interest_earned_amount, 'description', 'Interest earned')),
      a.currency, NULL, 'interest', a.branch_id);
  END IF;

  -- Statement lines cleared in this session become reconciled facts. This
  -- only stamps reconciliation state; it never mints a payment or a JE for
  -- the line itself — that remains the job of
  -- reconcile_bank_transaction_atomic when a line is matched to a document.
  WITH marked AS (
    UPDATE public.bank_transactions t
       SET is_reconciled = true,
           reconciled_at = now(),
           reconciled_by = COALESCE(auth.uid(), t.reconciled_by),
           lifecycle_status = 'reconciled',
           reconciliation_session_id = s.id,
           updated_at = now()
     WHERE t.is_reconciled = false
       AND t.id IN (SELECT i.transaction_id FROM public.bank_reconciliation_items i
                     WHERE i.session_id = s.id AND i.status = 'cleared')
    RETURNING 1)
  SELECT count(*) INTO v_marked FROM marked;

  UPDATE public.bank_reconciliation_sessions
     SET status = 'completed', completed_at = now(), completed_by = auth.uid(), updated_at = now()
   WHERE id = s.id;

  PERFORM public.publish_business_event(
    a.organization_id, a.branch_id, NULL,
    'banking.reconciliation.completed', 'bank_reconciliation_session', s.id,
    jsonb_build_object('business_id', a.business_id, 'bank_account_id', a.id,
                       'statement_date', s.statement_date,
                       'cleared_marked', v_marked,
                       'service_charge_je_id', v_sc_je,
                       'interest_je_id', v_int_je,
                       'writeoff_je_id', s.writeoff_je_id,
                       'difference', v_diff),
    'bank-recon-complete-' || s.id::text, auth.uid());

  RETURN v_calc || jsonb_build_object(
    'status', 'completed',
    'transactions_marked', v_marked,
    'service_charge_je_id', v_sc_je,
    'interest_je_id', v_int_je);
END;
$$;

-- ── Cancel ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bank_reconciliation_session_cancel(
  _session_id uuid,
  _reason     text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE s record; a public.bank_accounts;
BEGIN
  SELECT * INTO s FROM public.bank_reconciliation_sessions WHERE id = _session_id FOR UPDATE;
  IF s.id IS NULL THEN
    RAISE EXCEPTION 'Reconciliation session % not found', _session_id
      USING ERRCODE = 'no_data_found', HINT = 'BANK_RECON_SESSION_NOT_FOUND';
  END IF;
  IF s.status = 'cancelled' THEN
    RETURN jsonb_build_object('session_id', s.id, 'status', 'cancelled');
  END IF;
  IF s.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Reconciliation session is % and can no longer be cancelled', s.status
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_SESSION_CLOSED';
  END IF;

  a := public._bank_reconciliation_assert_account(s.bank_account_id);

  -- Cleared marks are provenance: keep the rows, drop the cleared state.
  UPDATE public.bank_reconciliation_items
     SET status = 'uncleared', cleared_at = NULL
   WHERE session_id = s.id AND status = 'cleared';

  UPDATE public.bank_reconciliation_sessions
     SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
         cancel_reason = NULLIF(btrim(COALESCE(_reason, '')), ''), updated_at = now()
   WHERE id = s.id;

  PERFORM public.publish_business_event(
    a.organization_id, a.branch_id, NULL,
    'banking.reconciliation.cancelled', 'bank_reconciliation_session', s.id,
    jsonb_build_object('business_id', a.business_id, 'bank_account_id', a.id,
                       'statement_date', s.statement_date, 'reason', _reason),
    'bank-recon-cancel-' || s.id::text, auth.uid());

  RETURN jsonb_build_object('session_id', s.id, 'status', 'cancelled');
END;
$$;

-- ── Categorization write seam ─────────────────────────────────────────────
-- Categorizing an imported line is the last remaining client-side mutation of
-- bank_transactions; it now goes through the server so the same lifecycle and
-- scope gates apply to it as to ingestion.
CREATE OR REPLACE FUNCTION public.bank_transaction_set_category(
  _transaction_ids uuid[],
  _category        text,
  _confidence      numeric DEFAULT 1.0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz     uuid;
  v_updated int := 0;
BEGIN
  IF _transaction_ids IS NULL OR array_length(_transaction_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No transactions selected'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'BANK_CATEGORY_NO_ROWS';
  END IF;
  IF COALESCE(btrim(_category), '') = '' THEN
    RAISE EXCEPTION 'A category is required'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'BANK_CATEGORY_EMPTY';
  END IF;

  IF auth.uid() IS NULL AND current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Categorizing bank transactions requires an authenticated caller'
      USING ERRCODE = '42501', HINT = 'BANK_CATEGORY_NO_ACTOR';
  END IF;

  IF auth.uid() IS NOT NULL THEN
    FOR v_biz IN
      SELECT DISTINCT business_id FROM public.bank_transactions WHERE id = ANY(_transaction_ids)
    LOOP
      PERFORM public.assert_can_reconcile_bank(v_biz);
    END LOOP;
  END IF;

  WITH upd AS (
    UPDATE public.bank_transactions
       SET category = btrim(_category),
           category_confidence = COALESCE(_confidence, 1.0),
           updated_at = now()
     WHERE id = ANY(_transaction_ids)
    RETURNING 1)
  SELECT count(*) INTO v_updated FROM upd;

  RETURN jsonb_build_object('updated', v_updated, 'category', btrim(_category));
END;
$$;

-- ── Privileges: the seam is the only writer ───────────────────────────────
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.bank_reconciliation_sessions FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.bank_reconciliation_items    FROM authenticated;
REVOKE ALL ON public.bank_reconciliation_sessions FROM anon;
REVOKE ALL ON public.bank_reconciliation_items    FROM anon;
GRANT SELECT ON public.bank_reconciliation_sessions TO authenticated;
GRANT SELECT ON public.bank_reconciliation_items    TO authenticated;
GRANT ALL ON public.bank_reconciliation_sessions TO service_role;
GRANT ALL ON public.bank_reconciliation_items    TO service_role;

REVOKE ALL ON FUNCTION public._bank_reconciliation_recompute(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._bank_reconciliation_assert_account(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_reconciliation_session_start(uuid, date, numeric, numeric, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_reconciliation_item_set(uuid, uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_reconciliation_session_writeoff(uuid, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_reconciliation_session_complete(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_reconciliation_session_cancel(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_transaction_set_category(uuid[], text, numeric) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.bank_reconciliation_session_start(uuid, date, numeric, numeric, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_item_set(uuid, uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_session_writeoff(uuid, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_session_complete(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_session_cancel(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bank_transaction_set_category(uuid[], text, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._bank_reconciliation_recompute(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public._bank_reconciliation_assert_account(uuid) TO service_role;