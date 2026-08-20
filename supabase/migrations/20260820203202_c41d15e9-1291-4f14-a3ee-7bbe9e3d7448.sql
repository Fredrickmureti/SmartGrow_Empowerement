-- ============================================================================
-- Cash flow engine correction (Phase 2.1), found by reconciling real data:
--
--  1. `opening_balance_equity` was parked with retained earnings. But an
--     opening-balance journal entry DEBITS cash and CREDITS that equity
--     account, so the cash arrived in the derived closing balance while no
--     section explained it — a permanent residual equal to opening capital
--     (measured: residual 100,400.00 = excluded equity movement 100,400.00).
--     It is a funding injection: present it on its own financing line.
--
--  2. Retained earnings stays out of financing (a year-end close would
--     otherwise re-count profit), but the closing entry ALSO debits the
--     income accounts, which distorted net income by the same amount. Both
--     legs of a close entry are now excluded from period P&L movement, so
--     the close is invisible to the statement instead of half-visible.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.finance_cash_flow_statement(
  _org_id uuid,
  _from date,
  _to date,
  _business_id uuid DEFAULT NULL::uuid,
  _branch_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'finance_cash_flow_statement: _org_id is required';
  END IF;
  IF _from IS NULL OR _to IS NULL THEN
    RAISE EXCEPTION 'finance_cash_flow_statement: _from and _to are required';
  END IF;
  IF _to < _from THEN
    RAISE EXCEPTION 'finance_cash_flow_statement: _to (%) is before _from (%)', _to, _from;
  END IF;

  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  IF _business_id IS NOT NULL THEN
    PERFORM 1 FROM public.businesses b
      WHERE b.id = _business_id AND b.organization_id = _org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'finance_cash_flow_statement: business % does not belong to org %', _business_id, _org_id;
    END IF;
  END IF;

  IF _branch_id IS NOT NULL THEN
    PERFORM 1 FROM public.branches br
      WHERE br.id = _branch_id
        AND br.organization_id = _org_id
        AND (_business_id IS NULL OR br.business_id = _business_id);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'finance_cash_flow_statement: branch % does not belong to org % / business %', _branch_id, _org_id, _business_id;
    END IF;
  END IF;

  RETURN (
  WITH scoped_accounts AS (
    SELECT a.id, a.code, a.name, a.account_type::text AS account_type,
           a.detail_type, a.system_role, a.cash_flow_category,
           COALESCE(a.opening_balance, 0) AS opening_balance
      FROM public.accounts a
     WHERE a.organization_id = _org_id
       AND a.is_active = true
       AND (_business_id IS NULL OR a.business_id = _business_id)
  ),
  opening_posted AS (
    SELECT DISTINCT jel.account_id
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
     WHERE je.organization_id = _org_id
       AND je.status = 'posted'
       AND je.source_type = 'opening_balance'
       AND (_business_id IS NULL OR je.business_id = _business_id)
  ),
  classified AS (
    SELECT sa.*,
           CASE
             WHEN sa.cash_flow_category IS NOT NULL AND sa.cash_flow_category <> '' THEN sa.cash_flow_category
             WHEN sa.system_role IN ('bank', 'cash', 'mobile_money') THEN 'cash'
             WHEN sa.detail_type IN ('cash_on_hand','petty_cash','checking','savings','bank','money_market','cash_and_cash_equivalents') THEN 'cash'
             WHEN sa.system_role = 'accounts_receivable' OR sa.detail_type = 'accounts_receivable' THEN 'operating_receivable'
             WHEN sa.system_role = 'accounts_payable' OR sa.detail_type = 'accounts_payable' THEN 'operating_payable'
             WHEN sa.system_role = 'inventory' OR sa.detail_type IN ('inventory','stock') THEN 'operating_inventory'
             WHEN sa.system_role = 'accumulated_depreciation' OR sa.detail_type IN ('accumulated_depreciation','accumulated_depletion') THEN 'investing_depreciation'
             WHEN sa.system_role = 'fixed_asset' OR sa.detail_type IN (
                    'buildings','depletable_assets','fixed_asset_computers','fixed_asset_copiers',
                    'fixed_asset_furniture','fixed_asset_phone','fixed_asset_photo_video',
                    'fixed_asset_software','fixed_asset_other_tools','furniture_fixtures',
                    'intangible_assets','land','leasehold_improvements','machinery_equipment',
                    'other_fixed_asset','vehicles') THEN 'investing_fixed_asset'
             WHEN sa.detail_type IN ('long_term_debt','notes_payable_non_current','shareholders_notes_payable','other_long_term_liabilities') THEN 'financing_loan'
             WHEN sa.account_type = 'income' THEN 'operating_income'
             WHEN sa.account_type = 'expense' THEN 'operating_expense'
             -- Capital introduced at go-live: a real funding inflow, shown on
             -- its own financing line so the statement still reconciles.
             WHEN sa.system_role = 'opening_balance_equity' THEN 'financing_opening_equity'
             -- Retained earnings is the destination of the year-end close;
             -- both legs of that close are removed from period movement below.
             WHEN sa.system_role = 'retained_earnings' THEN 'excluded_equity'
             WHEN sa.account_type = 'equity' THEN 'financing_equity'
             WHEN sa.account_type = 'asset' THEN 'operating_other_current_asset'
             WHEN sa.account_type = 'liability' THEN 'operating_other_current_liability'
             ELSE 'unclassified'
           END AS bucket,
           (sa.cash_flow_category IS NULL OR sa.cash_flow_category = '') AS defaulted
      FROM scoped_accounts sa
  ),
  close_entries AS (
    SELECT DISTINCT je.id
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN classified c ON c.id = jel.account_id
     WHERE je.organization_id = _org_id
       AND je.status = 'posted'
       AND je.entry_date BETWEEN _from AND _to
       AND (_business_id IS NULL OR je.business_id = _business_id)
       AND (_branch_id   IS NULL OR je.branch_id   = _branch_id)
       AND c.bucket = 'excluded_equity'
  ),
  period AS (
    SELECT jel.account_id,
           COALESCE(SUM(jel.debit), 0)  AS debit,
           COALESCE(SUM(jel.credit), 0) AS credit
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      JOIN classified c ON c.id = jel.account_id
     WHERE je.organization_id = _org_id
       AND je.status = 'posted'
       AND je.entry_date BETWEEN _from AND _to
       AND (_business_id IS NULL OR je.business_id = _business_id)
       AND (_branch_id   IS NULL OR je.branch_id   = _branch_id)
       -- drop BOTH legs of a year-end close from P&L movement
       AND NOT (
         c.bucket IN ('operating_income','operating_expense','excluded_equity')
         AND je.id IN (SELECT id FROM close_entries)
       )
     GROUP BY jel.account_id
  ),
  upto_open AS (
    SELECT jel.account_id,
           COALESCE(SUM(jel.debit), 0)  AS debit,
           COALESCE(SUM(jel.credit), 0) AS credit
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
     WHERE je.organization_id = _org_id
       AND je.status = 'posted'
       AND je.entry_date < _from
       AND (_business_id IS NULL OR je.business_id = _business_id)
       AND (_branch_id   IS NULL OR je.branch_id   = _branch_id)
     GROUP BY jel.account_id
  ),
  upto_close AS (
    SELECT jel.account_id,
           COALESCE(SUM(jel.debit), 0)  AS debit,
           COALESCE(SUM(jel.credit), 0) AS credit
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
     WHERE je.organization_id = _org_id
       AND je.status = 'posted'
       AND je.entry_date <= _to
       AND (_business_id IS NULL OR je.business_id = _business_id)
       AND (_branch_id   IS NULL OR je.branch_id   = _branch_id)
     GROUP BY jel.account_id
  ),
  fx_entries AS (
    SELECT DISTINCT je.id
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN classified c ON c.id = jel.account_id
     WHERE je.organization_id = _org_id
       AND je.status = 'posted'
       AND je.entry_date BETWEEN _from AND _to
       AND (_business_id IS NULL OR je.business_id = _business_id)
       AND (_branch_id   IS NULL OR je.branch_id   = _branch_id)
       AND c.system_role IN ('fx_realized_gain','fx_realized_loss')
  ),
  fx_cash AS (
    SELECT COALESCE(SUM(jel.debit - jel.credit), 0) AS amount
      FROM public.journal_entry_lines jel
      JOIN fx_entries fe ON fe.id = jel.journal_entry_id
      JOIN classified c  ON c.id = jel.account_id
     WHERE c.bucket = 'cash'
  ),
  movement AS (
    SELECT c.*,
           COALESCE(p.debit, 0)  AS p_debit,
           COALESCE(p.credit, 0) AS p_credit,
           CASE WHEN c.account_type IN ('asset','expense')
                THEN COALESCE(p.debit,0) - COALESCE(p.credit,0)
                ELSE COALESCE(p.credit,0) - COALESCE(p.debit,0)
           END AS natural_movement
      FROM classified c
      LEFT JOIN period p ON p.account_id = c.id
  ),
  cash_balances AS (
    SELECT c.id, c.code, c.name,
           CASE WHEN op.account_id IS NULL THEN c.opening_balance ELSE 0 END
             + COALESCE(uo.debit,0) - COALESCE(uo.credit,0) AS opening,
           CASE WHEN op.account_id IS NULL THEN c.opening_balance ELSE 0 END
             + COALESCE(uc.debit,0) - COALESCE(uc.credit,0) AS closing
      FROM classified c
      LEFT JOIN opening_posted op ON op.account_id = c.id
      LEFT JOIN upto_open  uo ON uo.account_id = c.id
      LEFT JOIN upto_close uc ON uc.account_id = c.id
     WHERE c.bucket = 'cash'
  ),
  agg AS (
    SELECT
      COALESCE(SUM(m.natural_movement) FILTER (WHERE m.bucket = 'operating_income'), 0)
        - COALESCE(SUM(m.natural_movement) FILTER (WHERE m.bucket = 'operating_expense'), 0) AS net_income,
      COALESCE(SUM(m.p_credit - m.p_debit) FILTER (WHERE m.bucket = 'investing_depreciation'), 0) AS depreciation,
      -COALESCE(SUM(m.natural_movement) FILTER (WHERE m.bucket = 'operating_receivable'), 0) AS ar_change,
      -COALESCE(SUM(m.natural_movement) FILTER (WHERE m.bucket = 'operating_inventory'), 0) AS inventory_change,
       COALESCE(SUM(m.natural_movement) FILTER (WHERE m.bucket = 'operating_payable'), 0) AS ap_change,
      -COALESCE(SUM(m.natural_movement) FILTER (WHERE m.bucket = 'operating_other_current_asset'), 0) AS oca_change,
       COALESCE(SUM(m.natural_movement) FILTER (WHERE m.bucket = 'operating_other_current_liability'), 0) AS ocl_change,
       COALESCE(SUM(m.natural_movement) FILTER (WHERE m.bucket = 'investing_fixed_asset'), 0) AS fixed_assets,
       COALESCE(SUM(m.natural_movement) FILTER (WHERE m.bucket = 'financing_loan'), 0) AS loans,
       COALESCE(SUM(m.natural_movement) FILTER (WHERE m.bucket = 'financing_equity'), 0) AS equity,
       COALESCE(SUM(m.natural_movement) FILTER (WHERE m.bucket = 'financing_opening_equity'), 0) AS opening_equity
      FROM movement m
  ),
  needs_classification AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'account_id', m.id,
             'code', m.code,
             'name', m.name,
             'account_type', m.account_type,
             'assumed_bucket', m.bucket,
             'net_movement', round(m.natural_movement, 2)
           ) ORDER BY m.code), '[]'::jsonb) AS rows
      FROM movement m
     WHERE m.defaulted
       AND m.bucket NOT IN ('operating_income','operating_expense')
       AND (m.p_debit <> 0 OR m.p_credit <> 0)
  ),
  totals AS (
    SELECT a.*,
      (SELECT amount FROM fx_cash) AS fx_effect,
      COALESCE((SELECT SUM(opening) FROM cash_balances), 0) AS opening_cash,
      COALESCE((SELECT SUM(closing) FROM cash_balances), 0) AS closing_cash
      FROM agg a
  ),
  computed AS (
    SELECT t.*,
      (t.net_income + t.depreciation + t.ar_change + t.inventory_change
        + t.ap_change + t.oca_change + t.ocl_change - t.fx_effect) AS operating_total,
      (-t.fixed_assets) AS investing_total,
      (t.loans + t.equity + t.opening_equity) AS financing_total
      FROM totals t
  )
  SELECT jsonb_build_object(
    'from', _from,
    'to', _to,
    'basis', 'indirect',
    'currency_basis', 'base',
    'operating', jsonb_build_object(
      'label', 'Cash flows from operating activities',
      'total', round(c.operating_total, 2),
      'items', (
        SELECT COALESCE(jsonb_agg(i ORDER BY ord), '[]'::jsonb)
          FROM (
            SELECT 1 AS ord, jsonb_build_object('key','net_income','label','Net income','amount', round(c.net_income,2)) AS i
            UNION ALL SELECT 2, jsonb_build_object('key','depreciation','label','Depreciation & amortisation','amount', round(c.depreciation,2))
            UNION ALL SELECT 3, jsonb_build_object('key','fx_reclass','label','FX (gain)/loss on cash reclassified','amount', round(-c.fx_effect,2))
            UNION ALL SELECT 4, jsonb_build_object('key','ar','label','Change in receivables','amount', round(c.ar_change,2))
            UNION ALL SELECT 5, jsonb_build_object('key','inventory','label','Change in inventory','amount', round(c.inventory_change,2))
            UNION ALL SELECT 6, jsonb_build_object('key','ap','label','Change in payables','amount', round(c.ap_change,2))
            UNION ALL SELECT 7, jsonb_build_object('key','oca','label','Change in other current assets','amount', round(c.oca_change,2))
            UNION ALL SELECT 8, jsonb_build_object('key','ocl','label','Change in other current liabilities','amount', round(c.ocl_change,2))
          ) s
         WHERE abs(COALESCE((s.i ->> 'amount')::numeric, 0)) >= 0.01
      )
    ),
    'investing', jsonb_build_object(
      'label', 'Cash flows from investing activities',
      'total', round(c.investing_total, 2),
      'items', CASE WHEN abs(c.fixed_assets) >= 0.01
        THEN jsonb_build_array(jsonb_build_object('key','fixed_assets','label','Net additions to non-current assets','amount', round(-c.fixed_assets,2)))
        ELSE '[]'::jsonb END
    ),
    'financing', jsonb_build_object(
      'label', 'Cash flows from financing activities',
      'total', round(c.financing_total, 2),
      'items', (
        SELECT COALESCE(jsonb_agg(i ORDER BY ord), '[]'::jsonb)
          FROM (
            SELECT 1 AS ord, jsonb_build_object('key','loans','label','Net borrowings / repayments','amount', round(c.loans,2)) AS i
            UNION ALL SELECT 2, jsonb_build_object('key','equity','label','Equity contributions / distributions','amount', round(c.equity,2))
            UNION ALL SELECT 3, jsonb_build_object('key','opening_equity','label','Opening balance equity','amount', round(c.opening_equity,2))
          ) s
         WHERE abs(COALESCE((s.i ->> 'amount')::numeric, 0)) >= 0.01
      )
    ),
    'net_cash_flow', round(c.operating_total + c.investing_total + c.financing_total, 2),
    'fx_effect', round(c.fx_effect, 2),
    'opening_cash', round(c.opening_cash, 2),
    'closing_cash', round(c.closing_cash, 2),
    'reconciliation', jsonb_build_object(
      'opening_cash', round(c.opening_cash, 2),
      'net_cash_flow', round(c.operating_total + c.investing_total + c.financing_total, 2),
      'fx_effect', round(c.fx_effect, 2),
      'expected_closing_cash', round(c.opening_cash + c.operating_total + c.investing_total + c.financing_total + c.fx_effect, 2),
      'derived_closing_cash', round(c.closing_cash, 2),
      'residual', round(c.closing_cash - (c.opening_cash + c.operating_total + c.investing_total + c.financing_total + c.fx_effect), 2),
      'in_balance', abs(c.closing_cash - (c.opening_cash + c.operating_total + c.investing_total + c.financing_total + c.fx_effect)) < 0.01
    ),
    'cash_accounts', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'account_id', cb.id, 'code', cb.code, 'name', cb.name,
               'opening', round(cb.opening,2), 'closing', round(cb.closing,2),
               'movement', round(cb.closing - cb.opening, 2)
             ) ORDER BY cb.code), '[]'::jsonb)
        FROM cash_balances cb
    ),
    'needs_classification', (SELECT rows FROM needs_classification)
  )
  FROM computed c
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.finance_cash_flow_statement(uuid,date,date,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_cash_flow_statement(uuid,date,date,uuid,uuid) TO authenticated, service_role;