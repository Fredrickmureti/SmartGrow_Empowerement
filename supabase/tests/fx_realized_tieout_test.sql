-- Realized FX end-to-end tie-out (ADR 0136 / ADR 0123) — Phase E.
--
-- Catalog assertions prove shape, not arithmetic. This test builds a REAL
-- foreign-currency accounting event and ties the ledger out:
--
--   USD 1,000 invoice booked at 129.5 (provider rate on the issue date)
--   settled in two receipts (400 + 600) on a date whose override rate is 135.
--
-- Expected ledger truth:
--   * AR control nets to zero  — each allocation relieves the invoice at its
--     OWN stamped booking rate (no parity fallback).
--   * Bank cash = 1,000 x 135 = 135,000 — cash lands at the settlement rate.
--   * Realized FX gain = 1,000 x (135 - 129.5) = 5,500 — the difference is
--     recognised, not absorbed into AR or revenue.
--
-- The whole fixture runs inside an exception block, so every row it writes is
-- rolled back to the enclosing savepoint. Nothing survives the run.
--
-- Set the four fixture identifiers below for the environment under test.
DO $outer$
DECLARE
  c_org  uuid := '8e682296-c634-44c8-ae00-bc48940ec28b';
  c_biz  uuid := 'bf392ca6-a743-435c-ae41-5bf25199470d';
  c_br   uuid;
  c_cust uuid;
  c_ar   uuid;
  c_bank uuid;
  c_gain uuid;
  c_loss uuid;
  d_book date := CURRENT_DATE - 9;
  d_pay  date := CURRENT_DATE;
  v_inv uuid := gen_random_uuid();
  v_book_rate numeric;
  v_rate numeric; v_inv_je uuid;
  v_p1 jsonb; v_p2 jsonb;
  v_ar_net numeric; v_bank_net numeric; v_fx_net numeric;
  v_orig int; v_report text;
BEGIN
  SELECT id INTO c_br FROM public.branches WHERE business_id = c_biz LIMIT 1;
  SELECT id INTO c_cust FROM public.contacts
   WHERE organization_id = c_org AND (business_id = c_biz OR business_id IS NULL) LIMIT 1;
  c_ar   := public._resolve_canonical_default_account('accounts_receivable', c_org, c_biz, c_br);
  c_bank := public._resolve_canonical_default_account('bank', c_org, c_biz, c_br);
  c_gain := public.resolve_fx_realized_account(c_biz, 'gain');
  c_loss := public.resolve_fx_realized_account(c_biz, 'loss');

  IF c_br IS NULL OR c_cust IS NULL OR c_ar IS NULL OR c_bank IS NULL
     OR c_gain IS NULL OR c_loss IS NULL THEN
    RAISE NOTICE 'SKIP fx tie-out: fixture company is not configured in this environment';
    RETURN;
  END IF;

  v_book_rate := public.resolve_exchange_rate(c_org, c_biz, 'USD', d_book);
  IF v_book_rate IS NULL THEN
    RAISE NOTICE 'SKIP fx tie-out: no USD rate on file for %', d_book;
    RETURN;
  END IF;

  BEGIN
    -- Settlement-date override rate, deliberately different from the booking rate.
    INSERT INTO public.exchange_rates
      (organization_id, business_id, from_currency, to_currency, rate, effective_date, source)
    VALUES (c_org, c_biz, 'USD', 'KES', v_book_rate + 5.5, d_pay, 'override');

    INSERT INTO public.business_active_currencies
      (organization_id, business_id, currency_code, is_enabled)
    VALUES (c_org, c_biz, 'USD', true) ON CONFLICT DO NOTHING;

    INSERT INTO public.invoices (id, organization_id, business_id, branch_id, contact_id,
                                 invoice_number, status, issue_date, due_date, currency,
                                 subtotal, tax_amount, total)
    VALUES (v_inv, c_org, c_biz, c_br, c_cust, 'FXTIEOUT-' || substr(v_inv::text, 1, 8),
            'draft', d_book, d_book + 30, 'USD', 1000, 0, 1000);

    INSERT INTO public.invoice_items (invoice_id, description, quantity, unit_price, line_total)
    VALUES (v_inv, 'FX tie-out fixture', 1, 1000, 1000);

    -- 1) The document trigger stamps the booking rate from the rate book.
    SELECT exchange_rate INTO v_rate FROM public.invoices WHERE id = v_inv;
    IF v_rate IS DISTINCT FROM v_book_rate THEN
      RAISE EXCEPTION 'FX_TIEOUT_FAIL booking rate stamped as % (expected %)', v_rate, v_book_rate;
    END IF;

    PERFORM public._confirm_invoice_core(v_inv, NULL, NULL, 'confirmed');
    SELECT journal_entry_id INTO v_inv_je FROM public.invoices WHERE id = v_inv;
    IF v_inv_je IS NULL THEN RAISE EXCEPTION 'FX_TIEOUT_FAIL invoice was not posted'; END IF;

    -- 2) Every posted line carries its original denomination.
    SELECT count(*) INTO v_orig FROM public.journal_entry_lines
     WHERE journal_entry_id = v_inv_je AND original_currency = 'USD'
       AND (COALESCE(original_debit, 0) + COALESCE(original_credit, 0)) > 0;
    IF v_orig < 2 THEN
      RAISE EXCEPTION 'FX_TIEOUT_FAIL only % invoice JE lines carry USD denomination', v_orig;
    END IF;

    v_p1 := public.record_multi_invoice_payment(
      _org_id := c_org, _business_id := c_biz, _contact_id := c_cust,
      _allocations := jsonb_build_array(jsonb_build_object('invoice_id', v_inv, 'amount', 400)),
      _total_amount := 400, _payment_date := d_pay, _payment_method := 'bank_transfer',
      _deposit_account_id := c_bank, _receivable_account_id := c_ar, _branch_id := c_br);

    v_p2 := public.record_multi_invoice_payment(
      _org_id := c_org, _business_id := c_biz, _contact_id := c_cust,
      _allocations := jsonb_build_array(jsonb_build_object('invoice_id', v_inv, 'amount', 600)),
      _total_amount := 600, _payment_date := d_pay, _payment_method := 'bank_transfer',
      _deposit_account_id := c_bank, _receivable_account_id := c_ar, _branch_id := c_br);

    WITH je AS (
      SELECT unnest(ARRAY[v_inv_je,
                          (v_p1->>'journal_entry_id')::uuid,
                          (v_p2->>'journal_entry_id')::uuid]) AS id
    )
    SELECT
      COALESCE(SUM(CASE WHEN l.account_id = c_ar   THEN l.debit - l.credit END), 0),
      COALESCE(SUM(CASE WHEN l.account_id = c_bank THEN l.debit - l.credit END), 0),
      COALESCE(SUM(CASE WHEN l.account_id IN (c_gain, c_loss) THEN l.credit - l.debit END), 0)
      INTO v_ar_net, v_bank_net, v_fx_net
      FROM public.journal_entry_lines l JOIN je ON je.id = l.journal_entry_id;

    v_report := format('AR net %s (expect 0) | bank net %s (expect %s) | realized FX %s (expect %s)',
                       v_ar_net, v_bank_net, 1000 * (v_book_rate + 5.5), v_fx_net, 5500);

    -- 3) AR relieved at the booking rate: the control account closes exactly.
    IF abs(v_ar_net) > 0.01 THEN
      RAISE EXCEPTION 'FX_TIEOUT_FAIL AR control not relieved to zero — %', v_report;
    END IF;
    -- 4) Cash recognised at the settlement rate.
    IF abs(v_bank_net - 1000 * (v_book_rate + 5.5)) > 0.01 THEN
      RAISE EXCEPTION 'FX_TIEOUT_FAIL bank cash not at settlement rate — %', v_report;
    END IF;
    -- 5) The whole rate movement lands in realized FX, nowhere else.
    IF abs(v_fx_net - 5500) > 0.01 THEN
      RAISE EXCEPTION 'FX_TIEOUT_FAIL realized FX gain misstated — %', v_report;
    END IF;

    -- Success: abort the fixture so nothing is left behind.
    RAISE EXCEPTION 'FX_TIEOUT_OK %', v_report;
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'FX_TIEOUT_OK%' THEN
      RAISE NOTICE 'PASS realized FX tie-out — %', SQLERRM;
    ELSE
      RAISE EXCEPTION '%', SQLERRM;
    END IF;
  END;
END $outer$;
