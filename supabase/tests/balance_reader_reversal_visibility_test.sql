-- Guard: every balance reader must see the SAME journal statuses the ledger
-- sees.
--
-- A reversal keeps the original entry's lines and adds an offsetting entry;
-- the original is only re-labelled 'reversed'. A reader that filters
-- `je.status = 'posted'` therefore drops the original leg but keeps the
-- reversal leg, and the account balance shifts by the reversed amount. That is
-- exactly how the Chart of Accounts came to show the bank 37,000 higher than
-- the bank report.
--
-- `ledger_visible_journal_statuses()` ('posted','reversed') is the single
-- definition. Writers (status transition handlers) are exempt: they reason
-- about a specific transition, not about visibility.
DO $$
DECLARE
  offender text;
  writers text[] := ARRAY[
    'post_journal_entry_status',
    'sync_balances_on_je_status_change',
    'unapply_payment_atomic',
    'void_journal_entry_atomic',
    -- references a table that does not exist in this project; untouched.
    'consolidation_intercompany_scoped_entries'
  ];
BEGIN
  SELECT string_agg(p.proname, ', ')
    INTO offender
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosrc ~ 'journal_entry_lines'
    AND p.prosrc ~ 'status\s*=\s*''posted'''
    AND NOT (p.proname = ANY (writers));

  IF offender IS NOT NULL THEN
    RAISE EXCEPTION
      'balance reader(s) filter posted-only and will drift on reversals: %',
      offender;
  END IF;
END $$;

-- Behavioural: for every account, the posted+reversed net equals the sum of
-- each entry pair, i.e. a reversed entry and its reversal cancel exactly.
DO $$
DECLARE
  bad record;
BEGIN
  FOR bad IN
    SELECT orig.entry_number,
           sum(COALESCE(ol.debit,0) - COALESCE(ol.credit,0)
             + COALESCE(rl.debit,0) - COALESCE(rl.credit,0)) AS residual
    FROM journal_entries orig
    JOIN journal_entries rev ON rev.reversal_of_id = orig.id
    JOIN journal_entry_lines ol ON ol.journal_entry_id = orig.id
    JOIN journal_entry_lines rl ON rl.journal_entry_id = rev.id
     AND rl.account_id = ol.account_id
    WHERE orig.status = 'reversed' AND rev.status = 'posted'
    GROUP BY orig.entry_number
    HAVING sum(COALESCE(ol.debit,0) - COALESCE(ol.credit,0)
             + COALESCE(rl.debit,0) - COALESCE(rl.credit,0)) <> 0
  LOOP
    RAISE EXCEPTION 'reversal of % does not cancel (residual %)',
      bad.entry_number, bad.residual;
  END LOOP;
END $$;
