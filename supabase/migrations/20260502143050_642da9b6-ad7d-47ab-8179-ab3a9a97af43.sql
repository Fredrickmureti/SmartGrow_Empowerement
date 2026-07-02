
-- Pre-req: composite uniqueness for the FK target
ALTER TABLE public.account_detail_type_catalog
  ADD CONSTRAINT account_detail_type_catalog_type_detail_unique
  UNIQUE (account_type, detail_type);

-- 1. Canonical role registry --------------------------------------------------
CREATE TABLE public.system_account_roles (
  role_key              text PRIMARY KEY,
  label                 text NOT NULL,
  description           text NOT NULL,
  required_account_type public.account_type NOT NULL,
  is_mandatory          boolean NOT NULL DEFAULT false,
  category              text NOT NULL,
  sort_order            integer NOT NULL DEFAULT 100,
  created_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.system_account_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read system_account_roles"
  ON public.system_account_roles FOR SELECT TO authenticated USING (true);

-- 2. Eligibility rules (note: account_type uses the enum) ---------------------
CREATE TABLE public.account_role_eligibility (
  role_key      text NOT NULL REFERENCES public.system_account_roles(role_key) ON DELETE CASCADE,
  account_type  public.account_type NOT NULL,
  detail_type   text NOT NULL,
  priority      integer NOT NULL DEFAULT 100,
  PRIMARY KEY (role_key, account_type, detail_type),
  FOREIGN KEY (account_type, detail_type)
    REFERENCES public.account_detail_type_catalog(account_type, detail_type)
);
CREATE INDEX idx_account_role_eligibility_lookup
  ON public.account_role_eligibility (account_type, detail_type);
ALTER TABLE public.account_role_eligibility ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read account_role_eligibility"
  ON public.account_role_eligibility FOR SELECT TO authenticated USING (true);

-- 3. Seed the role registry ---------------------------------------------------
INSERT INTO public.system_account_roles
  (role_key, label, description, required_account_type, is_mandatory, category, sort_order) VALUES
  ('cash',                     'Cash on Hand',           'Default cash register / petty cash account.',                     'asset'::public.account_type,     true,  'core',           10),
  ('bank',                     'Bank Account',           'Primary operating bank account.',                                  'asset'::public.account_type,     true,  'core',           20),
  ('accounts_receivable',      'Accounts Receivable',    'Customer receivables control account used by invoicing.',          'asset'::public.account_type,     true,  'core',           30),
  ('accounts_payable',         'Accounts Payable',       'Vendor payables control account used by bills.',                   'liability'::public.account_type, true,  'core',           40),
  ('inventory',                'Inventory',              'Default inventory asset account for stock movements.',             'asset'::public.account_type,     false, 'inventory',     110),
  ('inventory_adjustment',     'Inventory Adjustment',   'Offset for stock count / write-off adjustments.',                  'expense'::public.account_type,   false, 'inventory',     120),
  ('cogs',                     'Cost of Goods Sold',     'COGS account used when shipping inventory items.',                 'expense'::public.account_type,   false, 'inventory',     130),
  ('sales_revenue',            'Sales Revenue',          'Default income account for product / service sales.',              'income'::public.account_type,    true,  'core',           50),
  ('other_income',             'Other Income',           'Miscellaneous, non-operating income.',                             'income'::public.account_type,    false, 'core',           60),
  ('operating_expenses',       'Operating Expenses',     'Catch-all expense account for uncategorised expenses.',            'expense'::public.account_type,   false, 'core',           70),
  ('input_tax',                'Input VAT (recoverable)','Tax paid on purchases that is recoverable.',                       'asset'::public.account_type,     false, 'tax',           210),
  ('output_tax',               'Output VAT (payable)',   'Tax collected on sales and owed to the tax authority.',            'liability'::public.account_type, false, 'tax',           220),
  ('fixed_asset',              'Fixed Assets',           'Default fixed asset account.',                                     'asset'::public.account_type,     false, 'core',          310),
  ('accumulated_depreciation', 'Accumulated Depreciation','Contra-asset for accumulated depreciation.',                      'asset'::public.account_type,     false, 'core',          320),
  ('depreciation_expense',     'Depreciation Expense',   'P&L offset for depreciation runs.',                                'expense'::public.account_type,   false, 'core',          330),
  ('customer_deposits',        'Customer Deposits',      'Liability for advance payments received from customers.',          'liability'::public.account_type, false, 'core',          410),
  ('retained_earnings',        'Retained Earnings',      'Year-end closing of P&L into equity.',                             'equity'::public.account_type,    true,  'system',        510),
  ('opening_balance_equity',   'Opening Balance Equity', 'Offsetting equity account used when entering opening balances.',   'equity'::public.account_type,    true,  'system',        520),
  ('suspense',                 'Suspense Account',       'Temporary holding account for unmatched / unclassified postings.', 'asset'::public.account_type,     true,  'system',        530),
  ('credit_card_clearing',     'Credit Card Clearing',   'Clearing account for card payments awaiting settlement.',          'asset'::public.account_type,     false, 'payment_method',610),
  ('mobile_money',             'Mobile Money',           'Default mobile-money wallet account.',                             'asset'::public.account_type,     false, 'payment_method',620),
  ('mpesa',                    'M-Pesa',                 'M-Pesa till / paybill clearing account.',                          'asset'::public.account_type,     false, 'payment_method',630);

-- 4. Seed eligibility (filtered to existing catalog rows only) ----------------
WITH candidates(role_key, account_type, detail_type, priority) AS (VALUES
  ('cash',  'asset', 'cash_on_hand', 10),
  ('cash',  'asset', 'petty_cash',   20),
  ('cash',  'asset', 'undeposited_funds', 30),
  ('bank',  'asset', 'checking',      10),
  ('bank',  'asset', 'savings',       20),
  ('bank',  'asset', 'money_market',  30),
  ('bank',  'asset', 'bank',          40),
  ('accounts_receivable', 'asset', 'accounts_receivable', 10),
  ('accounts_payable',    'liability', 'accounts_payable', 10),
  ('inventory', 'asset', 'inventory', 10),
  ('inventory_adjustment', 'expense', 'inventory_shrinkage', 10),
  ('inventory_adjustment', 'expense', 'supplies_materials',  20),
  ('inventory_adjustment', 'expense', 'other_expense',       30),
  ('cogs', 'expense', 'cogs', 10),
  ('cogs', 'expense', 'cost_of_labor_cogs', 20),
  ('cogs', 'expense', 'supplies_materials_cogs', 30),
  ('cogs', 'expense', 'shipping_freight_cogs', 40),
  ('sales_revenue', 'income', 'sales_of_product_income', 10),
  ('sales_revenue', 'income', 'service_fee_income',      20),
  ('sales_revenue', 'income', 'sales',                   30),
  ('other_income', 'income', 'other_miscellaneous_income', 10),
  ('other_income', 'income', 'interest_earned',            20),
  ('other_income', 'income', 'dividend_income',            30),
  ('operating_expenses', 'expense', 'other_expense', 10),
  ('operating_expenses', 'expense', 'office_general_administrative_expenses', 20),
  ('operating_expenses', 'expense', 'supplies_materials', 30),
  ('input_tax', 'asset', 'prepaid_expenses', 30),
  ('input_tax', 'asset', 'other_current_assets', 40),
  ('output_tax', 'liability', 'sales_tax_payable', 10),
  ('output_tax', 'liability', 'other_current_liabilities', 30),
  ('fixed_asset', 'asset', 'machinery_equipment',   10),
  ('fixed_asset', 'asset', 'furniture_fixtures',    20),
  ('fixed_asset', 'asset', 'vehicles',              30),
  ('fixed_asset', 'asset', 'buildings',             40),
  ('fixed_asset', 'asset', 'land',                  50),
  ('fixed_asset', 'asset', 'leasehold_improvements',60),
  ('accumulated_depreciation', 'asset', 'accumulated_depreciation', 10),
  ('depreciation_expense', 'expense', 'depreciation', 10),
  ('customer_deposits', 'liability', 'customer_deposits', 10),
  ('customer_deposits', 'liability', 'other_current_liabilities', 30),
  ('retained_earnings', 'equity', 'retained_earnings', 10),
  ('opening_balance_equity', 'equity', 'opening_balance_equity', 10),
  ('suspense', 'asset', 'suspense', 10),
  ('credit_card_clearing', 'asset', 'undeposited_funds', 20),
  ('credit_card_clearing', 'asset', 'other_current_assets', 30),
  ('mobile_money', 'asset', 'cash_on_hand', 20),
  ('mobile_money', 'asset', 'undeposited_funds', 30),
  ('mobile_money', 'asset', 'other_current_assets', 40),
  ('mpesa', 'asset', 'cash_on_hand', 20),
  ('mpesa', 'asset', 'undeposited_funds', 30),
  ('mpesa', 'asset', 'other_current_assets', 40)
)
INSERT INTO public.account_role_eligibility (role_key, account_type, detail_type, priority)
SELECT c.role_key, c.account_type::public.account_type, c.detail_type, c.priority
FROM candidates c
JOIN public.account_detail_type_catalog cat
  ON cat.account_type = c.account_type::public.account_type
 AND cat.detail_type  = c.detail_type;

-- 5. Validation trigger on default_account_settings ---------------------------
CREATE OR REPLACE FUNCTION public.validate_default_account_setting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role           public.system_account_roles%ROWTYPE;
  v_account_type   public.account_type;
  v_detail_type    text;
  v_eligible       boolean;
BEGIN
  SELECT * INTO v_role FROM public.system_account_roles WHERE role_key = NEW.setting_key;
  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT account_type, detail_type INTO v_account_type, v_detail_type
  FROM public.accounts WHERE id = NEW.account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'default_account_settings: account % not found', NEW.account_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_account_type <> v_role.required_account_type THEN
    RAISE EXCEPTION
      'Cannot map role "%": account % has type "%", but role requires "%".',
      NEW.setting_key, NEW.account_id, v_account_type, v_role.required_account_type
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_detail_type IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.account_role_eligibility
      WHERE role_key = NEW.setting_key
        AND account_type = v_account_type
        AND detail_type  = v_detail_type
    ) INTO v_eligible;

    IF NOT v_eligible THEN
      RAISE EXCEPTION
        'Cannot map role "%": account % detail_type "%" is not eligible for this role.',
        NEW.setting_key, NEW.account_id, v_detail_type
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_default_account_setting ON public.default_account_settings;
CREATE TRIGGER trg_validate_default_account_setting
  BEFORE INSERT OR UPDATE OF setting_key, account_id ON public.default_account_settings
  FOR EACH ROW EXECUTE FUNCTION public.validate_default_account_setting();
