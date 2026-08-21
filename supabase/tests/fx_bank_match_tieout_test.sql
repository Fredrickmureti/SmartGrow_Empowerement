-- Realized FX on the bank-reconciliation settlement route (ADR 0136 / ADR 0123)
-- — Phase 6, final settlement path.
--
-- bank_match_confirm settles documents straight from a statement line. It must
-- denominate that settlement in the *bank line's* currency at the statement
-- date, relieve the control account at the document's booking rate, and post
-- the difference as realized FX. It must never fall back to parity.
--
-- Two shapes are exercised against a foreign-currency bank account:
--   1. statement line carries original_currency explicitly
--   2. statement line omits original_currency (common with bank feeds) — the
--      bank account's own currency is then authoritative
--
-- Self-aborting: the final RAISE rolls the whole fixture back. Run it through
-- the migration tool and read the reported figures.
DO $outer$
DECLARE
  c_org  uuid := '8e682296-c634-44c8-ae00-bc48940ec28b';
  c_biz  uuid := 'bf392ca6-a743-435c-ae41-5bf25199470d';
  c_user uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  c_br uuid; c_cust uuid; c_ar uuid; c_gain uuid; c_loss uuid;
  c_bankacct uuid; c_bankgl uuid;
  d_book date := CURRENT_DATE - 9;
  d_stmt date := CURRENT_DATE - 2;
  v_rate_book numeric; v_rate_stmt numeric;
  v_rep text; rep_explicit text := 'not run'; rep_implicit text := 'not run';
BEGIN
  SELECT id INTO c_br FROM public.branches WHERE business_id = c_biz LIMIT 1;
  SELECT id INTO c_cust FROM public.contacts WHERE organization_id = c_org AND business_id = c_biz LIMIT 1;
  c_ar   := public.compensation_account(c_biz, 'accounts_receivable');
  c_gain := public.resolve_fx_realized_account(c_biz, 'gain');
  c_loss := public.resolve_fx_realized_account(c_biz, 'loss');
  SELECT ba.id, ba.account_id INTO c_bankacct, c_bankgl
    FROM public.bank_accounts ba JOIN public.accounts a ON a.id = ba.account_id
   WHERE ba.business_id = c_biz AND a.business_id = c_biz LIMIT 1;
  v_rate_book := public.resolve_exchange_rate(c_org, c_biz, 'USD', d_book);
  IF c_br IS NULL OR c_cust IS NULL OR c_bankacct IS NULL OR v_rate_book IS NULL THEN
    RAISE EXCEPTION 'FIXTURE UNAVAILABLE br=% cust=% bank=% rate=%', c_br, c_cust, c_bankacct, v_rate_book;
  END IF;
  v_rate_stmt := v_rate_book + 5.5;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', c_user::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', c_user::text, true);

  INSERT INTO public.exchange_rates (organization_id, business_id, from_currency, to_currency, rate, effective_date, source)
  VALUES (c_org, c_biz, 'USD', 'KES', v_rate_stmt, d_stmt, 'override');
  INSERT INTO public.business_active_currencies (organization_id, business_id, currency_code, is_enabled)
  VALUES (c_org, c_biz, 'USD', true) ON CONFLICT DO NOTHING;

  -- The fixture needs a foreign-currency bank account; the live org only has a
  -- base-currency one. Re-denominating it inside the aborted transaction keeps
  -- the GL wiring (and its company scope) intact.
  UPDATE public.bank_accounts SET currency = 'USD' WHERE id = c_bankacct;

  <<cases>>
  DECLARE
    v_inv uuid; v_txn uuid; v_match uuid; v_res jsonb; v_je uuid;
    v_ar_net numeric; v_bank_net numeric; v_fx_net numeric;
    v_explicit text;
  BEGIN
    FOR v_explicit IN SELECT unnest(ARRAY['explicit','implicit']) LOOP
      BEGIN
        v_inv := gen_random_uuid();
        INSERT INTO public.invoices (id, organization_id, business_id, branch_id, contact_id, invoice_number, status, issue_date, due_date, currency, subtotal, tax_amount, total)
        VALUES (v_inv, c_org, c_biz, c_br, c_cust, 'FXBM-INV-' || substr(v_inv::text,1,8), 'draft', d_book, d_book + 30, 'USD', 1000, 0, 1000);
        INSERT INTO public.invoice_items (invoice_id, description, quantity, unit_price, line_total)
        VALUES (v_inv, 'FX bank match fixture', 1, 1000, 1000);
        PERFORM public._confirm_invoice_core(v_inv, c_user, NULL, 'confirmed');

        v_txn := gen_random_uuid();
        INSERT INTO public.bank_transactions (id, organization_id, business_id, branch_id, bank_account_id,
          external_transaction_id, transaction_date, description, reference, amount, transaction_type,
          original_currency, original_amount)
        VALUES (v_txn, c_org, c_biz, c_br, c_bankacct,
          'FXBM-' || substr(v_txn::text,1,12), d_stmt, 'USD customer receipt', 'FXBM', 1000, 'credit',
          CASE WHEN v_explicit = 'explicit' THEN 'USD' END,
          CASE WHEN v_explicit = 'explicit' THEN 1000 END);

        v_match := gen_random_uuid();
        INSERT INTO public.bank_reconciliation_matches (id, organization_id, business_id, branch_id,
          bank_transaction_id, matched_amount, match_type, status, allocations, created_by)
        VALUES (v_match, c_org, c_biz, c_br, v_txn, 1000, 'manual', 'to_check',
          jsonb_build_array(jsonb_build_object('document_type','invoice','document_id', v_inv::text, 'amount', 1000)),
          c_user);

        v_res := public.bank_match_confirm(v_match, c_user, 'fxbm:' || substr(v_match::text,1,8));
        v_je := (v_res->>'journal_entry_id')::uuid;
        IF v_je IS NULL THEN RAISE EXCEPTION 'no journal entry produced: %', v_res; END IF;

        SELECT COALESCE(SUM(CASE WHEN account_id = c_ar THEN credit - debit END),0),
               COALESCE(SUM(CASE WHEN account_id = c_bankgl THEN debit - credit END),0),
               COALESCE(SUM(CASE WHEN account_id IN (c_gain,c_loss) THEN credit - debit END),0)
          INTO v_ar_net, v_bank_net, v_fx_net
          FROM public.journal_entry_lines WHERE journal_entry_id = v_je;

        v_rep := format('rate %s/%s | AR %s/%s | bank %s/%s | fx gain %s/%s',
          v_res->>'exchange_rate', v_rate_stmt,
          v_ar_net, 1000*v_rate_book, v_bank_net, 1000*v_rate_stmt,
          v_fx_net, 1000*(v_rate_stmt - v_rate_book));
        IF abs((v_res->>'exchange_rate')::numeric - v_rate_stmt) > 0.000001 THEN
          RAISE EXCEPTION 'FAIL settlement not denominated at the statement-date rate — %', v_rep; END IF;
        IF abs(v_ar_net - 1000*v_rate_book) > 0.01 THEN
          RAISE EXCEPTION 'FAIL AR not relieved at the invoice booking rate — %', v_rep; END IF;
        IF abs(v_bank_net - 1000*v_rate_stmt) > 0.01 THEN
          RAISE EXCEPTION 'FAIL cash not at the statement-date rate — %', v_rep; END IF;
        IF abs(v_fx_net - 1000*(v_rate_stmt - v_rate_book)) > 0.01 THEN
          RAISE EXCEPTION 'FAIL realized fx — %', v_rep; END IF;
        RAISE EXCEPTION 'PASS %', v_rep;
      EXCEPTION WHEN others THEN
        IF v_explicit = 'explicit' THEN rep_explicit := SQLERRM; ELSE rep_implicit := SQLERRM; END IF;
      END;
    END LOOP;
  END cases;

  RAISE EXCEPTION 'BANK MATCH FX TIEOUT >> EXPLICIT CCY: [%] >> IMPLICIT CCY: [%]', rep_explicit, rep_implicit;
END $outer$;
