-- ADR-0123 / ADR-0149 guard: voiding a posted entry must not trip the
-- journal-entry immutability trigger.
--
-- The reversal entry is inserted already `posted`, so the line-level totals
-- recompute trigger (`_recompute_je_totals`) must be suppressed while its
-- lines are written — otherwise it UPDATEs a posted row and the immutability
-- trigger raises "Cannot modify a posted journal entry", which is how every
-- void (bank un-match, payment reversal, journal void) used to fail.
\set ON_ERROR_STOP on

-- 1) The void engine suppresses the recompute trigger.
DO $$
DECLARE src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'void_journal_entry_atomic';

  IF src IS NULL THEN
    RAISE EXCEPTION 'void_journal_entry_atomic is missing';
  END IF;

  IF src !~ 'suppress_je_recompute' THEN
    RAISE EXCEPTION
      'void_journal_entry_atomic must suppress app.suppress_je_recompute while writing reversal lines';
  END IF;

  -- 2) …and therefore must stamp the reversal totals itself.
  IF src !~ 'total_debit' OR src !~ 'total_credit' THEN
    RAISE EXCEPTION
      'void_journal_entry_atomic must stamp total_debit/total_credit on the reversal header';
  END IF;
END $$;

-- 3) The recompute trigger still exists and still honours the suppression flag,
--    so the guard above is meaningful.
DO $$
DECLARE src text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal
      AND c.relname = 'journal_entry_lines'
      AND t.tgname = 'trg_jel_recompute_je_totals'
  ) THEN
    RAISE EXCEPTION 'trg_jel_recompute_je_totals is missing';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = '_recompute_je_totals';

  IF src !~ 'suppress_je_recompute' THEN
    RAISE EXCEPTION '_recompute_je_totals no longer honours app.suppress_je_recompute';
  END IF;
END $$;
