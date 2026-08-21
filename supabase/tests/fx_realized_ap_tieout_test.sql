-- Realized FX end-to-end tie-out — AP mirror (ADR 0136 / ADR 0123) — Phase F.
--
-- The AR side is proved by fx_realized_tieout_test.sql. This is the payables
-- mirror, which must recognise the OPPOSITE sign:
--
--   USD 1,000 bill booked at R (provider rate on the bill date)
--   settled in two payments (400 + 600) on a date whose override rate is R + 5.5.
--
-- Expected ledger truth:
--   * AP control nets to zero — each allocation relieves the bill at its OWN
--     stamped booking rate (no parity fallback).
--   * Bank cash credited 1,000 x (R + 5.5) — cash leaves at the settlement rate.
--   * Realized FX LOSS of 1,000 x 5.5 = 5,500 — paying a stronger currency later
--     costs more base currency; the difference must not sink into AP or expense.
--
-- The fixture runs inside an exception block, so every row it writes is rolled
-- back. Nothing survives the run.
DO $outer$
DECLARE
  c_org  uuid := '8e682296-c634-44c8-ae00-bc48940ec28b';
  c_biz  uuid := 'bf392ca6-a743-435c-ae41-5bf25199470d';
  c_user uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  c_br   uuid;
  c_vend uuid;
  c_ap   uuid;
  c_bankacct uuid;
  c_bankgl uuid;
  c_gain uuid;
  c_loss uuid;
  d_book date := CURRENT_DATE - 9;
  d_pay  date := CURRENT_DATE;
  v_bill uuid := gen_random_uuid();
  v_book_rate numeric;
  v_rate numeric;
  v_bill_je uuid;
  v_p1 jsonb; v_p2 jsonb;
  v_ap_net numeric; v_bank_net numeric; v_fx_net numeric;
  v_orig int; v_report text;
BEGIN
  SELECT id INTO c_br FROM public.branches WHERE business_id = c_biz LIMIT 1;
  SELECT id INTO c_vend FROM public.contacts
   WHERE organization_id = c_org AND business_id = c_biz LIMIT 1;
  c_ap   := public._resolve_canonical_default_account('accounts_payable', c_org, c_biz, c_br);
  SELECT id, account_id INTO c_bankacct, c_bankgl
    FROM public.bank_accounts WHERE business_id = c_biz AND account_id IS NOT NULL LIMIT 1;
  c_gain := public.resolve_fx_realized_account(c_biz, 'gain');
  c_loss := public.resolve_fx_realized_account(c_biz, 'loss');

  IF c_br IS NULL OR c_vend IS NULL OR c_ap IS NULL OR c_bankgl IS NULL
     OR c_gain IS NULL OR c_loss IS NULL THEN
    RAISE NOTICE 'SKIP fx AP tie-out: fixture company is not configured in this environment';
    RETURN;
  END IF;

  v_book_rate := public.resolve_exchange_rate(c_org, c_biz, 'USD', d_book);
  IF v_book_rate IS NULL THEN
    RAISE NOTICE 'SKIP fx AP tie-out: no USD rate on file for %', d_book;
    RETURN;
  END IF;

  BEGIN
    -- confirm_bill_atomic is an authenticated entry point; act as a real member.
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', c_user::text, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', c_user::text, true);

    -- Settlement-date override rate, deliberately above the booking rate.
    INSERT INTO public.exchange_rates
      (organization_id, business_id, from_currency, to_currency, rate, effective_date, source)
    VALUES (c_org, c_biz, 'USD', 'KES', v_book_rate + 5.5, d_pay, 'override');

    INSERT INTO public.business_active_currencies
      (organization_id, business_id, currency_code, is_enabled)
    VALUES (c_org, c_biz, 'USD', true) ON CONFLICT DO NOTHING;

    INSERT INTO public.bills (id, organization_id, business_id, branch_id, vendor_id,
                              bill_number, status, bill_date, due_date, currency,
                              subtotal, tax_amount, total)
    VALUES (v_bill, c_org, c_biz, c_br, c_vend, 'FXAPTIE-' || substr(v_bill::text, 1, 8),
            'draft', d_book, d_book + 30, 'USD', 1000, 0, 1000);

    INSERT INTO public.bill_items (bill_id, description, quantity, unit_price, line_total)
    VALUES (v_bill, 'FX AP tie-out fixture', 1, 1000, 1000);

    -- 1) The document trigger stamps the booking rate from the rate book.
    SELECT currency_rate INTO v_rate FROM public.bills WHERE id = v_bill;
    IF v_rate IS DISTINCT FROM v_book_rate THEN
      RAISE EXCEPTION 'FX_AP_TIEOUT_FAIL booking rate stamped as % (expected %)', v_rate, v_book_rate;
    END IF;

    PERFORM public.confirm_bill_atomic(v_bill, c_user);
    SELECT journal_entry_id INTO v_bill_je FROM public.bills WHERE id = v_bill;
    IF v_bill_je IS NULL THEN RAISE EXCEPTION 'FX_AP_TIEOUT_FAIL bill was not posted'; END IF;

    -- 2) Every posted line carries its original denomination.
    SELECT count(*) INTO v_orig FROM public.journal_entry_lines
     WHERE journal_entry_id = v_bill_je AND original_currency = 'USD'
       AND (COALESCE(original_debit, 0) + COALESCE(original_credit, 0)) > 0;
    IF v_orig < 2 THEN
      RAISE EXCEPTION 'FX_AP_TIEOUT_FAIL only % bill JE lines carry USD denomination', v_orig;
    END IF;

    v_p1 := public.record_multi_bill_payment(
      _org_id := c_org, _business_id := c_biz, _vendor_id := c_vend,
      _allocations := jsonb_build_array(jsonb_build_object('bill_id', v_bill, 'amount', 400)),
      _total_amount := 400, _payment_date := d_pay, _payment_method := 'bank_transfer',
      _created_by := c_user, _bank_account_id := c_bankacct,
      _payable_account_id := c_ap, _branch_id := c_br);

    v_p2 := public.record_multi_bill_payment(
      _org_id := c_org, _business_id := c_biz, _vendor_id := c_vend,
      _allocations := jsonb_build_array(jsonb_build_object('bill_id', v_bill, 'amount', 600)),
      _total_amount := 600, _payment_date := d_pay, _payment_method := 'bank_transfer',
      _created_by := c_user, _bank_account_id := c_bankacct,
      _payable_account_id := c_ap, _branch_id := c_br);

    WITH je AS (
      SELECT unnest(ARRAY[v_bill_je,
                          (v_p1->>'journal_entry_id')::uuid,
                          (v_p2->>'journal_entry_id')::uuid]) AS id
    )
    SELECT
      COALESCE(SUM(CASE WHEN l.account_id = c_ap     THEN l.credit - l.debit END), 0),
      COALESCE(SUM(CASE WHEN l.account_id = c_bankgl THEN l.credit - l.debit END), 0),
      COALESCE(SUM(CASE WHEN l.account_id IN (c_gain, c_loss) THEN l.debit - l.credit END), 0)
      INTO v_ap_net, v_bank_net, v_fx_net
      FROM public.journal_entry_lines l JOIN je ON je.id = l.journal_entry_id;

    v_report := format('AP net %s (expect 0) | bank credit %s (expect %s) | realized FX loss %s (expect 5500)',
                       v_ap_net, v_bank_net, 1000 * (v_book_rate + 5.5), v_fx_net);

    -- 3) AP relieved at the booking rate: the control account closes exactly.
    IF abs(v_ap_net) > 0.01 THEN
      RAISE EXCEPTION 'FX_AP_TIEOUT_FAIL AP control not relieved to zero — %', v_report;
    END IF;
    -- 4) Cash paid out at the settlement rate.
    IF abs(v_bank_net - 1000 * (v_book_rate + 5.5)) > 0.01 THEN
      RAISE EXCEPTION 'FX_AP_TIEOUT_FAIL bank cash not at settlement rate — %', v_report;
    END IF;
    -- 5) The whole rate movement lands in realized FX loss, nowhere else.
    IF abs(v_fx_net - 5500) > 0.01 THEN
      RAISE EXCEPTION 'FX_AP_TIEOUT_FAIL realized FX loss misstated — %', v_report;
    END IF;

    -- Success: abort the fixture so nothing is left behind.
    RAISE EXCEPTION 'FX_AP_TIEOUT_OK %', v_report;
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'FX_AP_TIEOUT_OK%' THEN
      RAISE NOTICE 'PASS realized FX AP tie-out — %', SQLERRM;
    ELSE
      RAISE EXCEPTION '%', SQLERRM;
    END IF;
  END;
END $outer$;
