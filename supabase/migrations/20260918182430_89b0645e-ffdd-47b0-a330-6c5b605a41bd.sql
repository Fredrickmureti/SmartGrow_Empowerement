-- Reversal-safe balance reads.
--
-- A reversed entry keeps its lines and gets an offsetting entry. Readers that
-- filter `je.status = 'posted'` drop the original but keep the reversal, so the
-- balance moves by the reversed amount. `ledger_visible_journal_statuses()`
-- ('posted','reversed') is the shared definition already used by
-- get_general_ledger; every balance reader must use it too.

GRANT EXECUTE ON FUNCTION public.ledger_visible_journal_statuses() TO anon, authenticated, service_role;

DO $rewrite$
DECLARE
  r RECORD;
  v_def text;
  v_new text;
  v_targets text[] := ARRAY[
    'get_account_balances',
    'get_account_balance_at_date',
    'assert_trial_balance',
    'bank_account_positions',
    'branch_day_cash_report',
    'finance_bank_reconciliation_statement',
    'finance_cash_flow_statement',
    'fx_exposure_by_currency',
    'fx_exposure_open_items',
    'fx_open_monetary_positions',
    'fx_revaluation_readiness',
    'get_control_account_reconciliation',
    'get_dashboard_stats',
    'get_executive_stats',
    'get_gl_transactions',
    '_bank_reconciliation_gl_tieout'
  ];
  v_touched int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (v_targets)
      AND p.prosrc ~ 'journal_entry_lines'
      AND p.prosrc ~ 'status\s*=\s*''posted'''
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(
      v_def,
      '(\m[A-Za-z_][A-Za-z0-9_]*\.)?status\s*=\s*''posted''',
      '\1status = ANY (public.ledger_visible_journal_statuses())',
      'g'
    );
    IF v_new = v_def THEN
      RAISE EXCEPTION 'no posted-only filter rewritten in %', r.proname;
    END IF;
    EXECUTE v_new;
    v_touched := v_touched + 1;
  END LOOP;

  IF v_touched = 0 THEN
    RAISE EXCEPTION 'balance readers were not rewritten';
  END IF;
  RAISE NOTICE 'reversal-safe rewrite applied to % functions', v_touched;
END
$rewrite$;
