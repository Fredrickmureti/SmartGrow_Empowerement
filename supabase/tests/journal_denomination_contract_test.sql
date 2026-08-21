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
DO $$
DECLARE r record; v_src text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('_confirm_invoice_core',           'v_inv\.currency'),
      ('confirm_bill_atomic',             'v_bill\.currency'),
      ('issue_credit_note_atomic',        'v_cn\.currency'),
      ('issue_vendor_credit_note_atomic', 'v_vcn\.currency'),
      ('refund_customer_atomic',          'v_currency'),
      ('refund_from_vendor_atomic',       'v_vcn\.currency'),
      ('apply_credit_to_invoice_atomic',  'v_cn\.currency'),
      ('post_missing_invoice_journals',   'v_inv\.currency'),
      ('repair_misposted_ar_invoices',    'r\.currency')
    ) AS t(fname, ccy)
  LOOP
    SELECT p.prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.fname;

    IF v_src IS NULL THEN
      RAISE EXCEPTION '% is missing', r.fname;
    END IF;
    IF v_src !~ '_amounts_in_document_currency\s*:=\s*true' THEN
      RAISE EXCEPTION '% no longer declares its line amounts as document currency', r.fname;
    END IF;
    IF v_src !~ r.ccy THEN
      RAISE EXCEPTION '% no longer passes its document currency', r.fname;
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

