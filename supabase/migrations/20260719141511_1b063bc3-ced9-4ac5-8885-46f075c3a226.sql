-- 1. Enrich preview with account_code + account_name
CREATE OR REPLACE FUNCTION public.get_pos_statement_posting_preview(p_statement_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_stmt          public.pos_statements%ROWTYPE;
  v_net_revenue   numeric := 0;
  v_tax_amt       numeric := 0;
  v_tip_amt       numeric := 0;
  v_tender        RECORD;
  v_pm_id         uuid;
  v_kind          text;
  v_acct          uuid;
  v_acct_code     text;
  v_acct_name     text;
  v_tenders       jsonb := '[]'::jsonb;
  v_revenue       jsonb := NULL;
  v_tax           jsonb := NULL;
  v_tip           jsonb := NULL;
  v_unresolved    jsonb := '[]'::jsonb;
  v_td            numeric := 0;
  v_tc            numeric := 0;
BEGIN
  SELECT * INTO v_stmt FROM public.pos_statements WHERE id = p_statement_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error','statement_not_found');
  END IF;

  v_net_revenue := COALESCE(v_stmt.total_sales,0) - COALESCE(v_stmt.total_returns,0)
                 - COALESCE(v_stmt.total_tax,0);
  v_tax_amt := COALESCE(v_stmt.total_tax, 0);
  v_tip_amt := COALESCE(v_stmt.total_tip, 0);

  FOR v_tender IN
    SELECT tender_method, processor,
           SUM(net_amount)   AS net_amt,
           SUM(gross_amount) AS gross,
           SUM(refund_amount) AS refunds
      FROM public.pos_statement_tender_lines
     WHERE statement_id = v_stmt.id
     GROUP BY tender_method, processor
  LOOP
    SELECT id, tender_kind INTO v_pm_id, v_kind
      FROM public.pos_payment_methods
     WHERE business_id = v_stmt.business_id
       AND method_key  = v_tender.tender_method
     ORDER BY (branch_id = v_stmt.branch_id) DESC NULLS LAST
     LIMIT 1;

    v_acct := public.resolve_pos_tender_gl_account(
                v_stmt.business_id, v_stmt.branch_id,
                COALESCE(v_kind, v_tender.tender_method),
                v_tender.processor, v_pm_id);
    v_acct_code := NULL; v_acct_name := NULL;
    IF v_acct IS NOT NULL THEN
      SELECT code, name INTO v_acct_code, v_acct_name FROM public.accounts WHERE id = v_acct;
    END IF;

    v_tenders := v_tenders || jsonb_build_array(jsonb_build_object(
      'tender_method',  v_tender.tender_method,
      'processor',      v_tender.processor,
      'tender_kind',    v_kind,
      'net_amount',     v_tender.net_amt,
      'gross_amount',   v_tender.gross,
      'refund_amount',  v_tender.refunds,
      'account_id',     v_acct,
      'account_code',   v_acct_code,
      'account_name',   v_acct_name,
      'resolved',       v_acct IS NOT NULL
    ));

    IF v_acct IS NULL AND COALESCE(v_tender.net_amt,0) <> 0 THEN
      v_unresolved := v_unresolved || jsonb_build_array(jsonb_build_object(
        'kind','tender',
        'key', v_tender.tender_method || COALESCE(':' || v_tender.processor,''),
        'amount', v_tender.net_amt,
        'hint','Map tender via Finance → Default Accounts (tender kind '
                || COALESCE(v_kind, v_tender.tender_method) || ') or pos_payment_methods.debit_account_id.'
      ));
    ELSIF v_acct IS NOT NULL AND COALESCE(v_tender.net_amt,0) <> 0 THEN
      v_td := v_td + CASE WHEN v_tender.net_amt >= 0 THEN v_tender.net_amt ELSE 0 END;
      v_tc := v_tc + CASE WHEN v_tender.net_amt <  0 THEN -v_tender.net_amt ELSE 0 END;
    END IF;
  END LOOP;

  IF v_net_revenue <> 0 THEN
    v_acct := COALESCE(
      public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'pos_revenue'),
      public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'sales_revenue'));
    v_acct_code := NULL; v_acct_name := NULL;
    IF v_acct IS NOT NULL THEN
      SELECT code, name INTO v_acct_code, v_acct_name FROM public.accounts WHERE id = v_acct;
    END IF;
    v_revenue := jsonb_build_object(
      'amount', v_net_revenue,
      'account_id', v_acct,
      'account_code', v_acct_code,
      'account_name', v_acct_name,
      'resolved', v_acct IS NOT NULL,
      'setting_keys', jsonb_build_array('pos_revenue','sales_revenue')
    );
    IF v_acct IS NULL THEN
      v_unresolved := v_unresolved || jsonb_build_array(jsonb_build_object(
        'kind','revenue','key','pos_revenue',
        'amount', v_net_revenue,
        'hint','Map pos_revenue (or sales_revenue) in Finance → Default Accounts for this business.'));
    ELSE
      v_tc := v_tc + CASE WHEN v_net_revenue > 0 THEN v_net_revenue ELSE 0 END;
      v_td := v_td + CASE WHEN v_net_revenue < 0 THEN -v_net_revenue ELSE 0 END;
    END IF;
  END IF;

  IF v_tax_amt <> 0 THEN
    v_acct := COALESCE(
      public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'pos_tax_payable'),
      public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'tax_payable'),
      public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'sales_tax_payable'));
    v_acct_code := NULL; v_acct_name := NULL;
    IF v_acct IS NOT NULL THEN
      SELECT code, name INTO v_acct_code, v_acct_name FROM public.accounts WHERE id = v_acct;
    END IF;
    v_tax := jsonb_build_object(
      'amount', v_tax_amt,
      'account_id', v_acct,
      'account_code', v_acct_code,
      'account_name', v_acct_name,
      'resolved', v_acct IS NOT NULL,
      'setting_keys', jsonb_build_array('pos_tax_payable','tax_payable','sales_tax_payable')
    );
    IF v_acct IS NULL THEN
      v_unresolved := v_unresolved || jsonb_build_array(jsonb_build_object(
        'kind','tax','key','pos_tax_payable',
        'amount', v_tax_amt,
        'hint','Map pos_tax_payable (or tax_payable / sales_tax_payable) in Finance → Default Accounts.'));
    ELSE
      v_tc := v_tc + v_tax_amt;
    END IF;
  END IF;

  IF v_tip_amt <> 0 THEN
    v_acct := public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'tip_liability');
    v_acct_code := NULL; v_acct_name := NULL;
    IF v_acct IS NOT NULL THEN
      SELECT code, name INTO v_acct_code, v_acct_name FROM public.accounts WHERE id = v_acct;
    END IF;
    v_tip := jsonb_build_object(
      'amount', v_tip_amt,
      'account_id', v_acct,
      'account_code', v_acct_code,
      'account_name', v_acct_name,
      'resolved', v_acct IS NOT NULL,
      'setting_keys', jsonb_build_array('tip_liability'),
      'optional', true
    );
    IF v_acct IS NOT NULL THEN
      v_tc := v_tc + v_tip_amt;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'statement_id',      v_stmt.id,
    'statement_number',  v_stmt.statement_number,
    'shift_id',          v_stmt.shift_id,
    'business_id',       v_stmt.business_id,
    'branch_id',         v_stmt.branch_id,
    'posting_status',    v_stmt.posting_status,
    'close_kind',        v_stmt.close_kind,
    'closed_at',         v_stmt.closed_at,
    'journal_entry_id',  v_stmt.journal_entry_id,
    'total_sales',       v_stmt.total_sales,
    'total_returns',     v_stmt.total_returns,
    'total_tax',         v_stmt.total_tax,
    'total_tip',         v_stmt.total_tip,
    'net_revenue',       v_net_revenue,
    'tenders',           v_tenders,
    'revenue',           v_revenue,
    'tax',               v_tax,
    'tip',               v_tip,
    'unresolved',        v_unresolved,
    'total_debit',       v_td,
    'total_credit',      v_tc,
    'balanced',          ABS(v_td - v_tc) <= 0.01,
    'ready_to_post',     jsonb_array_length(v_unresolved) = 0
                         AND v_stmt.closed_at IS NOT NULL
                         AND v_stmt.posting_status = 'pending'::pos_statement_posting_status
  );
END $function$;

GRANT EXECUTE ON FUNCTION public.get_pos_statement_posting_preview(uuid) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.retry_pos_statement_posting(uuid, text) TO authenticated, service_role;

-- 2. Force PostgREST to reload its schema cache so /rpc/retry_pos_statement_posting stops 404-ing.
NOTIFY pgrst, 'reload schema';