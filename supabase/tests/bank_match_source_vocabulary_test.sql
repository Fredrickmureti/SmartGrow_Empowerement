-- ADR-0144: `match_source` records *how* a bank line was matched
-- (manual | rule | ai). It is not a lifecycle field — "unreconciled" is
-- expressed by is_reconciled = false / lifecycle_status = 'for_review', and a
-- line with no match has no match source at all (NULL).
--
-- Writing any other token silently violated
-- bank_transactions_match_source_check and made un-matching impossible; this
-- test keeps the vocabulary and its writers in agreement.
\set ON_ERROR_STOP on

-- 1) The constraint still defines the vocabulary this test guards.
DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conrelid = 'public.bank_transactions'::regclass
    AND conname = 'bank_transactions_match_source_check';

  IF def IS NULL THEN
    RAISE EXCEPTION 'bank_transactions_match_source_check is missing';
  END IF;
  IF def !~ 'manual' OR def !~ 'rule' OR def !~ 'ai' THEN
    RAISE EXCEPTION 'match_source vocabulary changed unexpectedly: %', def;
  END IF;
END $$;

-- 2) No database function assigns a match_source outside that vocabulary.
DO $$
DECLARE bad text[];
BEGIN
  SELECT array_agg(DISTINCT p.proname) INTO bad
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace,
  LATERAL regexp_matches(
    pg_get_functiondef(p.oid),
    'match_source\s*(?::=|=)\s*''([a-z_]+)''',
    'g'
  ) AS m(tok)
  WHERE n.nspname = 'public'
    AND m.tok[1] NOT IN ('manual', 'rule', 'ai');

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'function(s) write an invalid match_source: %', bad;
  END IF;
END $$;

-- 3) Un-matching clears the match source rather than inventing a token.
DO $$
DECLARE src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'unreconcile_bank_transaction';

  IF src !~ 'match_source\s*=\s*NULL' THEN
    RAISE EXCEPTION 'unreconcile_bank_transaction must clear match_source to NULL';
  END IF;
END $$;
