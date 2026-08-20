CREATE OR REPLACE FUNCTION public.finance_bank_reconciliation_statement(
  _org_id uuid,
  _bank_account_id uuid,
  _as_of date,
  _business_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  a           record;
  v_shared    integer;
  v_opening   numeric;
  v_from      date;
  v_result    jsonb;
  v_items_cap constant integer := 200;
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'not a member of this organization'
      USING ERRCODE = '42501';
  END IF;

  IF _as_of IS NULL THEN
    RAISE EXCEPTION 'as-of date is required' USING ERRCODE = '22004';
  END IF;

  SELECT ba.id, ba.name, ba.bank_name, ba.account_number, ba.currency,
         ba.account_id, ba.business_id, ba.branch_id,
         COALESCE(ba.opening_balance, 0)::numeric AS opening_balance,
         ba.opening_balance_date, ba.opening_balance_je_id, ba.lifecycle_status
    INTO a
    FROM public.bank_accounts ba
   WHERE ba.id = _bank_account_id
     AND ba.organization_id = _org_id
     AND (_business_id IS NULL OR ba.business_id = _business_id)
     AND (_branch_id IS NULL OR ba.branch_id = _branch_id OR ba.branch_id IS NULL);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank account not found in this organization'
      USING ERRCODE = '42501';
  END IF;

  -- The opening balance is an assertion as at its own date. Before that date
  -- it does not exist; on/after it, the statement lines it already contains
  -- must not be counted twice.
  IF a.opening_balance_date IS NULL OR a.opening_balance_date <= _as_of THEN
    v_opening := a.opening_balance;
    v_from    := a.opening_balance_date;
  ELSE
    v_opening := 0;
    v_from    := NULL;
  END IF;

  SELECT COUNT(*) INTO v_shared
    FROM public.bank_accounts sib
   WHERE sib.business_id IS NOT DISTINCT FROM a.business_id
     AND sib.account_id IS NOT DISTINCT FROM a.account_id
     AND sib.account_id IS NOT NULL
     AND sib.lifecycle_status <> 'closed';

  WITH txn AS (
    SELECT bt.id,
           bt.transaction_date,
           bt.description,
           bt.reference,
           bt.journal_entry_id,
           COALESCE(bt.is_reconciled, false) AS is_reconciled,
           CASE
             WHEN bt.transaction_type = 'credit' THEN  ABS(bt.amount)
             WHEN bt.transaction_type = 'debit'  THEN -ABS(bt.amount)
             ELSE bt.amount
           END::numeric AS signed
      FROM public.bank_transactions bt
     WHERE bt.bank_account_id = a.id
       AND bt.transaction_date <= _as_of
       AND (v_from IS NULL OR bt.transaction_date >= v_from)
  ),
  confirmed AS (
    SELECT m.bank_transaction_id,
           m.matched_journal_entry_id,
           m.adjustment_journal_entry_id,
           m.fee_journal_entry_id
      FROM public.bank_reconciliation_matches m
      JOIN txn t ON t.id = m.bank_transaction_id
     WHERE m.status = 'confirmed'
  ),
  match_je AS (
    SELECT DISTINCT je_id FROM (
      SELECT t.journal_entry_id       AS je_id FROM txn t
      UNION ALL SELECT c.matched_journal_entry_id    FROM confirmed c
      UNION ALL SELECT c.adjustment_journal_entry_id FROM confirmed c
      UNION ALL SELECT c.fee_journal_entry_id        FROM confirmed c
    ) z WHERE je_id IS NOT NULL
  ),
  gl_lines AS (
    SELECT jel.id,
           je.id            AS je_id,
           je.entry_date,
           je.entry_number,
           COALESCE(NULLIF(jel.description, ''), je.description) AS description,
           je.source_type,
           COALESCE(je.is_opening_entry, false) AS is_opening_entry,
           CASE
             WHEN jel.original_currency IS NOT NULL
              AND jel.original_currency = a.currency
              AND (jel.original_debit IS NOT NULL OR jel.original_credit IS NOT NULL)
               THEN COALESCE(jel.original_debit, 0) - COALESCE(jel.original_credit, 0)
             ELSE COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0)
           END::numeric AS signed,
           (a.currency IS DISTINCT FROM COALESCE(jel.original_currency, a.currency)) AS currency_fallback
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
     WHERE a.account_id IS NOT NULL
       AND v_shared <= 1
       AND jel.account_id = a.account_id
       AND je.status = 'posted'
       AND je.entry_date <= _as_of
       AND je.business_id IS NOT DISTINCT FROM a.business_id
       AND (_branch_id IS NULL OR jel.branch_id = _branch_id OR jel.branch_id IS NULL)
  ),
  outstanding AS (
    SELECT g.*
      FROM gl_lines g
     WHERE g.je_id NOT IN (SELECT je_id FROM match_je)
       AND NOT g.is_opening_entry
       AND g.je_id IS DISTINCT FROM a.opening_balance_je_id
       AND ABS(g.signed) >= 0.005
  ),
  unrecorded AS (
    SELECT t.*
      FROM txn t
     WHERE t.journal_entry_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM confirmed c
          WHERE c.bank_transaction_id = t.id
            AND COALESCE(c.matched_journal_entry_id,
                         c.adjustment_journal_entry_id,
                         c.fee_journal_entry_id) IS NOT NULL)
       AND ABS(t.signed) >= 0.005
  ),
  agg AS (
    SELECT
      (SELECT COALESCE(SUM(signed), 0) FROM txn)                              AS statement_lines_net,
      (SELECT COUNT(*) FROM txn)                                              AS statement_line_count,
      (SELECT MAX(transaction_date) FROM txn)                                 AS last_statement_date,
      (SELECT COALESCE(SUM(signed), 0) FROM outstanding WHERE signed > 0)     AS deposits_total,
      (SELECT COUNT(*) FROM outstanding WHERE signed > 0)                     AS deposits_count,
      (SELECT COALESCE(-SUM(signed), 0) FROM outstanding WHERE signed < 0)    AS unpresented_total,
      (SELECT COUNT(*) FROM outstanding WHERE signed < 0)                     AS unpresented_count,
      (SELECT COALESCE(SUM(signed), 0) FROM gl_lines)                         AS gl_balance,
      (SELECT COALESCE(SUM(signed), 0) FROM unrecorded WHERE signed > 0)      AS unrecorded_credits,
      (SELECT COUNT(*) FROM unrecorded WHERE signed > 0)                      AS unrecorded_credits_count,
      (SELECT COALESCE(-SUM(signed), 0) FROM unrecorded WHERE signed < 0)     AS unrecorded_debits,
      (SELECT COUNT(*) FROM unrecorded WHERE signed < 0)                      AS unrecorded_debits_count,
      (SELECT COUNT(*) FROM gl_lines WHERE currency_fallback)                 AS gl_currency_fallback_lines,
      (SELECT COUNT(*) FROM txn t
        WHERE t.is_reconciled
          AND t.journal_entry_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM confirmed c
                           WHERE c.bank_transaction_id = t.id
                             AND COALESCE(c.matched_journal_entry_id,
                                          c.adjustment_journal_entry_id,
                                          c.fee_journal_entry_id) IS NOT NULL)) AS cleared_without_posting
  ),
  totals AS (
    SELECT
      agg.*,
      (v_opening + agg.statement_lines_net)                                           AS statement_balance,
      (v_opening + agg.statement_lines_net
         + agg.deposits_total - agg.unpresented_total)                                AS adjusted_bank,
      (agg.gl_balance + agg.unrecorded_credits - agg.unrecorded_debits)               AS adjusted_book
    FROM agg
  )
  SELECT jsonb_build_object(
    'account', jsonb_build_object(
      'id', a.id,
      'name', a.name,
      'bank_name', a.bank_name,
      'account_number', a.account_number,
      'currency', a.currency,
      'business_id', a.business_id,
      'branch_id', a.branch_id,
      'lifecycle_status', a.lifecycle_status,
      'gl_account_id', a.account_id,
      'gl_account_code', (SELECT ac.code FROM public.accounts ac WHERE ac.id = a.account_id),
      'gl_account_name', (SELECT ac.name FROM public.accounts ac WHERE ac.id = a.account_id)
    ),
    'as_of', _as_of,
    'currency', a.currency,
    'bank', jsonb_build_object(
      'opening_balance',      round(v_opening, 2),
      'opening_balance_date', a.opening_balance_date,
      'opening_balance_effective', v_from IS NOT NULL OR a.opening_balance_date IS NULL,
      'statement_lines_net',  round(t.statement_lines_net, 2),
      'statement_balance',    round(t.statement_balance, 2),
      'deposits_in_transit', jsonb_build_object(
        'label', 'Add: deposits in transit',
        'total', round(t.deposits_total, 2),
        'count', t.deposits_count,
        'items', COALESCE((
          SELECT jsonb_agg(x ORDER BY x->>'date')
            FROM (SELECT jsonb_build_object(
                    'id', o.id, 'journal_entry_id', o.je_id, 'date', o.entry_date,
                    'reference', o.entry_number, 'description', o.description,
                    'source', o.source_type, 'amount', round(o.signed, 2)) AS x
                    FROM outstanding o WHERE o.signed > 0
                   ORDER BY o.entry_date LIMIT v_items_cap) s
        ), '[]'::jsonb),
        'truncated', t.deposits_count > v_items_cap
      ),
      'unpresented_payments', jsonb_build_object(
        'label', 'Less: unpresented payments',
        'total', round(t.unpresented_total, 2),
        'count', t.unpresented_count,
        'items', COALESCE((
          SELECT jsonb_agg(x ORDER BY x->>'date')
            FROM (SELECT jsonb_build_object(
                    'id', o.id, 'journal_entry_id', o.je_id, 'date', o.entry_date,
                    'reference', o.entry_number, 'description', o.description,
                    'source', o.source_type, 'amount', round(-o.signed, 2)) AS x
                    FROM outstanding o WHERE o.signed < 0
                   ORDER BY o.entry_date LIMIT v_items_cap) s
        ), '[]'::jsonb),
        'truncated', t.unpresented_count > v_items_cap
      ),
      'adjusted_balance', round(t.adjusted_bank, 2)
    ),
    'book', jsonb_build_object(
      'gl_balance', CASE WHEN a.account_id IS NULL OR v_shared > 1 THEN NULL
                         ELSE round(t.gl_balance, 2) END,
      'unrecorded_receipts', jsonb_build_object(
        'label', 'Add: receipts on the statement not yet in the books',
        'total', round(t.unrecorded_credits, 2),
        'count', t.unrecorded_credits_count,
        'items', COALESCE((
          SELECT jsonb_agg(x ORDER BY x->>'date')
            FROM (SELECT jsonb_build_object(
                    'id', u.id, 'date', u.transaction_date, 'reference', u.reference,
                    'description', u.description, 'amount', round(u.signed, 2)) AS x
                    FROM unrecorded u WHERE u.signed > 0
                   ORDER BY u.transaction_date LIMIT v_items_cap) s
        ), '[]'::jsonb),
        'truncated', t.unrecorded_credits_count > v_items_cap
      ),
      'unrecorded_charges', jsonb_build_object(
        'label', 'Less: charges on the statement not yet in the books',
        'total', round(t.unrecorded_debits, 2),
        'count', t.unrecorded_debits_count,
        'items', COALESCE((
          SELECT jsonb_agg(x ORDER BY x->>'date')
            FROM (SELECT jsonb_build_object(
                    'id', u.id, 'date', u.transaction_date, 'reference', u.reference,
                    'description', u.description, 'amount', round(-u.signed, 2)) AS x
                    FROM unrecorded u WHERE u.signed < 0
                   ORDER BY u.transaction_date LIMIT v_items_cap) s
        ), '[]'::jsonb),
        'truncated', t.unrecorded_debits_count > v_items_cap
      ),
      'adjusted_balance', CASE WHEN a.account_id IS NULL OR v_shared > 1 THEN NULL
                               ELSE round(t.adjusted_book, 2) END
    ),
    'residual', CASE WHEN a.account_id IS NULL OR v_shared > 1 THEN NULL
                     ELSE round(t.adjusted_bank - t.adjusted_book, 2) END,
    'in_balance', CASE WHEN a.account_id IS NULL OR v_shared > 1 THEN false
                       ELSE ABS(round(t.adjusted_bank - t.adjusted_book, 2)) < 0.01 END,
    'diagnostics', jsonb_build_object(
      'gl_account_missing', a.account_id IS NULL,
      'gl_account_shared', v_shared > 1,
      'gl_currency_fallback_lines', t.gl_currency_fallback_lines,
      'statement_line_count', t.statement_line_count,
      'last_statement_date', t.last_statement_date,
      'cleared_without_posting', t.cleared_without_posting,
      'latest_session', (
        SELECT jsonb_build_object(
                 'id', s.id, 'statement_date', s.statement_date, 'status', s.status,
                 'closing_balance', s.closing_balance, 'difference', s.difference,
                 'completed_at', s.completed_at)
          FROM public.bank_reconciliation_sessions s
         WHERE s.bank_account_id = a.id
           AND s.organization_id = _org_id
           AND s.statement_date <= _as_of
         ORDER BY s.statement_date DESC, s.created_at DESC
         LIMIT 1)
    )
  )
    INTO v_result
    FROM totals t;

  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.finance_bank_reconciliation_statement(uuid, uuid, date, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finance_bank_reconciliation_statement(uuid, uuid, date, uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.finance_bank_reconciliation_statement(uuid, uuid, date, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finance_bank_reconciliation_statement(uuid, uuid, date, uuid, uuid) TO service_role;