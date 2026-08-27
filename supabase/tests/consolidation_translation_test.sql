-- Consolidation Brick 3 — FX translation invariants (IAS 21 current-rate method).
--
-- Proves, on data this script creates and then rolls back:
--   1. Equity movements translate at the rate of the day they were recorded,
--      NOT at the group member's single historical rate.
--   2. Translated equity is never re-translated: closing = opening + movements.
--   3. Assets and liabilities translate at the closing rate.
--   4. Income and expense translate at the period average rate.
--   5. The CTA residual reproduces the independent three-part proof
--      (opening net assets, period result, dated equity movements).
--   6. Incomplete rate coverage over the period is refused, not approximated.
--
-- Run with supabase--run_sql; the final RAISE rolls everything back.
DO $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_p uuid := gen_random_uuid();   -- parent, KES (presentation currency)
  v_s uuid := gen_random_uuid();   -- subsidiary, USD (requires translation)
  v_group uuid := gen_random_uuid();
  v_cta uuid; v_cash_p uuid;
  v_cash_s uuid; v_stock_s uuid; v_rev_s uuid;
  v_je uuid;
  v_hist date := DATE '2026-02-10';
  v_rate_hist numeric; v_rate_mar15 numeric; v_rate_close numeric; v_rate_open numeric; v_rate_avg numeric;
  v_row record; v_rec record;
  v_blocked boolean;
BEGIN
  ------------------------------------------------------------------ fixture ---
  INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  VALUES (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'consol-fx-' || replace(v_user::text, '-', '') || '@example.test', now(), now());
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Consolidation FX Org', 'consol-fx-' || replace(v_org::text, '-', ''));
  INSERT INTO public.user_roles (user_id, organization_id, role, is_active)
  VALUES (v_user, v_org, 'owner', true);

  INSERT INTO public.businesses (id, organization_id, name, country, base_currency, fiscal_year_start)
  VALUES (v_p, v_org, 'FX Parent Ltd', 'KE', 'KES', 1),
         (v_s, v_org, 'FX Sub Inc',    'US', 'USD', 1);

  -- Daily USD->KES coverage for the fiscal year to date: the average and the
  -- opening rate both refuse to approximate over an uncovered day.
  INSERT INTO public.exchange_rates
    (organization_id, business_id, from_currency, to_currency, rate, effective_date, source, published_at)
  SELECT v_org, v_p, 'USD', 'KES',
         100 + (d::date - DATE '2026-01-01') * 0.10,
         d::date, 'manual', now()
    FROM generate_series(DATE '2026-01-01', DATE '2026-03-31', INTERVAL '1 day') d;

  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'asset', 'cash_on_hand', '1000', 'Cash P') RETURNING id INTO v_cash_p;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'equity', 'accumulated_other_comprehensive_income', '3900',
          'Foreign currency translation reserve') RETURNING id INTO v_cta;

  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_s, 'asset',  'cash_on_hand',  '1000', 'Cash S')    RETURNING id INTO v_cash_s;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_s, 'equity', 'common_stock',  '3000', 'Share capital S') RETURNING id INTO v_stock_s;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_s, 'income', 'sales_income',  '4000', 'Revenue S') RETURNING id INTO v_rev_s;

  -- Prior-period share issue: becomes the opening equity balance (historical rate).
  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_s, 'FX-S-1', v_hist, 'Share issue', 'draft', 'USD', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id, debit, credit)
  VALUES (v_org, v_s, v_je, v_cash_s, 1000, 0), (v_org, v_s, v_je, v_stock_s, 0, 1000);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je;

  -- In-period share issue: MUST translate at the 15 March rate.
  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_s, 'FX-S-2', DATE '2026-03-15', 'Further share issue', 'draft', 'USD', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id, debit, credit)
  VALUES (v_org, v_s, v_je, v_cash_s, 500, 0), (v_org, v_s, v_je, v_stock_s, 0, 500);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je;

  -- In-period trading: translates at the period average.
  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_s, 'FX-S-3', DATE '2026-03-20', 'Sale', 'draft', 'USD', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id, debit, credit)
  VALUES (v_org, v_s, v_je, v_cash_s, 200, 0), (v_org, v_s, v_je, v_rev_s, 0, 200);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je;

  INSERT INTO public.consolidation_groups
    (id, organization_id, name, parent_business_id, presentation_currency, cta_account_id)
  VALUES (v_group, v_org, 'FX Group', v_p, 'KES', v_cta);
  INSERT INTO public.consolidation_group_members
    (organization_id, group_id, business_id, ownership_percent, method, effective_from)
  VALUES (v_org, v_group, v_p, 100, 'full', DATE '2026-01-01');
  INSERT INTO public.consolidation_group_members
    (organization_id, group_id, business_id, parent_business_id, ownership_percent, method, effective_from, historical_rate_date)
  VALUES (v_org, v_group, v_s, v_p, 100, 'full', DATE '2026-01-01', v_hist);

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);

  SELECT r.historical_rate, r.closing_rate, r.opening_rate, r.average_rate
    INTO v_rate_hist, v_rate_close, v_rate_open, v_rate_avg
    FROM public.consolidation_member_translation_rates(v_group, v_s, DATE '2026-03-01', DATE '2026-03-31') r;
  v_rate_mar15 := public.fx_rate_on(v_org, v_p, 'USD', 'KES', DATE '2026-03-15');
  IF v_rate_mar15 = v_rate_hist THEN
    RAISE EXCEPTION 'fixture is not discriminating: the March rate equals the historical rate';
  END IF;

  ------------------------------------------------- 1 & 2: equity at txn rate --
  SELECT * INTO v_row
    FROM public.consolidation_translate_member(v_group, v_s, DATE '2026-03-01', DATE '2026-03-31') t
   WHERE t.account_id = v_stock_s;

  IF v_row.rate_class <> 'transaction' THEN
    RAISE EXCEPTION 'share capital was classed % instead of a transaction-date rate', v_row.rate_class;
  END IF;
  IF round(v_row.translated_credit, 2) <> round(500 * v_rate_mar15, 2) THEN
    RAISE EXCEPTION 'the March share issue translated to % but the 15 March rate gives %',
      v_row.translated_credit, round(500 * v_rate_mar15, 2);
  END IF;
  IF round(v_row.translated_credit, 2) = round(500 * v_rate_hist, 2) THEN
    RAISE EXCEPTION 'the March share issue was translated at the historical rate';
  END IF;
  IF round(v_row.translated_opening, 2) <> round(1000 * v_rate_hist, 2) THEN
    RAISE EXCEPTION 'opening share capital translated to % but the historical rate gives %',
      v_row.translated_opening, round(1000 * v_rate_hist, 2);
  END IF;
  IF round(v_row.translated_closing, 2) <> round(v_row.translated_opening + v_row.translated_credit, 2) THEN
    RAISE EXCEPTION 'translated equity was re-translated: closing % is not opening % plus movements %',
      v_row.translated_closing, v_row.translated_opening, v_row.translated_credit;
  END IF;
  IF round(v_row.translated_closing, 2) = round(1500 * v_rate_close, 2) THEN
    RAISE EXCEPTION 'equity was re-translated at the closing rate, destroying historical cost';
  END IF;

  --------------------------------------------------- 3: cash at closing rate --
  SELECT * INTO v_row
    FROM public.consolidation_translate_member(v_group, v_s, DATE '2026-03-01', DATE '2026-03-31') t
   WHERE t.account_id = v_cash_s;
  IF v_row.rate_class <> 'closing' THEN
    RAISE EXCEPTION 'cash was classed % instead of the closing rate', v_row.rate_class;
  END IF;
  IF round(v_row.translated_closing, 2) <> round(v_row.closing_balance * v_rate_close, 2) THEN
    RAISE EXCEPTION 'cash closing translated to % but the closing rate gives %',
      v_row.translated_closing, round(v_row.closing_balance * v_rate_close, 2);
  END IF;

  -------------------------------------------------- 4: revenue at average ----
  SELECT * INTO v_row
    FROM public.consolidation_translate_member(v_group, v_s, DATE '2026-03-01', DATE '2026-03-31') t
   WHERE t.account_id = v_rev_s;
  IF v_row.rate_class <> 'average' THEN
    RAISE EXCEPTION 'revenue was classed % instead of the average rate', v_row.rate_class;
  END IF;
  IF round(v_row.translated_credit, 2) <> round(200 * v_rate_avg, 2) THEN
    RAISE EXCEPTION 'revenue translated to % but the average rate gives %',
      v_row.translated_credit, round(200 * v_rate_avg, 2);
  END IF;

  ------------------------------------------------ 5: CTA independent proof ---
  SELECT * INTO v_rec
    FROM public.consolidation_cta_reconciliation(v_group, DATE '2026-03-01', DATE '2026-03-31') c
   WHERE c.business_id = v_s;
  IF v_rec IS NULL THEN
    RAISE EXCEPTION 'the translation reserve report returned no row for the foreign subsidiary';
  END IF;
  IF NOT v_rec.is_reconciled THEN
    RAISE EXCEPTION 'CTA does not reconcile: residual movement % vs proof % (from net assets %, result %, equity %), difference %',
      v_rec.cta_movement, v_rec.expected_cta_movement,
      v_rec.expected_from_opening_net_assets, v_rec.expected_from_result,
      v_rec.expected_from_equity_movements, v_rec.movement_difference;
  END IF;
  IF v_rec.equity_movement <> 500 THEN
    RAISE EXCEPTION 'the proof saw % of equity movement, the subsidiary issued 500', v_rec.equity_movement;
  END IF;
  IF v_rec.period_result <> 200 THEN
    RAISE EXCEPTION 'the proof saw a result of %, the subsidiary earned 200', v_rec.period_result;
  END IF;
  IF v_rec.opening_net_assets <> 1000 THEN
    RAISE EXCEPTION 'the proof saw opening net assets of %, expected 1000', v_rec.opening_net_assets;
  END IF;

  ------------------------------------------- 6: uncovered rates are refused --
  -- Recorded rates are immutable and carry forward from the latest dated row,
  -- so a rate is genuinely absent only before the first one ever recorded. This
  -- fixture's rates start on 1 January 2026, so a January period has no opening
  -- (31 December) rate and translation must refuse rather than approximate.
  v_blocked := false;
  BEGIN
    PERFORM * FROM public.consolidation_translate_member(v_group, v_s, DATE '2026-01-01', DATE '2026-01-31');
  EXCEPTION WHEN others THEN v_blocked := (SQLSTATE = '22023'); END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'translation proceeded over a period with an uncovered exchange rate';
  END IF;



  RAISE EXCEPTION 'rollback: consolidation FX translation invariants passed (CTA movement %, proof %)',
    v_rec.cta_movement, v_rec.expected_cta_movement;
END $$;
