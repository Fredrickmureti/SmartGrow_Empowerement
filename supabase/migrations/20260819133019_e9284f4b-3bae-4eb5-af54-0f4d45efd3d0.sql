-- =====================================================================
-- Reconciliation engine · Phase 11 — a completed reconciliation is a fact
-- F17 closed-window guard, F18 GL tie-out, F19 persisted difference,
-- plus an audited reopen.
-- =====================================================================

-- ---------------------------------------------------------------------
-- F17.1 — the question "is this line inside a closed reconciliation?"
--         has exactly one definition.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._bank_recon_closed_session(_bank_account_id uuid, _txn_date date)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT s.id
    FROM public.bank_reconciliation_sessions s
   WHERE s.bank_account_id = _bank_account_id
     AND s.status = 'completed'
     AND _txn_date IS NOT NULL
     AND _txn_date <= s.statement_date
   ORDER BY s.statement_date DESC
   LIMIT 1
$function$;

REVOKE ALL ON FUNCTION public._bank_recon_closed_session(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._bank_recon_closed_session(uuid, date) FROM anon;
REVOKE ALL ON FUNCTION public._bank_recon_closed_session(uuid, date) FROM authenticated;
GRANT EXECUTE ON FUNCTION public._bank_recon_closed_session(uuid, date) TO service_role;

-- ---------------------------------------------------------------------
-- F17.2 — no match may be born, confirmed, reversed or rejected against a
--         line that a completed reconciliation already explained.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._bank_match_closed_window_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  t record;
  closed uuid;
BEGIN
  IF public._is_teardown_active() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  SELECT bank_account_id, transaction_date INTO t
    FROM public.bank_transactions WHERE id = NEW.bank_transaction_id;
  IF t.bank_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  closed := public._bank_recon_closed_session(t.bank_account_id, t.transaction_date);
  IF closed IS NOT NULL THEN
    RAISE EXCEPTION 'BANK_MATCH_SESSION_CLOSED: bank line dated % falls inside a completed reconciliation (%). Reopen that reconciliation before changing how the line is explained.',
      to_char(t.transaction_date, 'YYYY-MM-DD'), closed
      USING ERRCODE = 'check_violation', HINT = 'BANK_MATCH_SESSION_CLOSED';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_bank_match_closed_window ON public.bank_reconciliation_matches;
CREATE TRIGGER trg_bank_match_closed_window
  BEFORE INSERT OR UPDATE OF status ON public.bank_reconciliation_matches
  FOR EACH ROW EXECUTE FUNCTION public._bank_match_closed_window_guard();

-- ---------------------------------------------------------------------
-- F17.3 — nor may the reconciled state of such a line be flipped, from any
--         path (seam, unreconcile, importer, direct write).
--         `bank_reconciliation_session_complete` is unaffected: its own
--         session is still `in_progress` while it marks lines.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._bank_txn_reconcile_closed_window_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE closed uuid;
BEGIN
  IF public._is_teardown_active() THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.is_reconciled, false) IS NOT DISTINCT FROM COALESCE(OLD.is_reconciled, false) THEN
    RETURN NEW;
  END IF;

  closed := public._bank_recon_closed_session(NEW.bank_account_id, NEW.transaction_date);
  IF closed IS NOT NULL THEN
    RAISE EXCEPTION 'BANK_UNRECONCILE_SESSION_CLOSED: bank line dated % belongs to a completed reconciliation (%). Reopen that reconciliation first.',
      to_char(NEW.transaction_date, 'YYYY-MM-DD'), closed
      USING ERRCODE = 'check_violation', HINT = 'BANK_UNRECONCILE_SESSION_CLOSED';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_bank_txn_reconcile_closed_window ON public.bank_transactions;
CREATE TRIGGER trg_bank_txn_reconcile_closed_window
  BEFORE UPDATE OF is_reconciled ON public.bank_transactions
  FOR EACH ROW EXECUTE FUNCTION public._bank_txn_reconcile_closed_window_guard();

-- ---------------------------------------------------------------------
-- F17.4 — reopening is a deliberate act. The freeze trigger permits the
--         completed -> in_progress transition only under the GUC that
--         `bank_reconciliation_session_reopen` sets locally.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._bank_reconciliation_session_freeze()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.status = 'in_progress' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'completed'
     AND NEW.status = 'in_progress'
     AND COALESCE(NULLIF(current_setting('app.bank_recon_reopen', true), ''), 'off') = 'on'
  THEN
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

CREATE OR REPLACE FUNCTION public.bank_reconciliation_session_reopen(_session_id uuid, _reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  s record;
  a public.bank_accounts;
  later uuid;
BEGIN
  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to reopen a completed reconciliation'
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_REOPEN_NEEDS_REASON';
  END IF;

  SELECT * INTO s FROM public.bank_reconciliation_sessions WHERE id = _session_id FOR UPDATE;
  IF s.id IS NULL THEN
    RAISE EXCEPTION 'Reconciliation session % not found', _session_id
      USING ERRCODE = 'no_data_found', HINT = 'BANK_RECON_SESSION_NOT_FOUND';
  END IF;
  IF s.status <> 'completed' THEN
    RAISE EXCEPTION 'Only a completed reconciliation can be reopened — this one is %', s.status
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_NOT_COMPLETED';
  END IF;

  a := public._bank_reconciliation_assert_account(s.bank_account_id);

  IF public.is_period_locked(a.organization_id, a.business_id, s.statement_date) THEN
    RAISE EXCEPTION 'Accounting period for % is locked — the reconciliation cannot be reopened.',
      to_char(s.statement_date, 'YYYY-MM-DD')
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_PERIOD_LOCKED';
  END IF;

  -- A later closed reconciliation depends on this one's result: reopening out
  -- of order would silently invalidate it.
  SELECT id INTO later
    FROM public.bank_reconciliation_sessions
   WHERE bank_account_id = s.bank_account_id
     AND status = 'completed'
     AND statement_date > s.statement_date
   ORDER BY statement_date
   LIMIT 1;
  IF later IS NOT NULL THEN
    RAISE EXCEPTION 'A later reconciliation (%) is already completed — reopen it first.', later
      USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_LATER_SESSION_CLOSED';
  END IF;

  PERFORM set_config('app.bank_recon_reopen', 'on', true);

  UPDATE public.bank_reconciliation_sessions
     SET status = 'in_progress',
         completed_at = NULL,
         completed_by = NULL,
         notes = btrim(concat_ws(' | ', notes, 'Reopened: ' || _reason)),
         updated_at = now()
   WHERE id = s.id;

  PERFORM set_config('app.bank_recon_reopen', 'off', true);

  PERFORM public.publish_business_event(
    a.organization_id, a.branch_id, NULL,
    'banking.reconciliation.reopened', 'bank_reconciliation_session', s.id,
    jsonb_build_object('business_id', a.business_id, 'bank_account_id', a.id,
                       'statement_date', s.statement_date, 'reason', _reason,
                       'previously_completed_at', s.completed_at,
                       'previously_completed_by', s.completed_by),
    'bank-recon-reopen-' || s.id::text || '-' || extract(epoch from now())::bigint::text,
    auth.uid());

  RETURN public._bank_reconciliation_recompute(s.id) || jsonb_build_object('status', 'in_progress', 'reopened', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.bank_reconciliation_session_reopen(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bank_reconciliation_session_reopen(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_session_reopen(uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- F18 — a reconciliation is tied out against the ledger, not against
--       itself: the cleared statement movement must equal the bank GL
--       movement posted by the entries those cleared lines carry.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._bank_reconciliation_gl_tieout(_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  s record;
  gl_account uuid;
  v_cleared numeric := 0;
  v_gl numeric := 0;
  v_unposted bigint := 0;
BEGIN
  SELECT * INTO s FROM public.bank_reconciliation_sessions WHERE id = _session_id;
  IF s.id IS NULL THEN
    RETURN jsonb_build_object('gl_account_id', NULL, 'checked', false);
  END IF;

  SELECT account_id INTO gl_account FROM public.bank_accounts WHERE id = s.bank_account_id;

  CREATE TEMP TABLE IF NOT EXISTS _tieout_lines (id uuid, je uuid, signed numeric) ON COMMIT DROP;
  DELETE FROM _tieout_lines;

  INSERT INTO _tieout_lines
  SELECT bt.id,
         bt.journal_entry_id,
         CASE WHEN bt.transaction_type = 'credit' THEN ABS(bt.amount)
              WHEN bt.transaction_type = 'debit'  THEN -ABS(bt.amount)
              ELSE bt.amount END
    FROM public.bank_transactions bt
   WHERE bt.bank_account_id = s.bank_account_id
     AND bt.transaction_date <= s.statement_date
     AND (COALESCE(bt.is_reconciled, false)
          OR EXISTS (SELECT 1 FROM public.bank_reconciliation_items i
                      WHERE i.session_id = s.id AND i.transaction_id = bt.id AND i.status = 'cleared'));

  SELECT COALESCE(SUM(signed), 0) INTO v_cleared FROM _tieout_lines;

  SELECT count(*) INTO v_unposted
    FROM _tieout_lines l
   WHERE l.je IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.bank_reconciliation_matches m
                      WHERE m.bank_transaction_id = l.id AND m.status = 'confirmed'
                        AND COALESCE(m.matched_journal_entry_id, m.adjustment_journal_entry_id, m.fee_journal_entry_id) IS NOT NULL);

  IF gl_account IS NULL THEN
    RETURN jsonb_build_object(
      'gl_account_id', NULL, 'checked', false,
      'cleared_movement', v_cleared, 'gl_movement', NULL,
      'divergence', NULL, 'cleared_without_posting', v_unposted);
  END IF;

  WITH entries AS (
    SELECT DISTINCT e FROM (
      SELECT l.je AS e FROM _tieout_lines l WHERE l.je IS NOT NULL
      UNION ALL
      SELECT m.matched_journal_entry_id FROM public.bank_reconciliation_matches m
        JOIN _tieout_lines l ON l.id = m.bank_transaction_id
       WHERE m.status = 'confirmed' AND m.matched_journal_entry_id IS NOT NULL
      UNION ALL
      SELECT m.adjustment_journal_entry_id FROM public.bank_reconciliation_matches m
        JOIN _tieout_lines l ON l.id = m.bank_transaction_id
       WHERE m.status = 'confirmed' AND m.adjustment_journal_entry_id IS NOT NULL
      UNION ALL
      SELECT m.fee_journal_entry_id FROM public.bank_reconciliation_matches m
        JOIN _tieout_lines l ON l.id = m.bank_transaction_id
       WHERE m.status = 'confirmed' AND m.fee_journal_entry_id IS NOT NULL
    ) z WHERE e IS NOT NULL
  )
  SELECT COALESCE(SUM(jel.debit - jel.credit), 0) INTO v_gl
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
   WHERE jel.account_id = gl_account
     AND je.status = 'posted'
     AND jel.journal_entry_id IN (SELECT e FROM entries);

  RETURN jsonb_build_object(
    'gl_account_id', gl_account,
    'checked', true,
    'cleared_movement', v_cleared,
    'gl_movement', v_gl,
    'divergence', round(v_cleared - v_gl, 2),
    'cleared_without_posting', v_unposted);
END;
$function$;

REVOKE ALL ON FUNCTION public._bank_reconciliation_gl_tieout(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._bank_reconciliation_gl_tieout(uuid) FROM anon;
REVOKE ALL ON FUNCTION public._bank_reconciliation_gl_tieout(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public._bank_reconciliation_gl_tieout(uuid) TO service_role;

-- ---------------------------------------------------------------------
-- F19 — the difference is written by the one function that computes it,
--       and the GL tie-out travels with every recompute payload.
-- ---------------------------------------------------------------------
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
  v_tieout   jsonb;
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

  v_diff := (s.closing_balance - s.opening_balance) - v_balance;

  -- The stored difference has exactly one writer: this function.
  UPDATE public.bank_reconciliation_sessions
     SET reconciled_balance = v_balance,
         difference = round(v_diff, 2),
         updated_at = now()
   WHERE id = s.id;

  v_tieout := public._bank_reconciliation_gl_tieout(s.id);

  RETURN jsonb_build_object(
    'session_id',         s.id,
    'cleared_count',      m.cleared_count,
    'cleared_movement',   m.cleared_net,
    'reconciled_balance', v_balance,
    'cleared_balance',    s.opening_balance + v_balance,
    'difference',         v_diff,
    'is_balanced',        ABS(v_diff) <= 0.01,
    'gl_tieout',          v_tieout
  );
END;
$function$;

-- Completion refuses when the ledger disagrees with the statement.
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
  v_tie    jsonb;
  v_gldiff numeric;
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

  -- F18: the cleared statement lines must agree with what the ledger says
  -- moved through this bank account. A settlement posted to another account
  -- balances the statement while corrupting the ledger — refuse it.
  v_tie := v_calc->'gl_tieout';
  IF COALESCE((v_tie->>'checked')::boolean, false) THEN
    v_gldiff := COALESCE((v_tie->>'divergence')::numeric, 0);
    IF ABS(v_gldiff) > 0.01 THEN
      RAISE EXCEPTION 'Cannot complete: cleared statement movement differs from the bank ledger movement by % — a cleared line is posted somewhere other than this bank account.',
        round(v_gldiff, 2)
        USING ERRCODE = 'check_violation', HINT = 'BANK_RECON_GL_DIVERGENCE';
    END IF;
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
                       'difference', v_diff,
                       'gl_tieout', v_tie),
    'bank-recon-complete-' || s.id::text, auth.uid());

  RETURN v_calc || jsonb_build_object(
    'status', 'completed',
    'transactions_marked', v_marked,
    'service_charge_je_id', v_sc_je,
    'interest_je_id', v_int_je);
END;
$function$;