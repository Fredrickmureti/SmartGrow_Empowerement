-- Journal denomination contract (ADR 0123 / 0136) — Currency & Forex Phase 2a.
--
-- The posting engine is the ONE place where a document-currency amount becomes
-- a base-currency ledger amount. Catalog assertions only, so the file is safe
-- in any environment.

-- 1) Exactly one posting engine. A defaulted parameter added by
--    CREATE OR REPLACE silently creates a second overload and makes every
--    named-argument call ambiguous; that must never be left behind.
DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'post_journal_entry_atomic';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'post_journal_entry_atomic has % overloads; exactly one is allowed', v_n;
  END IF;
END $$;

-- 2) The engine stamps line denomination and converts through the one resolver.
DO $$
DECLARE v_src text; v_args text;
BEGIN
  SELECT p.prosrc, pg_get_function_arguments(p.oid) INTO v_src, v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'post_journal_entry_atomic';

  IF v_args !~ '_amounts_in_document_currency boolean DEFAULT false' THEN
    RAISE EXCEPTION 'the denomination opt-in must exist and default to false (unmigrated callers must not change behaviour)';
  END IF;
  IF v_src !~ 'original_currency' OR v_src !~ 'original_debit' OR v_src !~ 'original_credit' THEN
    RAISE EXCEPTION 'post_journal_entry_atomic does not stamp the original denomination on its lines';
  END IF;
  IF v_src !~ 'require_exchange_rate' THEN
    RAISE EXCEPTION 'post_journal_entry_atomic does not resolve the rate through require_exchange_rate';
  END IF;
  IF v_src !~ 'not balanced in base currency' THEN
    RAISE EXCEPTION 'post_journal_entry_atomic does not assert base-currency balance after conversion';
  END IF;
  IF v_src !~ 'residual' THEN
    RAISE EXCEPTION 'post_journal_entry_atomic has no rounding residual absorption';
  END IF;
  -- A rate literal would be a second FX engine (ADR 0136).
  IF v_src ~ '129\.5|1\.0e|:=\s*1\.[0-9]{2,}' THEN
    RAISE EXCEPTION 'post_journal_entry_atomic carries a hardcoded exchange rate';
  END IF;
END $$;

-- 3) The engine is not callable anonymously.
DO $$
DECLARE v_acl text;
BEGIN
  SELECT coalesce(array_to_string(p.proacl, ','), '') INTO v_acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'post_journal_entry_atomic';
  IF v_acl ~ 'anon=' OR v_acl ~ '(^|,)=X' THEN
    RAISE EXCEPTION 'post_journal_entry_atomic is executable by anon/PUBLIC';
  END IF;
END $$;

-- 4) The engine refuses an undeclared foreign posting (safe by construction).
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'post_journal_entry_atomic';

  IF v_src !~ 'must declare whether its amounts are in document currency' THEN
    RAISE EXCEPTION 'post_journal_entry_atomic no longer refuses an undeclared foreign-currency entry';
  END IF;
END $$;

-- 5) Migrated document families must declare their denomination.
--    Two legal shapes exist and the contract asserts BEHAVIOUR, not one literal
--    argument style:
--      (a) document-currency posters — hand raw document amounts to the engine
--          with the opt-in TRUE (named or positional) plus their currency;
--      (b) base-currency posters — convert in the caller and declare FALSE.
--    Neither may post a foreign amount without declaring which it is.
DO $$
DECLARE r record; v_src text;
BEGIN
  -- (a) document-currency posters, named opt-in.
  FOR r IN
    SELECT * FROM (VALUES
      ('_confirm_invoice_core',          'v_inv\.currency'),
      ('issue_credit_note_atomic',       'v_cn\.currency'),
      ('issue_vendor_credit_note_atomic','v_vcn\.currency'),
      ('post_missing_invoice_journals',  'v_inv\.currency'),
      ('repair_misposted_ar_invoices',   'r\.currency')
    ) AS t(fname, ccy)
  LOOP
    SELECT p.prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.fname;
    IF v_src IS NULL THEN RAISE EXCEPTION '% is missing', r.fname; END IF;
    IF v_src !~ '_amounts_in_document_currency\s*:=\s*true' THEN
      RAISE EXCEPTION '% no longer declares its line amounts as document currency', r.fname;
    END IF;
    IF v_src !~ r.ccy THEN
      RAISE EXCEPTION '% no longer passes its document currency', r.fname;
    END IF;
  END LOOP;

  -- (a') confirm_bill_atomic opts in POSITIONALLY: it must still hand the engine
  --      the bill's own currency and stamped rate, and must NOT claim its lines
  --      are already base currency.
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'confirm_bill_atomic';
  IF v_src IS NULL THEN RAISE EXCEPTION 'confirm_bill_atomic is missing'; END IF;
  IF v_src !~ 'v_bill\.currency' OR v_src !~ 'v_bill\.currency_rate' THEN
    RAISE EXCEPTION 'confirm_bill_atomic no longer passes the bill currency and its stamped rate';
  END IF;
  IF v_src ~ '_amounts_in_document_currency\s*:=\s*false' THEN
    RAISE EXCEPTION 'confirm_bill_atomic posts document-currency lines but declares them as base currency';
  END IF;

  -- (b) base-currency posters: they convert in the caller, so they must declare
  --     FALSE explicitly (never leave the denomination undeclared) and must not
  --     also claim the document-currency opt-in.
  FOR r IN
    SELECT * FROM (VALUES
      ('refund_customer_atomic',        'v_currency'),
      ('refund_from_vendor_atomic',     'v_vcn\.currency'),
      ('apply_credit_to_invoice_atomic','v_cn\.currency')
    ) AS t(fname, ccy)
  LOOP
    SELECT p.prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.fname;
    IF v_src IS NULL THEN RAISE EXCEPTION '% is missing', r.fname; END IF;
    IF v_src !~ '_amounts_in_document_currency\s*:=\s*false' THEN
      RAISE EXCEPTION '% no longer declares its lines as already base currency', r.fname;
    END IF;
    IF v_src ~ '_amounts_in_document_currency\s*:=\s*true' THEN
      RAISE EXCEPTION '% declares both denominations; exactly one is legal', r.fname;
    END IF;
    IF v_src !~ r.ccy THEN
      RAISE EXCEPTION '% no longer reads its document currency', r.fname;
    END IF;
  END LOOP;
END $$;

-- 6) Cost-of-goods lines are already base currency: the delivery poster must
--    not label them with the customer's document currency.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'complete_delivery_atomic';

  IF v_src !~ '_lines := v_cogs_lines, _currency := NULL' THEN
    RAISE EXCEPTION 'complete_delivery_atomic posts base-currency COGS under a document currency';
  END IF;
END $$;

