-- 1) Catalog role
INSERT INTO public.system_account_roles
  (role_key, label, description, required_account_type, is_mandatory, category, sort_order)
VALUES
  ('cash_short_over',
   'Cash Over/Short',
   'Absorbs POS drawer variances at shift close. Shortages debit; overages credit. Standard "Cash Over/Short" P&L account used by mature POS/ERP systems.',
   'expense'::public.account_type,
   true,
   'core',
   180)
ON CONFLICT (role_key) DO NOTHING;

-- 1b) Role eligibility — declares which detail_types may carry this role.
INSERT INTO public.account_role_eligibility (role_key, account_type, detail_type, priority)
VALUES
  ('cash_short_over', 'expense'::public.account_type, 'other_expense',          1),
  ('cash_short_over', 'expense'::public.account_type, 'other_business_expenses',2),
  ('cash_short_over', 'expense'::public.account_type, 'cost_of_sales_other',    3)
ON CONFLICT DO NOTHING;

-- 2) CoA template
INSERT INTO public.default_chart_of_accounts
  (country_code, account_code, account_name, account_type, parent_code,
   description, is_system, is_country_neutral, detail_type, role_key)
VALUES
  ('KE', '6910', 'Cash Over/Short', 'expense'::public.account_type, '6000',
   'Net cash drawer variances from POS shift closes. Shortages debit; overages credit.',
   true, true, 'other_expense', 'cash_short_over')
ON CONFLICT (country_code, account_code) DO UPDATE
  SET role_key     = EXCLUDED.role_key,
      account_name = EXCLUDED.account_name,
      description  = EXCLUDED.description;

-- 3) Provisioning helper
CREATE OR REPLACE FUNCTION public.ensure_cash_short_over_account(
  p_org_id      uuid,
  p_business_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_account_id uuid;
BEGIN
  IF p_org_id IS NULL OR p_business_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT account_id INTO v_account_id
  FROM public.default_account_settings
  WHERE organization_id = p_org_id
    AND setting_key     = 'cash_short_over'
    AND (business_id = p_business_id OR business_id IS NULL)
  ORDER BY business_id NULLS LAST
  LIMIT 1;
  IF v_account_id IS NOT NULL THEN
    RETURN v_account_id;
  END IF;

  v_account_id := public.upsert_system_account(
    p_org_id, p_business_id,
    'cash_short_over',
    'expense',
    'other_expense',
    '6910',
    'Cash Over/Short',
    'Auto-provisioned: absorbs POS shift cash drawer variances at close.',
    NULL,
    false
  );

  IF v_account_id IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.default_account_settings
    (organization_id, business_id, branch_id, setting_key, account_id)
  VALUES
    (p_org_id, p_business_id, NULL, 'cash_short_over', v_account_id)
  ON CONFLICT (organization_id, business_id, branch_id, setting_key) DO NOTHING;

  BEGIN
    INSERT INTO public.default_account_mapping_audit
      (organization_id, business_id, role_key, previous_account_id, new_account_id,
       action, confidence, reason, performed_by)
    VALUES
      (p_org_id, p_business_id, 'cash_short_over', NULL, v_account_id,
       'auto_provisioned', 'system',
       'auto_provisioned_for_pos_variance: required by post_pos_shift_gl when cash_difference <> 0',
       auth.uid());
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN v_account_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.ensure_cash_short_over_account(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_cash_short_over_account(uuid, uuid) TO authenticated, service_role;

-- 4) Patched post_pos_shift_gl
CREATE OR REPLACE FUNCTION public.post_pos_shift_gl(_shift_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_shift            RECORD;
  v_existing         uuid;
  v_org_id           uuid;
  v_business_id      uuid;
  v_branch_id        uuid;
  v_actor            uuid;
  v_revenue_account  uuid;
  v_cogs_account     uuid;
  v_inventory_account uuid;
  v_cash_short_over_account uuid;
  v_total_sales      numeric := 0;
  v_total_tax        numeric := 0;
  v_total_net        numeric := 0;
  v_total_cogs       numeric := 0;
  v_shift_date       date;
  v_reference        text;
  v_entry_number     text;
  v_lines            jsonb := '[]'::jsonb;
  v_jeid             uuid;
  v_pay              RECORD;
  v_tax              RECORD;
  v_pay_account      uuid;
  v_tax_account      uuid;
  v_variance         numeric := 0;
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

  SELECT COALESCE(SUM(total),0), COALESCE(SUM(tax_amount),0), COALESCE(SUM(subtotal),0)
    INTO v_total_sales, v_total_tax, v_total_net
  FROM public.pos_transactions
  WHERE shift_id = _shift_id AND transaction_type='sale' AND status='completed';

  IF v_total_sales = 0 THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM(ti.cost_price * ti.quantity), 0)
    INTO v_total_cogs
  FROM public.pos_transaction_items ti
  JOIN public.pos_transactions t ON t.id = ti.transaction_id
  WHERE t.shift_id = _shift_id
    AND t.transaction_type = 'sale'
    AND t.status = 'completed';

  v_revenue_account  := public.get_default_account_id(v_org_id, v_business_id, 'pos_revenue');
  IF v_revenue_account IS NULL THEN v_revenue_account := public.get_default_account_id(v_org_id, v_business_id, 'sales_revenue'); END IF;

  v_cogs_account     := public.get_default_account_id(v_org_id, v_business_id, 'pos_cogs');
  IF v_cogs_account IS NULL THEN v_cogs_account := public.get_default_account_id(v_org_id, v_business_id, 'cogs'); END IF;

  v_inventory_account := public.get_default_account_id(v_org_id, v_business_id, 'pos_inventory');
  IF v_inventory_account IS NULL THEN v_inventory_account := public.get_default_account_id(v_org_id, v_business_id, 'inventory'); END IF;

  v_cash_short_over_account := public.get_default_account_id(v_org_id, v_business_id, 'cash_short_over');

  IF v_revenue_account IS NULL THEN
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

  v_variance := COALESCE(v_shift.cash_difference, 0);
  IF v_variance <> 0 THEN
    IF v_cash_short_over_account IS NULL THEN
      v_cash_short_over_account := public.ensure_cash_short_over_account(v_org_id, v_business_id);
    END IF;
    IF v_cash_short_over_account IS NULL THEN
      RAISE EXCEPTION 'POS shift has cash variance % but no cash_short_over account could be provisioned for business %. Check Settings → Account Mapping.',
        v_variance, v_business_id;
    END IF;
    IF v_variance > 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_cash_short_over_account,
        'debit',  0,
        'credit', v_variance,
        'description', 'Cash overage — shift ' || COALESCE(v_shift.shift_number, _shift_id::text),
        'branch_id', v_branch_id
      ));
    ELSE
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_cash_short_over_account,
        'debit',  abs(v_variance),
        'credit', 0,
        'description', 'Cash shortage — shift ' || COALESCE(v_shift.shift_number, _shift_id::text),
        'branch_id', v_branch_id
      ));
    END IF;
  END IF;

  IF v_total_cogs > 0 AND v_cogs_account IS NOT NULL AND v_inventory_account IS NOT NULL THEN
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

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', v_revenue_account,
    'debit',  0,
    'credit', v_total_net,
    'description', 'POS revenue — shift ' || COALESCE(v_shift.shift_number, _shift_id::text),
    'branch_id', v_branch_id
  ));

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

-- 5) Backfill every bootstrapped tenant
DO $backfill$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT s.organization_id, s.business_id
    FROM public.default_account_settings s
    WHERE NOT EXISTS (
      SELECT 1 FROM public.default_account_settings s2
      WHERE s2.organization_id = s.organization_id
        AND s2.business_id     = s.business_id
        AND s2.setting_key     = 'cash_short_over'
    )
  LOOP
    PERFORM public.ensure_cash_short_over_account(r.organization_id, r.business_id);
  END LOOP;
END
$backfill$;