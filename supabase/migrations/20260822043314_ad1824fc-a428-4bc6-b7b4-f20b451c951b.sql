-- Executes section H/I of supabase/tests/ledger_reports_engine_test.sql.
-- Assertions only: the fixture is rolled back by design, so this migration
-- leaves no data behind. It fails loudly if the opening-balance contract breaks.
DO $lrx$
DECLARE
  org_c uuid := gen_random_uuid();
  biz_c uuid := gen_random_uuid();
  cash  uuid := gen_random_uuid();
  sales uuid := gen_random_uuid();
  rent  uuid := gen_random_uuid();
  reacc uuid := gen_random_uuid();
  unused uuid := gen_random_uuid();
  e1 uuid := gen_random_uuid();
  e2 uuid := gen_random_uuid();
  e3 uuid := gen_random_uuid();
  v_sales numeric; v_rent numeric; v_cash numeric; v_re numeric;
  v_dr numeric; v_cr numeric; v_fy date;
  n int;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  BEGIN
    INSERT INTO public.organizations(id, name, slug)
    VALUES (org_c, 'LRX Org C', 'lrx-org-c-' || left(org_c::text, 8));
    INSERT INTO public.businesses(id, organization_id, name, country)
    VALUES (biz_c, org_c, 'LRX Company C', 'KE');

    INSERT INTO public.accounts(id, organization_id, business_id, code, name, account_type, detail_type)
    VALUES (cash,   org_c, biz_c, 'C1000', 'C Cash',   'asset',  'cash_on_hand'),
           (sales,  org_c, biz_c, 'C4000', 'C Sales',  'income', 'sales_income'),
           (rent,   org_c, biz_c, 'C5000', 'C Rent',   'expense', 'office_expenses'),
           (reacc,  org_c, biz_c, 'C3100', 'C Retained Earnings', 'equity', 'retained_earnings'),
           (unused, org_c, biz_c, 'C9999', 'C Unused', 'asset',  'cash_on_hand');

    INSERT INTO public.journal_entries(id, organization_id, business_id, entry_number, entry_date,
                                       description, status, total_debit, total_credit)
    VALUES (e1, org_c, biz_c, 'C-JE-0001', DATE '2199-06-30', 'C prior year revenue', 'posted', 300, 300),
           (e2, org_c, biz_c, 'C-JE-0002', DATE '2199-07-31', 'C prior year rent',    'posted', 100, 100),
           (e3, org_c, biz_c, 'C-JE-0003', DATE '2200-01-15', 'C current year sale',  'posted', 50, 50);
    INSERT INTO public.journal_entry_lines(journal_entry_id, organization_id, business_id, account_id, debit, credit)
    VALUES (e1, org_c, biz_c, cash, 300, 0),
           (e1, org_c, biz_c, sales, 0, 300),
           (e2, org_c, biz_c, rent, 100, 0),
           (e2, org_c, biz_c, cash, 0, 100),
           (e3, org_c, biz_c, cash, 50, 0),
           (e3, org_c, biz_c, sales, 0, 50);

    SELECT o.fiscal_year_start INTO v_fy
      FROM public.get_ledger_opening_balances(org_c, biz_c, DATE '2200-02-01', NULL) o LIMIT 1;
    IF v_fy <> DATE '2200-01-01' THEN
      RAISE EXCEPTION 'fiscal year start should be 2200-01-01, got %', v_fy;
    END IF;

    SELECT
      max(o.opening_balance) FILTER (WHERE o.account_id = sales),
      max(o.opening_balance) FILTER (WHERE o.account_id = rent),
      max(o.opening_balance) FILTER (WHERE o.account_id = cash),
      max(o.opening_balance) FILTER (WHERE o.account_id = reacc)
      INTO v_sales, v_rent, v_cash, v_re
    FROM public.get_ledger_opening_balances(org_c, biz_c, DATE '2200-02-01', NULL) o;

    IF v_sales <> 50 THEN
      RAISE EXCEPTION 'income opening must reset at the fiscal year start (expected 50, got %)', v_sales;
    END IF;
    IF v_rent <> 0 THEN
      RAISE EXCEPTION 'expense opening must reset at the fiscal year start (expected 0, got %)', v_rent;
    END IF;
    IF v_cash <> 250 THEN
      RAISE EXCEPTION 'balance sheet opening must carry since inception (expected 250, got %)', v_cash;
    END IF;
    IF v_re <> 200 THEN
      RAISE EXCEPTION 'prior years result must land in retained earnings (expected 200, got %)', v_re;
    END IF;

    SELECT
      COALESCE(SUM(o.opening_balance) FILTER (WHERE a.account_type IN ('asset','expense')), 0),
      COALESCE(SUM(o.opening_balance) FILTER (WHERE a.account_type IN ('liability','equity','income')), 0)
      INTO v_dr, v_cr
    FROM public.get_ledger_opening_balances(org_c, biz_c, DATE '2200-02-01', NULL) o
    JOIN public.accounts a ON a.id = o.account_id;
    IF v_dr <> v_cr THEN
      RAISE EXCEPTION 'opening debits (%) must equal opening credits (%)', v_dr, v_cr;
    END IF;

    SELECT COALESCE(SUM(o.opening_balance), 0) INTO v_sales
      FROM public.get_ledger_opening_balances(org_c, biz_c, DATE '2200-01-01', NULL) o
      JOIN public.accounts a ON a.id = o.account_id
     WHERE a.account_type IN ('income','expense');
    IF v_sales <> 0 THEN
      RAISE EXCEPTION 'nominal accounts must open at zero on the first day of the fiscal year, got %', v_sales;
    END IF;

    SELECT DISTINCT gl.opening_balance INTO v_sales
      FROM public.get_general_ledger(org_c, DATE '2200-02-01', DATE '2200-02-28', biz_c,
                                     ARRAY[sales], true, NULL) gl;
    IF v_sales <> 50 THEN
      RAISE EXCEPTION 'get_general_ledger opening must match the opening engine (expected 50, got %)', v_sales;
    END IF;

    SELECT count(*) INTO n
      FROM public.get_general_ledger(org_c, DATE '2200-02-01', DATE '2200-02-28', biz_c,
                                     ARRAY[unused], false, NULL);
    IF n <> 0 THEN
      RAISE EXCEPTION 'a zero-activity, zero-opening account must be excluded by default, got % rows', n;
    END IF;

    SELECT count(*) INTO n
      FROM public.get_general_ledger(org_c, DATE '2200-02-01', DATE '2200-02-28', biz_c,
                                     ARRAY[unused], true, NULL);
    IF n <> 1 THEN
      RAISE EXCEPTION '_include_zero_activity must surface the account exactly once, got % rows', n;
    END IF;

    SELECT count(*) INTO n
      FROM public.get_general_ledger(org_c, DATE '2200-02-01', DATE '2200-02-28', biz_c,
                                     ARRAY[cash], false, NULL);
    IF n <> 1 THEN
      RAISE EXCEPTION 'an account with a brought-forward balance must always appear, got % rows', n;
    END IF;

    RAISE EXCEPTION 'LRX_ROLLBACK_OK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'LRX_ROLLBACK_OK' THEN
      RAISE EXCEPTION 'ledger fiscal-year opening contract FAILED: %', SQLERRM;
    END IF;
    RAISE NOTICE 'ledger fiscal-year opening contract: PASS';
  END;
END $lrx$;