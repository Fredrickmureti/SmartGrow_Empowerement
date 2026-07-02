
-- =====================================================================
-- 1. system_account_template — curated suggestion per role
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.system_account_template (
  role_key            text PRIMARY KEY REFERENCES public.system_account_roles(role_key) ON DELETE CASCADE,
  suggested_code      text NOT NULL,
  suggested_name      text NOT NULL,
  account_type        public.account_type NOT NULL,
  detail_type         text NOT NULL,
  parent_code_hint    text,
  description         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT system_account_template_detail_fk
    FOREIGN KEY (account_type, detail_type)
    REFERENCES public.account_detail_type_catalog(account_type, detail_type)
);

ALTER TABLE public.system_account_template ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "system_account_template readable by authenticated"
  ON public.system_account_template;
CREATE POLICY "system_account_template readable by authenticated"
  ON public.system_account_template FOR SELECT TO authenticated USING (true);

-- Seed: one row per role. Detail-types and parent codes match what
-- already exists in account_detail_type_catalog and the standard COA seed.
INSERT INTO public.system_account_template
  (role_key, suggested_code, suggested_name, account_type, detail_type, parent_code_hint, description) VALUES
  ('cash',                     '1015', 'Cash on Hand',                'asset',     'cash_on_hand',              '1110', 'Petty cash / till float'),
  ('bank',                     '1020', 'Primary Bank Account',        'asset',     'checking',                  '1110', 'Default operating bank account'),
  ('accounts_receivable',      '1100', 'Accounts Receivable',         'asset',     'accounts_receivable',       '1100', 'Customer receivables control'),
  ('accounts_payable',         '2010', 'Accounts Payable',            'liability', 'accounts_payable',          '2100', 'Vendor payables control'),
  ('inventory',                '1200', 'Inventory',                   'asset',     'inventory',                 '1100', 'Stock on hand'),
  ('inventory_adjustment',     '5910', 'Inventory Adjustments',       'expense',   'other_business_expenses',   '7000', 'Stock count / write-offs'),
  ('cogs',                     '5010', 'Cost of Goods Sold',          'expense',   'cost_of_goods_sold',        '5000', 'COGS for shipped inventory'),
  ('sales_revenue',            '4010', 'Sales Revenue',               'income',    'sales_income',              '4100', 'Default product sales income'),
  ('service_revenue',          '4210', 'Service Revenue',             'income',    'service_income',            '4100', 'Income from services rendered'),
  ('sales_returns',            '4910', 'Sales Returns & Refunds',     'income',    'discounts_refunds_given',   '4200', 'Contra-revenue for refunds'),
  ('other_income',             '4920', 'Other Income',                'income',    'other_misc_income',         '4200', 'Misc / non-operating income'),
  ('discount_given',           '6910', 'Discounts Given',             'expense',   'other_business_expenses',   '7000', 'Discounts to customers'),
  ('discount_received',        '4930', 'Discounts Received',          'income',    'other_misc_income',         '4200', 'Discounts from suppliers'),
  ('purchase_returns',         '5920', 'Purchase Returns',            'expense',   'other_business_expenses',   '7000', 'Returns to suppliers'),
  ('bank_fees',                '6410', 'Bank Fees & Charges',         'expense',   'bank_charges',              '7000', 'Bank service / wire fees'),
  ('operating_expenses',       '6010', 'Operating Expenses',          'expense',   'other_business_expenses',   '6000', 'Catch-all operating expenses'),
  ('input_tax',                '1310', 'Input VAT Receivable',        'asset',     'other_current_asset',       '1100', 'Recoverable purchase tax'),
  ('output_tax',               '2110', 'Output VAT Payable',          'liability', 'sales_tax_payable',         '2100', 'VAT collected on sales'),
  ('fixed_asset',              '1510', 'Furniture & Fixtures',        'asset',     'furniture_fixtures',        '1210', 'Default fixed asset bucket'),
  ('accumulated_depreciation', '1590', 'Accumulated Depreciation',    'asset',     'accumulated_depreciation',  '1210', 'Contra-asset for depreciation'),
  ('depreciation_expense',     '6510', 'Depreciation Expense',        'expense',   'depreciation',              '6000', 'P&L depreciation charge'),
  ('customer_deposits',        '2210', 'Customer Deposits',           'liability', 'customer_deposits',         '2200', 'Advance payments from customers'),
  ('retained_earnings',        '3100', 'Retained Earnings',           'equity',    'retained_earnings',         '3000', 'Year-end P&L close'),
  ('opening_balance_equity',   '3000', 'Opening Balance Equity',      'equity',    'opening_balance_equity',    '3000', 'Opening balances offset'),
  ('suspense',                 '1390', 'Suspense Account',            'asset',     'suspense',                  '1100', 'Unmatched / unclassified postings'),
  ('credit_card_clearing',     '1320', 'Credit Card Clearing',        'asset',     'undeposited_funds',         '1100', 'Card payments awaiting settlement'),
  ('mobile_money',             '1030', 'Mobile Money Wallet',         'asset',     'cash_on_hand',              '1110', 'Generic mobile money wallet'),
  ('mpesa',                    '1040', 'M-Pesa Till / Paybill',       'asset',     'cash_on_hand',              '1110', 'M-Pesa clearing account'),
  ('clearing_pos',             '1330', 'POS Clearing',                'asset',     'undeposited_funds',         '1100', 'POS session close holding'),
  ('clearing_undeposited_funds','1340', 'Undeposited Funds',          'asset',     'undeposited_funds',         '1100', 'Cash/cheques pending deposit'),
  ('fx_realized_gain',         '4940', 'FX Realized Gain',            'income',    'other_misc_income',         '4200', 'Foreign-exchange gain on settlement'),
  ('fx_realized_loss',         '6920', 'FX Realized Loss',            'expense',   'exchange_gain_loss',        '7000', 'Foreign-exchange loss on settlement'),
  ('rounding_gain',            '4950', 'Rounding Gain',               'income',    'other_misc_income',         '4200', 'Cash rounding gain'),
  ('rounding_loss',            '6930', 'Rounding Loss',               'expense',   'other_expense',             '7000', 'Cash rounding loss')
ON CONFLICT (role_key) DO UPDATE SET
  suggested_code   = EXCLUDED.suggested_code,
  suggested_name   = EXCLUDED.suggested_name,
  account_type     = EXCLUDED.account_type,
  detail_type      = EXCLUDED.detail_type,
  parent_code_hint = EXCLUDED.parent_code_hint,
  description      = EXCLUDED.description;

-- CI guard: every role must have a template.
DO $$
DECLARE missing text;
BEGIN
  SELECT r.role_key INTO missing
  FROM public.system_account_roles r
  WHERE NOT EXISTS (SELECT 1 FROM public.system_account_template t WHERE t.role_key = r.role_key)
  LIMIT 1;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'system_account_template missing entry for role "%"', missing;
  END IF;
END $$;

-- =====================================================================
-- 2. provision_system_account — idempotent, safe leaf-account creator
-- =====================================================================
CREATE OR REPLACE FUNCTION public.provision_system_account(
  _role_key text,
  _organization_id uuid,
  _business_id uuid
)
RETURNS public.accounts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_role_role text;
  v_template public.system_account_template%ROWTYPE;
  v_existing public.accounts%ROWTYPE;
  v_parent_id uuid;
  v_code text;
  v_suffix int := 0;
  v_inserted public.accounts%ROWTYPE;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;
  IF _organization_id IS NULL OR _business_id IS NULL THEN
    RAISE EXCEPTION 'organization_id and business_id are required' USING ERRCODE = '22023';
  END IF;

  -- Permission: org admin / owner / super_admin / accountant
  SELECT role INTO v_role_role
  FROM public.user_roles
  WHERE user_id = v_caller
    AND organization_id = _organization_id
    AND coalesce(is_active, true) = true
  LIMIT 1;
  IF v_role_role IS NULL OR v_role_role NOT IN ('super_admin','owner','admin','accountant') THEN
    RAISE EXCEPTION 'forbidden: % cannot provision system accounts', coalesce(v_role_role,'<none>')
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_template FROM public.system_account_template WHERE role_key = _role_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no template registered for role "%"', _role_key USING ERRCODE = '22023';
  END IF;

  -- Idempotent: if a postable leaf already satisfies (account_type, detail_type)
  -- in this scope, return it unchanged.
  SELECT * INTO v_existing
  FROM public.accounts
  WHERE organization_id = _organization_id
    AND (business_id = _business_id OR business_id IS NULL)
    AND coalesce(is_header, false) = false
    AND coalesce(is_active, true)  = true
    AND account_type = v_template.account_type
    AND detail_type  = v_template.detail_type
  ORDER BY (business_id IS NULL), code
  LIMIT 1;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  -- Resolve parent header (best-effort): same org, header=true, prefer same code hint.
  SELECT id INTO v_parent_id
  FROM public.accounts
  WHERE organization_id = _organization_id
    AND coalesce(is_header, false) = true
    AND account_type = v_template.account_type
    AND code = v_template.parent_code_hint
    AND (business_id = _business_id OR business_id IS NULL)
  ORDER BY (business_id IS NULL)
  LIMIT 1;

  IF v_parent_id IS NULL THEN
    SELECT id INTO v_parent_id
    FROM public.accounts
    WHERE organization_id = _organization_id
      AND coalesce(is_header, false) = true
      AND account_type = v_template.account_type
      AND (business_id = _business_id OR business_id IS NULL)
    ORDER BY (business_id IS NULL), code
    LIMIT 1;
  END IF;

  -- Pick a non-colliding code: suggested_code, then suggested_code-1, -2, …
  v_code := v_template.suggested_code;
  WHILE EXISTS (
    SELECT 1 FROM public.accounts
    WHERE business_id = _business_id AND code = v_code
  ) LOOP
    v_suffix := v_suffix + 1;
    v_code := v_template.suggested_code || '-' || v_suffix::text;
    IF v_suffix > 50 THEN
      RAISE EXCEPTION 'cannot allocate non-colliding code for role "%"', _role_key
        USING ERRCODE = '23505';
    END IF;
  END LOOP;

  INSERT INTO public.accounts (
    organization_id, business_id, account_type, code, name,
    description, parent_id, is_system, is_active, is_header, detail_type
  ) VALUES (
    _organization_id, _business_id, v_template.account_type, v_code, v_template.suggested_name,
    v_template.description, v_parent_id, true, true, false, v_template.detail_type
  )
  RETURNING * INTO v_inserted;

  RETURN v_inserted;
END
$$;

GRANT EXECUTE ON FUNCTION public.provision_system_account(text, uuid, uuid) TO authenticated;

-- =====================================================================
-- 3. Bulk healer — one-shot upgrade for every existing org × business
-- =====================================================================
CREATE OR REPLACE FUNCTION public.provision_missing_system_accounts(
  _organization_id uuid,
  _business_id uuid,
  _mandatory_only boolean DEFAULT false
)
RETURNS TABLE (role_key text, account_id uuid, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_acct public.accounts%ROWTYPE;
  v_eligible boolean;
BEGIN
  FOR r IN
    SELECT sr.role_key, sr.is_mandatory
    FROM public.system_account_roles sr
    JOIN public.system_account_template st USING (role_key)
    WHERE (NOT _mandatory_only) OR sr.is_mandatory
  LOOP
    -- Skip if at least one eligible postable leaf already exists.
    SELECT EXISTS (
      SELECT 1 FROM public.accounts a
      JOIN public.account_role_eligibility e
        ON e.role_key = r.role_key
       AND e.account_type = a.account_type
       AND e.detail_type  = a.detail_type
      WHERE a.organization_id = _organization_id
        AND (a.business_id = _business_id OR a.business_id IS NULL)
        AND coalesce(a.is_header,false) = false
        AND coalesce(a.is_active,true)  = true
    ) INTO v_eligible;

    IF v_eligible THEN
      role_key := r.role_key; account_id := NULL; status := 'already_eligible';
      RETURN NEXT;
      CONTINUE;
    END IF;

    BEGIN
      v_acct := public.provision_system_account(r.role_key, _organization_id, _business_id);
      role_key := r.role_key; account_id := v_acct.id; status := 'provisioned';
      RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      role_key := r.role_key; account_id := NULL; status := 'error: ' || SQLERRM;
      RETURN NEXT;
    END;
  END LOOP;
END
$$;

GRANT EXECUTE ON FUNCTION public.provision_missing_system_accounts(uuid, uuid, boolean) TO authenticated;

-- =====================================================================
-- 4. One-shot heal: fill gaps for every existing org × business right now.
--    Uses a service-role-style execution (SECURITY DEFINER) but bypasses
--    the auth.uid() check by inlining the provisioning logic inside this
--    DO block (we trust the migration runner).
-- =====================================================================
DO $$
DECLARE
  bus record;
  r   record;
  tmpl public.system_account_template%ROWTYPE;
  parent_id uuid;
  picked_code text;
  suffix int;
  exists_eligible boolean;
BEGIN
  FOR bus IN
    SELECT b.id AS business_id, b.organization_id
    FROM public.businesses b
    WHERE coalesce(b.is_active, true) = true
  LOOP
    FOR r IN
      SELECT sr.role_key
      FROM public.system_account_roles sr
      JOIN public.system_account_template st USING (role_key)
    LOOP
      SELECT EXISTS (
        SELECT 1 FROM public.accounts a
        JOIN public.account_role_eligibility e
          ON e.role_key = r.role_key
         AND e.account_type = a.account_type
         AND e.detail_type  = a.detail_type
        WHERE a.organization_id = bus.organization_id
          AND (a.business_id = bus.business_id OR a.business_id IS NULL)
          AND coalesce(a.is_header,false) = false
          AND coalesce(a.is_active,true)  = true
      ) INTO exists_eligible;
      IF exists_eligible THEN CONTINUE; END IF;

      SELECT * INTO tmpl FROM public.system_account_template WHERE role_key = r.role_key;

      -- parent
      SELECT id INTO parent_id FROM public.accounts
      WHERE organization_id = bus.organization_id
        AND coalesce(is_header,false) = true
        AND account_type = tmpl.account_type
        AND code = tmpl.parent_code_hint
        AND (business_id = bus.business_id OR business_id IS NULL)
      ORDER BY (business_id IS NULL) LIMIT 1;
      IF parent_id IS NULL THEN
        SELECT id INTO parent_id FROM public.accounts
        WHERE organization_id = bus.organization_id
          AND coalesce(is_header,false) = true
          AND account_type = tmpl.account_type
          AND (business_id = bus.business_id OR business_id IS NULL)
        ORDER BY (business_id IS NULL), code LIMIT 1;
      END IF;

      -- code uniqueness
      picked_code := tmpl.suggested_code;
      suffix := 0;
      WHILE EXISTS (
        SELECT 1 FROM public.accounts
        WHERE business_id = bus.business_id AND code = picked_code
      ) LOOP
        suffix := suffix + 1;
        picked_code := tmpl.suggested_code || '-' || suffix::text;
        EXIT WHEN suffix > 50;
      END LOOP;

      BEGIN
        INSERT INTO public.accounts (
          organization_id, business_id, account_type, code, name,
          description, parent_id, is_system, is_active, is_header, detail_type
        ) VALUES (
          bus.organization_id, bus.business_id, tmpl.account_type,
          picked_code, tmpl.suggested_name, tmpl.description,
          parent_id, true, true, false, tmpl.detail_type
        );
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'heal: could not provision % for business %: %',
          r.role_key, bus.business_id, SQLERRM;
      END;
    END LOOP;
  END LOOP;
END $$;
