CREATE OR REPLACE FUNCTION public.post_pos_shift_gl(_shift_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_shift             RECORD;
  v_existing          uuid;
  v_org_id            uuid;
  v_business_id       uuid;
  v_branch_id         uuid;
  v_actor             uuid;
  v_revenue_account   uuid;
  v_cogs_account      uuid;
  v_inventory_account uuid;
  v_cash_short_over_account uuid;
  v_cash_variance_account   uuid;
  v_total_sales       numeric := 0;
  v_total_tax         numeric := 0;
  v_total_net         numeric := 0;
  v_total_cogs        numeric := 0;
  v_shift_date        date;
  v_reference         text;
  v_entry_number      text;
  v_lines             jsonb := '[]'::jsonb;
  v_jeid              uuid;
  v_pay               RECORD;
  v_tax               RECORD;
  v_pay_account       uuid;
  v_tax_account       uuid;
  v_variance          numeric := 0;
BEGIN
  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = _shift_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'POS shift not found: %', _shift_id; END IF;

  v_existing := v_shift.journal_entry_id;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  v_org_id      := v_shift.organization_id;
  v_business_id := v_shift.business_id;
  v_branch_id   := v_shift.branch_id;
  IF v_branch_id IS NULL AND v_shift.register_id IS NOT NULL THEN
    SELECT branch_id INTO v_branch_id FROM public.pos_registers WHERE id = v_shift.register_id;
  END IF;

  v_actor := COALESCE(auth.uid(), v_shift.closed_by);
  IF v_actor IS NOT NULL AND v_business_id IS NOT NULL THEN
    IF NOT (
      EXISTS (SELECT 1 FROM public.user_business_access WHERE user_id = v_actor AND business_id = v_business_id)
      OR public.has_role(v_actor, v_org_id, 'owner'::public.app_role)
      OR public.has_role(v_actor, v_org_id, 'admin'::public.app_role)
    ) THEN
      RAISE EXCEPTION 'User % lacks business access to post POS shift GL for business %', v_actor, v_business_id USING ERRCODE = '42501';
    END IF;
  END IF;

  v_shift_date := COALESCE(v_shift.closed_at, v_shift.created_at, now())::date;
  v_reference  := 'POS-SHIFT-' || COALESCE(v_shift.shift_number, _shift_id::text);
  v_variance   := COALESCE(v_shift.cash_difference, 0);

  SELECT COALESCE(SUM(total),0), COALESCE(SUM(tax_amount),0), COALESCE(SUM(subtotal),0)
    INTO v_total_sales, v_total_tax, v_total_net
  FROM public.pos_transactions
  WHERE shift_id = _shift_id AND transaction_type='sale' AND status='completed';

  SELECT COALESCE(SUM(ti.cost_price * ti.quantity), 0)
    INTO v_total_cogs
  FROM public.pos_transaction_items ti
  JOIN public.pos_transactions t ON t.id = ti.transaction_id
  WHERE t.shift_id = _shift_id
    AND t.transaction_type = 'sale'
    AND t.status = 'completed';

  IF v_total_sales = 0 AND v_total_cogs = 0 AND v_variance = 0 THEN
    RETURN NULL;
  END IF;

  v_revenue_account  := public.get_default_account_id(v_org_id, v_business_id, 'pos_revenue');
  IF v_revenue_account IS NULL THEN v_revenue_account := public.get_default_account_id(v_org_id, v_business_id, 'sales_revenue'); END IF;

  v_cogs_account     := public.get_default_account_id(v_org_id, v_business_id, 'pos_cogs');
  IF v_cogs_account IS NULL THEN v_cogs_account := public.get_default_account_id(v_org_id, v_business_id, 'cogs'); END IF;

  v_inventory_account := public.get_default_account_id(v_org_id, v_business_id, 'pos_inventory');
  IF v_inventory_account IS NULL THEN v_inventory_account := public.get_default_account_id(v_org_id, v_business_id, 'inventory'); END IF;

  v_cash_short_over_account := public.get_default_account_id(v_org_id, v_business_id, 'cash_short_over');

  IF v_total_net <> 0 AND v_revenue_account IS NULL THEN
    RAISE EXCEPTION 'POS shift cannot post to GL: missing pos_revenue/sales_revenue account mapping. shift_id=%', _shift_id;
  END IF;

  FOR v_pay IN
    SELECT p.payment_method, SUM(p.amount) AS amt
    FROM public.pos_transaction_payments p
    JOIN public.pos_transactions t ON t.id = p.transaction_id
    WHERE t.shift_id = _shift_id
      AND t.transaction_type = 'sale'
      AND t.status = 'completed'
    GROUP BY p.payment_method
  LOOP
    SELECT COALESCE(pm_branch.debit_account_id, pm_company.debit_account_id)
      INTO v_pay_account
    FROM (SELECT 1) noop
    LEFT JOIN public.pos_payment_methods pm_branch
      ON pm_branch.business_id = v_business_id
     AND pm_branch.branch_id   = v_branch_id
     AND pm_branch.method_key  = v_pay.payment_method
    LEFT JOIN public.pos_payment_methods pm_company
      ON pm_company.business_id = v_business_id
     AND pm_company.branch_id   IS NULL
     AND pm_company.method_key  = v_pay.payment_method;

    IF v_pay_account IS NULL THEN
      RAISE EXCEPTION 'POS payment method "%" has no debit_account_id mapped for business %. Configure it in Company Settings → Payment Methods before closing the shift.',
        v_pay.payment_method, v_business_id
        USING ERRCODE = 'check_violation';
    END IF;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_pay_account,
      'debit',  v_pay.amt,
      'credit', 0,
      'description', 'POS ' || v_pay.payment_method || ' — shift ' || COALESCE(v_shift.shift_number, _shift_id::text),
      'branch_id', v_branch_id
    ));
  END LOOP;

  IF v_variance <> 0 THEN
    IF v_cash_short_over_account IS NULL THEN
      v_cash_short_over_account := public.ensure_cash_short_over_account(v_org_id, v_business_id);
    END IF;
    IF v_cash_short_over_account IS NULL THEN
      RAISE EXCEPTION 'POS shift has cash variance % but no cash_short_over account could be provisioned for business %. Check Settings → Account Mapping.',
        v_variance, v_business_id;
    END IF;

    SELECT COALESCE(
             pm_branch.debit_account_id,
             pm_branch.clearing_account_id,
             pm_company.debit_account_id,
             pm_company.clearing_account_id
           )
      INTO v_cash_variance_account
    FROM (SELECT 1) noop
    LEFT JOIN public.pos_payment_methods pm_branch
      ON pm_branch.business_id = v_business_id
     AND pm_branch.branch_id   = v_branch_id
     AND pm_branch.method_key  = 'cash'
    LEFT JOIN public.pos_payment_methods pm_company
      ON pm_company.business_id = v_business_id
     AND pm_company.branch_id   IS NULL
     AND pm_company.method_key  = 'cash';

    IF v_cash_variance_account IS NULL THEN
      v_cash_variance_account := public.get_default_account_id(v_org_id, v_business_id, 'pos_cash');
    END IF;
    IF v_cash_variance_account IS NULL THEN
      v_cash_variance_account := public.get_default_account_id(v_org_id, v_business_id, 'cash');
    END IF;

    IF v_cash_variance_account IS NULL THEN
      RAISE EXCEPTION 'POS shift has cash variance % but no cash drawer account is mapped for business %. Configure the cash payment method or default cash account before closing the shift.',
        v_variance, v_business_id;
    END IF;

    IF v_cash_variance_account = v_cash_short_over_account THEN
      RAISE EXCEPTION 'POS cash variance mapping is invalid for business %: drawer cash account and Cash Over/Short account cannot be the same account.',
        v_business_id;
    END IF;

    IF v_variance > 0 THEN
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object(
          'account_id', v_cash_variance_account,
          'debit',  v_variance,
          'credit', 0,
          'description', 'Cash overage deposited — shift ' || COALESCE(v_shift.shift_number, _shift_id::text),
          'branch_id', v_branch_id
        ),
        jsonb_build_object(
          'account_id', v_cash_short_over_account,
          'debit',  0,
          'credit', v_variance,
          'description', 'Cash overage — shift ' || COALESCE(v_shift.shift_number, _shift_id::text),
          'branch_id', v_branch_id
        )
      );
    ELSE
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object(
          'account_id', v_cash_short_over_account,
          'debit',  abs(v_variance),
          'credit', 0,
          'description', 'Cash shortage — shift ' || COALESCE(v_shift.shift_number, _shift_id::text),
          'branch_id', v_branch_id
        ),
        jsonb_build_object(
          'account_id', v_cash_variance_account,
          'debit',  0,
          'credit', abs(v_variance),
          'description', 'Cash shortage removed from drawer — shift ' || COALESCE(v_shift.shift_number, _shift_id::text),
          'branch_id', v_branch_id
        )
      );
    END IF;
  END IF;

  IF v_total_cogs > 0 THEN
    IF v_cogs_account IS NULL OR v_inventory_account IS NULL THEN
      RAISE EXCEPTION 'POS shift has COGS of % but COGS/inventory account mapping is incomplete for business %.',
        v_total_cogs, v_business_id;
    END IF;

    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_cogs_account,
        'debit',  v_total_cogs,
        'credit', 0,
        'description', 'COGS — shift ' || COALESCE(v_shift.shift_number, _shift_id::text),
        'branch_id', v_branch_id
      ),
      jsonb_build_object(
        'account_id', v_inventory_account,
        'debit',  0,
        'credit', v_total_cogs,
        'description', 'Inventory relief — shift ' || COALESCE(v_shift.shift_number, _shift_id::text),
        'branch_id', v_branch_id
      )
    );
  END IF;

  IF v_total_net <> 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_revenue_account,
      'debit',  0,
      'credit', v_total_net,
      'description', 'POS revenue — shift ' || COALESCE(v_shift.shift_number, _shift_id::text),
      'branch_id', v_branch_id
    ));
  END IF;

  FOR v_tax IN
    SELECT
      ti.tax_rate_id,
      MAX(tr.name)  AS rate_name,
      MAX(tr.rate)  AS rate_pct,
      SUM(ti.tax_amount) AS amt
    FROM public.pos_transaction_items ti
    JOIN public.pos_transactions t  ON t.id = ti.transaction_id
    LEFT JOIN public.tax_rates tr   ON tr.id = ti.tax_rate_id
    WHERE t.shift_id = _shift_id
      AND t.transaction_type = 'sale'
      AND t.status = 'completed'
      AND ti.tax_amount > 0
    GROUP BY ti.tax_rate_id
  LOOP
    v_tax_account := public.get_default_account_id(v_org_id, v_business_id, 'pos_tax_payable');
    IF v_tax_account IS NULL THEN
      v_tax_account := public.get_default_account_id(v_org_id, v_business_id, 'tax_payable');
    END IF;
    IF v_tax_account IS NULL THEN
      v_tax_account := public.get_default_account_id(v_org_id, v_business_id, 'sales_tax_payable');
    END IF;
    IF v_tax_account IS NULL THEN
      RAISE EXCEPTION 'POS shift has tax of % on rate "%" but no tax-payable account is mapped.',
        v_tax.amt, COALESCE(v_tax.rate_name, '<untagged>');
    END IF;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_tax_account,
      'debit',  0,
      'credit', v_tax.amt,
      'description', 'Tax — ' || COALESCE(v_tax.rate_name, 'untagged')
                     || COALESCE(' (' || v_tax.rate_pct::text || '%)', '')
                     || ' — shift ' || COALESCE(v_shift.shift_number, _shift_id::text),
      'branch_id', v_branch_id
    ));
  END LOOP;

  SELECT COALESCE(
    'JE-' || LPAD(
      (COALESCE(MAX(NULLIF(regexp_replace(entry_number, '[^0-9]', '', 'g'), ''))::int, 0) + 1)::text,
      5, '0'
    ),
    'JE-00001'
  )
  INTO v_entry_number
  FROM public.journal_entries
  WHERE organization_id = v_org_id;

  v_jeid := public.post_journal_entry_atomic(
    v_org_id,
    v_business_id,
    v_entry_number,
    v_shift_date,
    v_reference,
    'POS Shift Close — aggregated GL posting',
    'pos_shift',
    _shift_id,
    v_actor,
    false,
    false,
    v_lines,
    NULL,
    NULL,
    NULL,
    v_branch_id
  );

  UPDATE public.pos_shifts
     SET journal_entry_id = v_jeid,
         gl_posted_at     = now()
   WHERE id = _shift_id;

  RETURN v_jeid;
END;
$function$;

REVOKE ALL ON FUNCTION public.post_pos_shift_gl(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_pos_shift_gl(uuid) TO authenticated, service_role;