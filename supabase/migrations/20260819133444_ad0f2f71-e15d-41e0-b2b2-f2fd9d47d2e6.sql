CREATE OR REPLACE FUNCTION public._bank_reconciliation_gl_tieout(_session_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH s AS (
    SELECT * FROM public.bank_reconciliation_sessions WHERE id = _session_id
  ),
  acct AS (
    SELECT ba.account_id FROM public.bank_accounts ba JOIN s ON s.bank_account_id = ba.id
  ),
  lines AS (
    SELECT bt.id,
           bt.journal_entry_id AS je,
           CASE WHEN bt.transaction_type = 'credit' THEN ABS(bt.amount)
                WHEN bt.transaction_type = 'debit'  THEN -ABS(bt.amount)
                ELSE bt.amount END AS signed
      FROM public.bank_transactions bt, s
     WHERE bt.bank_account_id = s.bank_account_id
       AND bt.transaction_date <= s.statement_date
       AND (COALESCE(bt.is_reconciled, false)
            OR EXISTS (SELECT 1 FROM public.bank_reconciliation_items i
                        WHERE i.session_id = s.id AND i.transaction_id = bt.id
                          AND i.status = 'cleared'))
  ),
  confirmed AS (
    SELECT m.* FROM public.bank_reconciliation_matches m
      JOIN lines l ON l.id = m.bank_transaction_id
     WHERE m.status = 'confirmed'
  ),
  entries AS (
    SELECT DISTINCT e FROM (
      SELECT l.je AS e FROM lines l
      UNION ALL SELECT c.matched_journal_entry_id FROM confirmed c
      UNION ALL SELECT c.adjustment_journal_entry_id FROM confirmed c
      UNION ALL SELECT c.fee_journal_entry_id FROM confirmed c
    ) z WHERE e IS NOT NULL
  ),
  gl AS (
    SELECT COALESCE(SUM(jel.debit - jel.credit), 0) AS movement
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
     WHERE je.status = 'posted'
       AND jel.account_id = (SELECT account_id FROM acct)
       AND jel.journal_entry_id IN (SELECT e FROM entries)
  ),
  unposted AS (
    SELECT count(*) AS n FROM lines l
     WHERE l.je IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM confirmed c
          WHERE c.bank_transaction_id = l.id
            AND COALESCE(c.matched_journal_entry_id, c.adjustment_journal_entry_id, c.fee_journal_entry_id) IS NOT NULL)
  )
  SELECT jsonb_build_object(
    'gl_account_id', (SELECT account_id FROM acct),
    'checked', (SELECT account_id FROM acct) IS NOT NULL,
    'cleared_movement', COALESCE((SELECT SUM(signed) FROM lines), 0),
    'gl_movement', CASE WHEN (SELECT account_id FROM acct) IS NULL THEN NULL
                        ELSE (SELECT movement FROM gl) END,
    'divergence', CASE WHEN (SELECT account_id FROM acct) IS NULL THEN NULL
                       ELSE round(COALESCE((SELECT SUM(signed) FROM lines), 0) - (SELECT movement FROM gl), 2) END,
    'cleared_without_posting', (SELECT n FROM unposted)
  )
$function$;

REVOKE ALL ON FUNCTION public._bank_reconciliation_gl_tieout(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._bank_reconciliation_gl_tieout(uuid) TO service_role;