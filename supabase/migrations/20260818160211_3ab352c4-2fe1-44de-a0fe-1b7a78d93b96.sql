
-- =====================================================================
-- Phase 18 — reconciliation close is a proven seam, one balance
-- projection, scheduled feed sync.
-- =====================================================================

-- ── 18.2 One movement/balance projection ────────────────────────────
CREATE OR REPLACE FUNCTION public._bank_account_movement(
  _bank_account_id uuid,
  _as_of date,
  _session_id uuid DEFAULT NULL
)
RETURNS TABLE(
  net_amount          numeric,
  cleared_net         numeric,
  cleared_count       bigint,
  unreconciled_count  bigint,
  unreconciled_amount numeric,
  last_line_date      date
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH lines AS (
    SELECT
      bt.transaction_date,
      CASE
        WHEN bt.transaction_type = 'credit' THEN ABS(bt.amount)
        WHEN bt.transaction_type = 'debit'  THEN -ABS(bt.amount)
        ELSE bt.amount
      END AS signed_amount,
      COALESCE(bt.is_reconciled, false) AS is_reconciled,
      (
        COALESCE(bt.is_reconciled, false)
        OR (_session_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM public.bank_reconciliation_items i
              WHERE i.session_id = _session_id
                AND i.transaction_id = bt.id
                AND i.status = 'cleared'))
      ) AS is_cleared
    FROM public.bank_transactions bt
    WHERE bt.bank_account_id = _bank_account_id
      AND bt.transaction_date <= _as_of
  )
  SELECT
    COALESCE(SUM(signed_amount), 0),
    COALESCE(SUM(signed_amount) FILTER (WHERE is_cleared), 0),
    COUNT(*) FILTER (WHERE is_cleared),
    COUNT(*) FILTER (WHERE NOT is_reconciled),
    COALESCE(SUM(signed_amount) FILTER (WHERE NOT is_reconciled), 0),
    MAX(transaction_date)
  FROM lines;
$function$;

REVOKE ALL ON FUNCTION public._bank_account_movement(uuid, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._bank_account_movement(uuid, date, uuid) TO authenticated, service_role;

-- The canonical cash position now consumes that one projection.
CREATE OR REPLACE FUNCTION public.bank_account_positions(
  _business_id uuid,
  _as_of date DEFAULT CURRENT_DATE
)
RETURNS TABLE(
  bank_account_id uuid, currency text, opening_balance numeric,
  statement_balance numeric, last_statement_line_date date, gl_balance numeric,
  gl_shared boolean, unreconciled_count bigint, unreconciled_amount numeric, as_of date
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT
    a.id,
    a.currency,
    COALESCE(a.opening_balance, 0),
    COALESCE(a.opening_balance, 0) + COALESCE(m.net_amount, 0),
    m.last_line_date,
    CASE WHEN a.account_id IS NULL OR shared.n > 1 THEN NULL ELSE COALESCE(g.gl_net, 0) END,
    COALESCE(shared.n, 0) > 1,
    COALESCE(m.unreconciled_count, 0),
    COALESCE(m.unreconciled_amount, 0),
    _as_of
  FROM public.bank_accounts a
  LEFT JOIN LATERAL public._bank_account_movement(a.id, _as_of, NULL) m ON TRUE
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
$function$;

-- The reconciliation recompute consumes the same projection, session-scoped.
CREATE OR REPLACE FUNCTION public._bank_reconciliation_recompute(_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  s          record;
  m          record;
  v_balance  numeric;
  v_diff     numeric;
BEGIN
  SELECT * INTO s FROM public.bank_reconciliation_sessions WHERE id = _session_id FOR UPDATE;
  IF s.id IS NULL THEN
    RAISE EXCEPTION 'Reconciliation session % not found', _session_id
      USING ERRCODE = 'no_data_found', HINT = 'BANK_RECON_SESSION_NOT_FOUND';
  END IF;

  SELECT * INTO m
  FROM public._bank_account_movement(s.bank_account_id, s.statement_date, s.id);

  v_balance := m.cleared_net
             - COALESCE(s.service_charge_amount, 0)
             + COALESCE(s.interest_earned_amount, 0)
             + COALESCE(s.writeoff_amount, 0);

  UPDATE public.bank_reconciliation_sessions
     SET reconciled_balance = v_balance, updated_at = now()
   WHERE id = s.id;

  v_diff := (s.closing_balance - s.opening_balance) - v_balance;

  RETURN jsonb_build_object(
    'session_id',         s.id,
    'cleared_count',      m.cleared_count,
    'cleared_movement',   m.cleared_net,
    'reconciled_balance', v_balance,
    'cleared_balance',    s.opening_balance + v_balance,
    'difference',         v_diff,
    'is_balanced',        ABS(v_diff) <= 0.01
  );
END;
$function$;

-- ── 18.1 Completion: no write to the dropped session pointer ────────
CREATE OR REPLACE FUNCTION public.bank_reconciliation_session_complete(_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

  -- Statement lines cleared in this session become reconciled facts. The link
  -- between a line and the session it was cleared in has exactly one
  -- representation: `bank_reconciliation_items`.
  WITH marked AS (
    UPDATE public.bank_transactions t
       SET is_reconciled = true,
           reconciled_at = now(),
           reconciled_by = COALESCE(auth.uid(), t.reconciled_by),
           lifecycle_status = 'reconciled',
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
$function$;

-- ── 18.1 A closed session is frozen ─────────────────────────────────
CREATE OR REPLACE FUNCTION public._bank_reconciliation_session_freeze()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.status = 'in_progress' THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Reconciliation session % is % and cannot change state', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_SESSION_CLOSED';
  END IF;

  IF (NEW.bank_account_id, NEW.statement_date, NEW.opening_balance, NEW.closing_balance,
      NEW.reconciled_balance, NEW.service_charge_amount, NEW.service_charge_date,
      NEW.service_charge_account_id, NEW.interest_earned_amount, NEW.interest_earned_date,
      NEW.interest_earned_account_id, NEW.writeoff_amount, NEW.writeoff_je_id)
     IS DISTINCT FROM
     (OLD.bank_account_id, OLD.statement_date, OLD.opening_balance, OLD.closing_balance,
      OLD.reconciled_balance, OLD.service_charge_amount, OLD.service_charge_date,
      OLD.service_charge_account_id, OLD.interest_earned_amount, OLD.interest_earned_date,
      OLD.interest_earned_account_id, OLD.writeoff_amount, OLD.writeoff_je_id)
  THEN
    RAISE EXCEPTION 'Reconciliation session % is % — its statement figures are frozen', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_SESSION_FROZEN';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS bank_reconciliation_session_freeze ON public.bank_reconciliation_sessions;
CREATE TRIGGER bank_reconciliation_session_freeze
  BEFORE UPDATE ON public.bank_reconciliation_sessions
  FOR EACH ROW EXECUTE FUNCTION public._bank_reconciliation_session_freeze();

-- ── 18.4 Scheduled feed sync ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bank_feed_dispatch_due()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  c           record;
  v_dispatched int := 0;
  v_skipped    int := 0;
  v_interval   interval;
BEGIN
  FOR c IN
    SELECT fc.id, fc.bank_account_id, fc.organization_id, fc.sync_frequency, fc.last_run_at
    FROM public.bank_feed_connections fc
    WHERE fc.auto_sync_enabled = true
      AND fc.status = 'active'
  LOOP
    -- Concurrency is owned by the partial unique index on the run seam; a run
    -- that is still in flight is skipped here rather than retried.
    IF EXISTS (
      SELECT 1 FROM public.bank_feed_runs r
      WHERE r.connection_id = c.id AND r.status = 'running'
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    SELECT CASE c.sync_frequency
             WHEN 'hourly' THEN interval '1 hour'
             WHEN 'daily'  THEN interval '1 day'
             WHEN 'weekly' THEN interval '7 days'
             ELSE interval '1 day'
           END
      INTO v_interval;

    IF c.last_run_at IS NOT NULL AND (now() - c.last_run_at) < v_interval THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    PERFORM net.http_post(
      url     => 'https://jkszmrroyjfdwokbkzis.supabase.co/functions/v1/sync-bank-transactions',
      headers => public.cron_caller_auth_header(),
      body    => jsonb_build_object(
                   'bank_account_id', c.bank_account_id,
                   'organization_id', c.organization_id,
                   'trigger_source', 'schedule')
    );
    v_dispatched := v_dispatched + 1;
  END LOOP;

  RETURN jsonb_build_object('dispatched', v_dispatched, 'skipped', v_skipped);
END;
$function$;

REVOKE ALL ON FUNCTION public.bank_feed_dispatch_due() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bank_feed_dispatch_due() TO service_role;

SELECT cron.unschedule('bank-feeds-scheduled-sync')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'bank-feeds-scheduled-sync');

SELECT cron.schedule(
  'bank-feeds-scheduled-sync',
  '7 * * * *',
  $cron$SELECT public.bank_feed_dispatch_due();$cron$
);
