DO $mig$
DECLARE
  d text;
  n text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'bank_match_confirm';
  IF d IS NULL THEN RAISE EXCEPTION 'bank_match_confirm not found'; END IF;

  n := replace(d,
    '  _txn_currency := COALESCE(_txn.original_currency, _base);',
    '  _txn_currency := COALESCE(_txn.original_currency,' || E'\n' ||
    '                            (SELECT ba.currency FROM public.bank_accounts ba WHERE ba.id = _txn.bank_account_id),' || E'\n' ||
    '                            _base);');
  IF n = d THEN RAISE EXCEPTION 'patch 1 (currency fallback) did not apply'; END IF;
  d := n;

  n := replace(d,
    '      _exchange_rate := _rate,' || E'\n' || '      _request_id := _req',
    '      _request_id := _req');
  IF n = d THEN RAISE EXCEPTION 'patch 2 (invoice rate arg) did not apply'; END IF;
  d := n;

  n := replace(d,
    '      _request_id := _req,' || E'\n' || '      _exchange_rate := _rate',
    '      _request_id := _req');
  IF n = d THEN RAISE EXCEPTION 'patch 3 (bill rate arg) did not apply'; END IF;
  d := n;

  EXECUTE d;
END $mig$;