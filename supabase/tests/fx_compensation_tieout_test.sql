-- Realized FX on compensation paths (ADR 0136 / ADR 0123) — Phase 6.
--
-- Covers the two settlement routes the AR/AP receipt tie-outs do not touch:
--   1. a customer credit note applied to an invoice booked at a different rate
--   2. a cash refund of a foreign credit note at a later rate
--
-- Both sides are relieved at their own booking rate; the difference is realized
-- FX. Nothing may fall back to parity.
--
-- Self-aborting: the final RAISE rolls the whole fixture back. Run it through
-- the migration tool and read the reported figures.
DO $outer$
DECLARE
  c_org  uuid := '8e682296-c634-44c8-ae00-bc48940ec28b';
  c_biz  uuid := 'bf392ca6-a743-435c-ae41-5bf25199470d';
  c_user uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  c_br uuid; c_cust uuid; c_ar uuid; c_gain uuid; c_loss uuid;
  c_bankacct uuid; c_bankgl uuid; c_creditgl uuid;
  d_book date := CURRENT_DATE - 9;
  d_cn   date := CURRENT_DATE - 4;
  d_ref  date := CURRENT_DATE;
  v_rate_book numeric; v_rate_cn numeric; v_rate_ref numeric;
  v_inv uuid; v_cn uuid; v_res jsonb; v_refund uuid; v_je uuid;
  v_ar_net numeric; v_cred_net numeric; v_fx_net numeric; v_bank_net numeric;
  rep_cn text := 'not run'; rep_ref text := 'not run'; v_rep text;
BEGIN
  SELECT id INTO c_br FROM public.branches WHERE business_id = c_biz LIMIT 1;
  SELECT id INTO c_cust FROM public.contacts WHERE organization_id = c_org AND business_id = c_biz LIMIT 1;
  c_ar       := public.compensation_account(c_biz, 'accounts_receivable');
  c_creditgl := public.customer_credit_account(c_biz);
  c_gain     := public.resolve_fx_realized_account(c_biz, 'gain');
  c_loss     := public.resolve_fx_realized_account(c_biz, 'loss');
  -- The bank's GL account must be company-scoped; a bank row pointing at an
  -- unscoped account is a data defect, not an FX one.
  SELECT ba.id, ba.account_id INTO c_bankacct, c_bankgl
    FROM public.bank_accounts ba JOIN public.accounts a ON a.id = ba.account_id
   WHERE ba.business_id = c_biz AND a.business_id = c_biz LIMIT 1;
  v_rate_book := public.resolve_exchange_rate(c_org, c_biz, 'USD', d_book);
  IF c_br IS NULL OR c_cust IS NULL OR c_bankacct IS NULL OR v_rate_book IS NULL THEN
    RAISE EXCEPTION 'FIXTURE UNAVAILABLE br=% cust=% bank=% rate=%', c_br, c_cust, c_bankacct, v_rate_book;
  END IF;
  v_rate_cn  := v_rate_book + 3;
  v_rate_ref := v_rate_book + 7;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', c_user::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', c_user::text, true);

  -- ===== 1. credit note applied to an invoice booked at another rate =====
  BEGIN
    INSERT INTO public.exchange_rates (organization_id, business_id, from_currency, to_currency, rate, effective_date, source)
    VALUES (c_org, c_biz, 'USD', 'KES', v_rate_cn, d_cn, 'override');
    INSERT INTO public.business_active_currencies (organization_id, business_id, currency_code, is_enabled)
    VALUES (c_org, c_biz, 'USD', true) ON CONFLICT DO NOTHING;

    v_inv := gen_random_uuid();
    INSERT INTO public.invoices (id, organization_id, business_id, branch_id, contact_id, invoice_number, status, issue_date, due_date, currency, subtotal, tax_amount, total)
    VALUES (v_inv, c_org, c_biz, c_br, c_cust, 'FXCN-INV-' || substr(v_inv::text,1,8), 'draft', d_book, d_book + 30, 'USD', 1000, 0, 1000);
    INSERT INTO public.invoice_items (invoice_id, description, quantity, unit_price, line_total)
    VALUES (v_inv, 'FX CN fixture', 1, 1000, 1000);
    PERFORM public._confirm_invoice_core(v_inv, c_user, NULL, 'confirmed');

    v_cn := gen_random_uuid();
    INSERT INTO public.credit_notes (id, organization_id, business_id, branch_id, contact_id, credit_note_number, status, issue_date, currency, subtotal, tax_amount, total, reason)
    VALUES (v_cn, c_org, c_biz, c_br, c_cust, 'FXCN-' || substr(v_cn::text,1,8), 'draft', d_cn, 'USD', 400, 0, 400, 'FX fixture');
    INSERT INTO public.credit_note_items (credit_note_id, description, quantity, unit_price, line_total)
    VALUES (v_cn, 'FX CN fixture line', 1, 400, 400);
    PERFORM public.confirm_credit_note_atomic(v_cn, c_user, NULL);

    v_res := public.apply_credit_to_invoice_atomic(c_org, c_biz, v_cn, v_inv, 400, c_user, 'fx fixture', c_br);
    v_je := (v_res->>'journal_entry_id')::uuid;
    SELECT COALESCE(SUM(CASE WHEN account_id = c_ar THEN credit - debit END),0),
           COALESCE(SUM(CASE WHEN account_id = c_creditgl THEN debit - credit END),0),
           COALESCE(SUM(CASE WHEN account_id IN (c_gain,c_loss) THEN credit - debit END),0)
      INTO v_ar_net, v_cred_net, v_fx_net
      FROM public.journal_entry_lines WHERE journal_entry_id = v_je;
    v_rep := format('AR %s/%s | credit liab %s/%s | fx gain %s/%s',
      v_ar_net, 400*v_rate_book, v_cred_net, 400*v_rate_cn, v_fx_net, 400*(v_rate_cn - v_rate_book));
    IF abs(v_ar_net   - 400*v_rate_book) > 0.01 THEN RAISE EXCEPTION 'FAIL AR not at invoice booking rate — %', v_rep; END IF;
    IF abs(v_cred_net - 400*v_rate_cn)   > 0.01 THEN RAISE EXCEPTION 'FAIL credit not at CN booking rate — %', v_rep; END IF;
    IF abs(v_fx_net - 400*(v_rate_cn - v_rate_book)) > 0.01 THEN RAISE EXCEPTION 'FAIL fx delta — %', v_rep; END IF;
    RAISE EXCEPTION 'PASS %', v_rep;
  EXCEPTION WHEN others THEN rep_cn := SQLERRM;
  END;

  -- ===== 2. cash refund of a foreign credit note at a later rate =====
  BEGIN
    INSERT INTO public.exchange_rates (organization_id, business_id, from_currency, to_currency, rate, effective_date, source)
    VALUES (c_org, c_biz, 'USD', 'KES', v_rate_cn, d_cn, 'override');
    INSERT INTO public.exchange_rates (organization_id, business_id, from_currency, to_currency, rate, effective_date, source)
    VALUES (c_org, c_biz, 'USD', 'KES', v_rate_ref, d_ref, 'override');
    INSERT INTO public.business_active_currencies (organization_id, business_id, currency_code, is_enabled)
    VALUES (c_org, c_biz, 'USD', true) ON CONFLICT DO NOTHING;

    v_cn := gen_random_uuid();
    INSERT INTO public.credit_notes (id, organization_id, business_id, branch_id, contact_id, credit_note_number, status, issue_date, currency, subtotal, tax_amount, total, reason)
    VALUES (v_cn, c_org, c_biz, c_br, c_cust, 'FXREF-' || substr(v_cn::text,1,8), 'draft', d_cn, 'USD', 500, 0, 500, 'FX refund fixture');
    INSERT INTO public.credit_note_items (credit_note_id, description, quantity, unit_price, line_total)
    VALUES (v_cn, 'FX refund fixture line', 1, 500, 500);
    PERFORM public.confirm_credit_note_atomic(v_cn, c_user, NULL);

    v_refund := public.refund_customer_atomic('credit_note', v_cn, c_bankacct, 500, d_ref,
                  'customer_refund_requested'::payment_reversal_reason, 'fx fixture', 'bank_transfer', 'FXREF', NULL);
    SELECT l.journal_entry_id INTO v_je FROM public.journal_entry_lines l
      JOIN public.journal_entries je ON je.id = l.journal_entry_id
     WHERE l.account_id = c_bankgl AND je.business_id = c_biz AND l.credit = ROUND(500*v_rate_ref, 2)
     ORDER BY je.created_at DESC LIMIT 1;
    IF v_je IS NULL THEN RAISE EXCEPTION 'FAIL no journal entry for refund %', v_refund; END IF;
    SELECT COALESCE(SUM(CASE WHEN account_id = c_creditgl THEN debit - credit END),0),
           COALESCE(SUM(CASE WHEN account_id = c_bankgl THEN credit - debit END),0),
           COALESCE(SUM(CASE WHEN account_id IN (c_gain,c_loss) THEN debit - credit END),0)
      INTO v_cred_net, v_bank_net, v_fx_net
      FROM public.journal_entry_lines WHERE journal_entry_id = v_je;
    v_rep := format('credit liab %s/%s | bank out %s/%s | fx loss %s/%s',
      v_cred_net, 500*v_rate_cn, v_bank_net, 500*v_rate_ref, v_fx_net, 500*(v_rate_ref - v_rate_cn));
    IF abs(v_cred_net - 500*v_rate_cn)  > 0.01 THEN RAISE EXCEPTION 'FAIL credit not at booking rate — %', v_rep; END IF;
    IF abs(v_bank_net - 500*v_rate_ref) > 0.01 THEN RAISE EXCEPTION 'FAIL cash not at refund-date rate — %', v_rep; END IF;
    IF abs(v_fx_net - 500*(v_rate_ref - v_rate_cn)) > 0.01 THEN RAISE EXCEPTION 'FAIL realized fx — %', v_rep; END IF;
    RAISE EXCEPTION 'PASS %', v_rep;
  EXCEPTION WHEN others THEN rep_ref := SQLERRM;
  END;

  RAISE EXCEPTION 'COMPENSATION TIEOUT >> CN-APPLY: [%] >> REFUND: [%]', rep_cn, rep_ref;
END $outer$;
