-- Settlement FX contract (ADR 0123 / 0136).
--
-- Catalog assertions only, so this file is safe in any environment.
--
-- Invariants:
--   1. No settlement path resolves its own rate off the rate book or falls back
--      to parity — there is one resolver (resolve/require_exchange_rate) and one
--      stamper (fx_stamp_document).
--   2. Settlement rates are server-resolved; a caller-supplied rate is refused.
--   3. Every path that relieves a monetary balance booked at a historical rate
--      recognises the realised FX difference.

-- 1) PO -> bill conversion carries no second FX engine.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'convert_po_to_bill_atomic';
  IF v_src IS NULL THEN RAISE EXCEPTION 'convert_po_to_bill_atomic is missing'; END IF;

  IF v_src ~* 'from\s+public\.exchange_rates' THEN
    RAISE EXCEPTION 'convert_po_to_bill_atomic reads the rate book directly (ADR 0136)';
  END IF;
  IF v_src ~* 'COALESCE\(\s*v_rate\s*,\s*1\s*\)' THEN
    RAISE EXCEPTION 'convert_po_to_bill_atomic falls back to a 1:1 rate';
  END IF;
END $$;

-- 2) Settlement RPCs refuse a caller-supplied rate and resolve server-side.
DO $$
DECLARE r record; v_src text;
BEGIN
  FOR r IN SELECT unnest(ARRAY['record_multi_invoice_payment','record_multi_bill_payment']) AS fname
  LOOP
    SELECT p.prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.fname;
    IF v_src IS NULL THEN RAISE EXCEPTION '% is missing', r.fname; END IF;

    IF v_src ~* 'COALESCE\(_exchange_rate' THEN
      RAISE EXCEPTION '% still honours a caller-supplied settlement rate', r.fname;
    END IF;
    IF v_src !~* 'resolved server-side' THEN
      RAISE EXCEPTION '% no longer refuses a caller-supplied _exchange_rate', r.fname;
    END IF;
    IF v_src !~* 'resolve_exchange_rate' THEN
      RAISE EXCEPTION '% does not resolve the settlement rate through the one resolver', r.fname;
    END IF;
    IF v_src !~* 'resolve_fx_realized_account' THEN
      RAISE EXCEPTION '% does not recognise realised FX on settlement', r.fname;
    END IF;
  END LOOP;
END $$;

-- 3) Credit applications and refunds recognise realised FX and post base-currency
--    lines (each leg carries its own historical rate, so the engine must not
--    convert them a second time).
DO $$
DECLARE r record; v_src text;
BEGIN
  FOR r IN SELECT unnest(ARRAY[
      'apply_credit_to_invoice_atomic',
      'refund_customer_atomic',
      'refund_from_vendor_atomic']) AS fname
  LOOP
    SELECT p.prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.fname;
    IF v_src IS NULL THEN RAISE EXCEPTION '% is missing', r.fname; END IF;

    IF v_src !~* 'resolve_fx_realized_account' THEN
      RAISE EXCEPTION '% settles a monetary balance without recognising realised FX', r.fname;
    END IF;
    IF v_src !~* '_amounts_in_document_currency := false' THEN
      RAISE EXCEPTION '% re-converts already-base lines through a single rate', r.fname;
    END IF;
    -- No currency literal may stand in for the company base currency.
    IF v_src ~ '''KES''' THEN
      RAISE EXCEPTION '% carries a hardcoded currency code', r.fname;
    END IF;
  END LOOP;
END $$;

-- Phase 5 (ADR 0136) — the last producers: employee reimbursement and POS sessions.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'expense_reimburse_direct';
  IF v_src IS NULL THEN RAISE EXCEPTION 'expense_reimburse_direct is missing'; END IF;

  IF v_src ~* 'coalesce\s*\(\s*[a-z_.]*(exchange_)?rate\s*,\s*1\s*\)' THEN
    RAISE EXCEPTION 'expense_reimburse_direct falls back to a 1:1 exchange rate';
  END IF;
  IF v_src !~* 'resolve_exchange_rate' THEN
    RAISE EXCEPTION 'expense_reimburse_direct does not resolve the payment-date rate server-side';
  END IF;
  IF v_src !~* 'resolve_fx_realized_account' THEN
    RAISE EXCEPTION 'expense_reimburse_direct settles a foreign payable without recognising realised FX';
  END IF;
  IF v_src !~* 'base_currency' THEN
    RAISE EXCEPTION 'expense_reimburse_direct does not derive the company base currency';
  END IF;

  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'pos_payment_session_open';
  IF v_src IS NULL THEN RAISE EXCEPTION 'pos_payment_session_open is missing'; END IF;

  IF v_src ~ '''KES''' THEN
    RAISE EXCEPTION 'pos_payment_session_open carries a hardcoded currency code';
  END IF;
  IF v_src ~* 'coalesce\s*\(\s*p_fx_rate\s*,\s*1\s*\)' THEN
    RAISE EXCEPTION 'pos_payment_session_open opens a session at a silent 1:1 rate';
  END IF;
  IF v_src !~* 'p_fx_rate is not accepted' THEN
    RAISE EXCEPTION 'pos_payment_session_open still accepts a client-supplied FX rate';
  END IF;
  IF v_src !~* 'resolve_exchange_rate' THEN
    RAISE EXCEPTION 'pos_payment_session_open does not resolve its rate server-side';
  END IF;
END $$;
