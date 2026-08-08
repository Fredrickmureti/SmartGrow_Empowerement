CREATE OR REPLACE FUNCTION public.post_pos_statement_gl(p_statement_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_stmt         public.pos_statements%ROWTYPE;
  v_key          text;
  v_existing_je  uuid;
  v_lines        jsonb := '[]'::jsonb;
  v_line         jsonb;
  v_tot_tender   numeric := 0;
  v_net_revenue  numeric := 0;
  v_tax_amt      numeric := 0;
  v_tip_amt      numeric := 0;
  v_entry_number text;
  v_je_id        uuid;
  v_acct         uuid;
  v_pm_id        uuid;
  v_kind         text;
  v_tender       RECORD;
  v_actor        uuid;
  v_td           numeric;
  v_tc           numeric;
  -- ADR 0122 ladder: per-product revenue / COGS / inventory resolution
  v_rev_default  uuid;
  v_cogs_default uuid;
  v_inv_default  uuid;
  v_row          RECORD;
  v_accts        uuid[]   := '{}';
  v_basis        numeric[] := '{}';
  v_total_basis  numeric  := 0;
  v_alloc        numeric;
  v_alloc_sum    numeric  := 0;
  v_i            int;
  v_n            int;
  v_cogs_total   numeric  := 0;
BEGIN
  SELECT * INTO v_stmt FROM public.pos_statements WHERE id = p_statement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post_pos_statement_gl: statement % not found', p_statement_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_stmt.close_kind = 'historical_backfill'::pos_statement_close_kind THEN
    RETURN jsonb_build_object('statement_id', v_stmt.id, 'skipped', true, 'reason', 'historical_backfill');
  END IF;
  IF v_stmt.closed_at IS NULL THEN
    RAISE EXCEPTION 'post_pos_statement_gl: statement % is not closed', p_statement_id
      USING ERRCODE = '22023';
  END IF;
  IF v_stmt.posting_status = 'posted'::pos_statement_posting_status THEN
    RETURN jsonb_build_object('statement_id', v_stmt.id, 'journal_entry_id', v_stmt.journal_entry_id,
                              'already_posted', true);
  END IF;
  IF v_stmt.posting_status = 'reversed'::pos_statement_posting_status THEN
    RAISE EXCEPTION 'post_pos_statement_gl: statement % is reversed', p_statement_id
      USING ERRCODE = '22023';
  END IF;

  v_key := COALESCE(p_idempotency_key, v_stmt.idempotency_key, 'stmt:' || v_stmt.id::text);

  SELECT journal_entry_id INTO v_existing_je
    FROM public.pos_statement_gl_apply_log
   WHERE statement_id = v_stmt.id AND idempotency_key = v_key;
  IF v_existing_je IS NOT NULL THEN
    RETURN jsonb_build_object('statement_id', v_stmt.id, 'journal_entry_id', v_existing_je,
                              'already_posted', true, 'via', 'apply_log');
  END IF;

  v_actor := COALESCE(v_stmt.closed_by, v_stmt.opened_by);

  v_net_revenue := COALESCE(v_stmt.total_sales,0) - COALESCE(v_stmt.total_returns,0)
                 - COALESCE(v_stmt.total_tax,0);
  v_tax_amt     := COALESCE(v_stmt.total_tax, 0);
  v_tip_amt     := COALESCE(v_stmt.total_tip, 0);

  FOR v_tender IN
    SELECT tender_method, processor,
           SUM(net_amount)    AS net_amt,
           SUM(gross_amount)  AS gross,
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
                v_tender.processor,
                v_pm_id);

    IF v_acct IS NULL THEN
      RAISE EXCEPTION 'post_pos_statement_gl: no GL account resolved for tender % (processor %) on statement %',
        v_tender.tender_method, COALESCE(v_tender.processor,'<none>'), v_stmt.id
        USING ERRCODE = 'check_violation';
    END IF;

    IF COALESCE(v_tender.net_amt,0) <> 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_acct,
        'debit',  CASE WHEN v_tender.net_amt >= 0 THEN v_tender.net_amt      ELSE 0 END,
        'credit', CASE WHEN v_tender.net_amt <  0 THEN -v_tender.net_amt     ELSE 0 END,
        'description',
          'POS ' || v_tender.tender_method
          || COALESCE(' / ' || v_tender.processor, '')
          || ' — statement ' || v_stmt.statement_number,
        'branch_id', v_stmt.branch_id));
      v_tot_tender := v_tot_tender + v_tender.net_amt;
    END IF;
  END LOOP;

  ------------------------------------------------------------------
  -- Revenue — split across the accounts the ADR 0122 ladder resolves
  -- (product -> nearest ancestor category -> company POS/sales default).
  -- The statement total is authoritative: per-account item basis only
  -- decides the split, and the residual lands on the last bucket so the
  -- sum always equals v_net_revenue to the cent.
  ------------------------------------------------------------------
  IF v_net_revenue <> 0 THEN
    v_rev_default := COALESCE(
      public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'pos_revenue'),
      public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'sales_revenue'));
    IF v_rev_default IS NULL THEN
      RAISE EXCEPTION 'post_pos_statement_gl: no revenue account (pos_revenue/sales_revenue) mapped for business %',
        v_stmt.business_id USING ERRCODE = 'check_violation';
    END IF;

    FOR v_row IN
      SELECT COALESCE(
               public.resolve_product_account_override(
                 v_stmt.organization_id, v_stmt.business_id, i.product_id, 'sales_revenue'),
               v_rev_default) AS acct,
             SUM((COALESCE(i.line_total,0) - COALESCE(i.tax_amount,0))
                 * CASE WHEN t.transaction_type = 'return' THEN -1 ELSE 1 END) AS basis
        FROM public.pos_transactions t
        JOIN public.pos_transaction_items i ON i.transaction_id = t.id
       WHERE t.shift_id = v_stmt.shift_id
         AND t.status = 'completed'
         AND t.transaction_type IN ('sale','return')
       GROUP BY 1
      HAVING SUM((COALESCE(i.line_total,0) - COALESCE(i.tax_amount,0))
                 * CASE WHEN t.transaction_type = 'return' THEN -1 ELSE 1 END) <> 0
       ORDER BY 2 DESC
    LOOP
      v_accts := v_accts || v_row.acct;
      v_basis := v_basis || v_row.basis;
      v_total_basis := v_total_basis + v_row.basis;
    END LOOP;

    v_n := COALESCE(array_length(v_accts, 1), 0);

    IF v_n = 0 OR v_total_basis = 0 THEN
      -- No usable item breakdown: keep the historical single-line behaviour.
      v_accts := ARRAY[v_rev_default];
      v_basis := ARRAY[v_net_revenue];
      v_n := 1;
      v_total_basis := v_net_revenue;
    END IF;

    FOR v_i IN 1..v_n LOOP
      IF v_i = v_n THEN
        v_alloc := v_net_revenue - v_alloc_sum;
      ELSE
        v_alloc := round(v_net_revenue * v_basis[v_i] / v_total_basis, 2);
        v_alloc_sum := v_alloc_sum + v_alloc;
      END IF;

      IF v_alloc <> 0 THEN
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account_id', v_accts[v_i],
          'debit',  CASE WHEN v_alloc < 0 THEN -v_alloc ELSE 0 END,
          'credit', CASE WHEN v_alloc > 0 THEN  v_alloc ELSE 0 END,
          'description', 'POS revenue — statement ' || v_stmt.statement_number,
          'branch_id', v_stmt.branch_id));
      END IF;
    END LOOP;
  END IF;

  IF v_tax_amt <> 0 THEN
    v_acct := COALESCE(
      public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'pos_tax_payable'),
      public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'tax_payable'),
      public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'sales_tax_payable'));
    IF v_acct IS NULL THEN
      RAISE EXCEPTION 'post_pos_statement_gl: no tax-payable account mapped for business %',
        v_stmt.business_id USING ERRCODE = 'check_violation';
    END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_acct,
      'debit',  0,
      'credit', v_tax_amt,
      'description', 'POS output tax — statement ' || v_stmt.statement_number,
      'branch_id', v_stmt.branch_id));
  END IF;

  IF v_tip_amt <> 0 THEN
    v_acct := public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'tip_liability');
    IF v_acct IS NOT NULL THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_acct,
        'debit',  0,
        'credit', v_tip_amt,
        'description', 'POS tips liability — statement ' || v_stmt.statement_number,
        'branch_id', v_stmt.branch_id));
    END IF;
  END IF;

  ------------------------------------------------------------------
  -- COGS / inventory relief — one debit+credit pair per resolved
  -- (cogs, inventory) account combination. Each pair nets to zero, so
  -- the entry stays balanced. Skipped when the company defaults are not
  -- mapped, so shift close never starts failing on unconfigured books.
  ------------------------------------------------------------------
  v_cogs_default := public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'cogs');
  v_inv_default  := public.get_default_account_id(v_stmt.organization_id, v_stmt.business_id, 'inventory');

  FOR v_row IN
    SELECT COALESCE(
             public.resolve_product_account_override(
               v_stmt.organization_id, v_stmt.business_id, i.product_id, 'cogs'),
             v_cogs_default) AS cogs_acct,
           COALESCE(
             public.resolve_product_account_override(
               v_stmt.organization_id, v_stmt.business_id, i.product_id, 'inventory'),
             v_inv_default) AS inv_acct,
           SUM(COALESCE(i.cost_price,0) * COALESCE(i.quantity,0)
               * CASE WHEN t.transaction_type = 'return' THEN -1 ELSE 1 END) AS amt
      FROM public.pos_transactions t
      JOIN public.pos_transaction_items i ON i.transaction_id = t.id
      JOIN public.products pr ON pr.id = i.product_id
     WHERE t.shift_id = v_stmt.shift_id
       AND t.status = 'completed'
       AND t.transaction_type IN ('sale','return')
       AND COALESCE(pr.track_inventory, false)
     GROUP BY 1, 2
    HAVING SUM(COALESCE(i.cost_price,0) * COALESCE(i.quantity,0)
               * CASE WHEN t.transaction_type = 'return' THEN -1 ELSE 1 END) <> 0
  LOOP
    CONTINUE WHEN v_row.cogs_acct IS NULL OR v_row.inv_acct IS NULL;

    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_row.cogs_acct,
        'debit',  CASE WHEN v_row.amt > 0 THEN  v_row.amt ELSE 0 END,
        'credit', CASE WHEN v_row.amt < 0 THEN -v_row.amt ELSE 0 END,
        'description', 'POS cost of goods sold — statement ' || v_stmt.statement_number,
        'branch_id', v_stmt.branch_id),
      jsonb_build_object(
        'account_id', v_row.inv_acct,
        'debit',  CASE WHEN v_row.amt < 0 THEN -v_row.amt ELSE 0 END,
        'credit', CASE WHEN v_row.amt > 0 THEN  v_row.amt ELSE 0 END,
        'description', 'POS inventory relief — statement ' || v_stmt.statement_number,
        'branch_id', v_stmt.branch_id));

    v_cogs_total := v_cogs_total + v_row.amt;
  END LOOP;

  IF jsonb_array_length(v_lines) < 2 THEN
    UPDATE public.pos_statements
       SET posting_status = 'posted'::pos_statement_posting_status,
           posted_at = now(),
           idempotency_key = v_key,
           updated_at = now()
     WHERE id = v_stmt.id;
    INSERT INTO public.pos_statement_gl_apply_log(statement_id, idempotency_key, journal_entry_id)
      VALUES (v_stmt.id, v_key, NULL);
    RETURN jsonb_build_object('statement_id', v_stmt.id, 'journal_entry_id', NULL, 'empty', true);
  END IF;

  v_td := 0; v_tc := 0;
  FOR v_line IN SELECT * FROM jsonb_array_elements(v_lines) LOOP
    v_td := v_td + COALESCE((v_line->>'debit')::numeric,  0);
    v_tc := v_tc + COALESCE((v_line->>'credit')::numeric, 0);
  END LOOP;
  IF ABS(v_td - v_tc) > 0.01 THEN
    RAISE EXCEPTION 'post_pos_statement_gl: unbalanced entry for statement % (debit=%, credit=%)',
      v_stmt.id, v_td, v_tc USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(
    'JE-' || LPAD(
      (COALESCE(MAX(NULLIF(regexp_replace(entry_number, '[^0-9]', '', 'g'), ''))::int, 0) + 1)::text,
      5, '0'), 'JE-00001')
    INTO v_entry_number
    FROM public.journal_entries WHERE organization_id = v_stmt.organization_id;

  v_je_id := public.post_journal_entry_atomic(
    v_stmt.organization_id, v_stmt.business_id, v_entry_number,
    v_stmt.closed_at::date,
    'POS-STMT-' || v_stmt.statement_number,
    'POS statement close — ' || v_stmt.statement_number,
    'pos_statement', v_stmt.id, v_actor,
    false, false, v_lines, NULL, NULL, NULL, v_stmt.branch_id);

  UPDATE public.pos_statements
     SET posting_status = 'posted'::pos_statement_posting_status,
         journal_entry_id = v_je_id,
         posted_at = now(),
         idempotency_key = v_key,
         updated_at = now()
   WHERE id = v_stmt.id;

  INSERT INTO public.pos_statement_gl_apply_log(statement_id, idempotency_key, journal_entry_id)
    VALUES (v_stmt.id, v_key, v_je_id);

  RETURN jsonb_build_object(
    'statement_id', v_stmt.id,
    'journal_entry_id', v_je_id,
    'entry_number', v_entry_number,
    'tender_total', v_tot_tender,
    'cogs_total', v_cogs_total);
END $function$;

COMMENT ON FUNCTION public.post_pos_statement_gl(uuid, text) IS
  'POS statement close posting. Revenue is split per ADR 0122 ladder (product -> category -> company default); COGS and inventory relief are posted per resolved account pair for stock-tracked items. Statement totals remain authoritative for revenue and tax.';
