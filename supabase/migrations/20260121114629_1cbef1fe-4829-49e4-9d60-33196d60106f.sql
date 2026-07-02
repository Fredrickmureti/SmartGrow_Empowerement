-- Phase 3: Onboarding Excellence
-- 3.1 Organization settings for wizard tracking
-- 3.2 Default chart of accounts templates
-- 3.3 Sample data support

-- Add setup wizard tracking to organizations
ALTER TABLE public.organizations 
ADD COLUMN IF NOT EXISTS setup_wizard_completed BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS setup_wizard_step INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS industry VARCHAR(100),
ADD COLUMN IF NOT EXISTS business_type VARCHAR(100);

-- Create default chart of accounts templates table
CREATE TABLE IF NOT EXISTS public.default_chart_of_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code VARCHAR(3) NOT NULL,
  account_code VARCHAR(20) NOT NULL,
  account_name VARCHAR(255) NOT NULL,
  account_type public.account_type NOT NULL,
  parent_code VARCHAR(20),
  description TEXT,
  is_system BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(country_code, account_code)
);

-- Insert Kenya (KE) default chart of accounts
INSERT INTO public.default_chart_of_accounts (country_code, account_code, account_name, account_type, parent_code, description) VALUES
-- Assets
('KE', '1000', 'Assets', 'asset', NULL, 'All asset accounts'),
('KE', '1100', 'Current Assets', 'asset', '1000', 'Short-term assets'),
('KE', '1110', 'Cash and Cash Equivalents', 'asset', '1100', 'Cash on hand and in banks'),
('KE', '1111', 'Petty Cash', 'asset', '1110', 'Petty cash fund'),
('KE', '1112', 'Bank - Main Account', 'asset', '1110', 'Primary bank account'),
('KE', '1120', 'Accounts Receivable', 'asset', '1100', 'Customer receivables'),
('KE', '1130', 'Inventory', 'asset', '1100', 'Stock and merchandise'),
('KE', '1140', 'Prepaid Expenses', 'asset', '1100', 'Expenses paid in advance'),
('KE', '1150', 'VAT Receivable', 'asset', '1100', 'Input VAT to be claimed'),
('KE', '1200', 'Non-Current Assets', 'asset', '1000', 'Long-term assets'),
('KE', '1210', 'Property, Plant & Equipment', 'asset', '1200', 'Fixed assets'),
('KE', '1211', 'Land and Buildings', 'asset', '1210', 'Real property'),
('KE', '1212', 'Motor Vehicles', 'asset', '1210', 'Company vehicles'),
('KE', '1213', 'Furniture & Fixtures', 'asset', '1210', 'Office furniture'),
('KE', '1214', 'Computer Equipment', 'asset', '1210', 'IT hardware'),
('KE', '1220', 'Accumulated Depreciation', 'asset', '1200', 'Contra asset account'),

-- Liabilities
('KE', '2000', 'Liabilities', 'liability', NULL, 'All liability accounts'),
('KE', '2100', 'Current Liabilities', 'liability', '2000', 'Short-term obligations'),
('KE', '2110', 'Accounts Payable', 'liability', '2100', 'Supplier payables'),
('KE', '2120', 'Accrued Expenses', 'liability', '2100', 'Expenses incurred not yet paid'),
('KE', '2130', 'VAT Payable', 'liability', '2100', 'Output VAT to be remitted'),
('KE', '2140', 'PAYE Payable', 'liability', '2100', 'Employee tax withholdings'),
('KE', '2150', 'NSSF Payable', 'liability', '2100', 'Social security contributions'),
('KE', '2160', 'NHIF Payable', 'liability', '2100', 'Health insurance contributions'),
('KE', '2170', 'Housing Levy Payable', 'liability', '2100', 'Housing fund contributions'),
('KE', '2180', 'Withholding Tax Payable', 'liability', '2100', 'WHT on payments'),
('KE', '2200', 'Non-Current Liabilities', 'liability', '2000', 'Long-term obligations'),
('KE', '2210', 'Bank Loans', 'liability', '2200', 'Term loans from banks'),
('KE', '2220', 'Directors Loans', 'liability', '2200', 'Loans from directors'),

-- Equity
('KE', '3000', 'Equity', 'equity', NULL, 'Owners equity'),
('KE', '3100', 'Share Capital', 'equity', '3000', 'Issued share capital'),
('KE', '3200', 'Retained Earnings', 'equity', '3000', 'Accumulated profits'),
('KE', '3300', 'Current Year Earnings', 'equity', '3000', 'Profit/loss for the year'),
('KE', '3400', 'Dividends', 'equity', '3000', 'Dividends declared'),

-- Income (Revenue)
('KE', '4000', 'Revenue', 'income', NULL, 'All income accounts'),
('KE', '4100', 'Sales Revenue', 'income', '4000', 'Product and service sales'),
('KE', '4110', 'Product Sales', 'income', '4100', 'Sale of goods'),
('KE', '4120', 'Service Revenue', 'income', '4100', 'Service income'),
('KE', '4200', 'Other Income', 'income', '4000', 'Non-operating income'),
('KE', '4210', 'Interest Income', 'income', '4200', 'Bank interest earned'),
('KE', '4220', 'Rental Income', 'income', '4200', 'Property rental income'),
('KE', '4230', 'Foreign Exchange Gains', 'income', '4200', 'Forex gains'),

-- Expenses
('KE', '5000', 'Cost of Sales', 'expense', NULL, 'Direct costs'),
('KE', '5100', 'Cost of Goods Sold', 'expense', '5000', 'COGS'),
('KE', '5200', 'Direct Labor', 'expense', '5000', 'Direct labor costs'),
('KE', '5300', 'Freight & Shipping', 'expense', '5000', 'Delivery costs'),

('KE', '6000', 'Operating Expenses', 'expense', NULL, 'Indirect costs'),
('KE', '6100', 'Salaries & Wages', 'expense', '6000', 'Employee compensation'),
('KE', '6110', 'Staff Salaries', 'expense', '6100', 'Basic salaries'),
('KE', '6120', 'Staff Benefits', 'expense', '6100', 'Medical, pension etc'),
('KE', '6130', 'NSSF Employer Contribution', 'expense', '6100', 'Employer NSSF'),
('KE', '6140', 'NHIF Employer Contribution', 'expense', '6100', 'Employer NHIF'),
('KE', '6200', 'Rent & Utilities', 'expense', '6000', 'Office costs'),
('KE', '6210', 'Office Rent', 'expense', '6200', 'Rental payments'),
('KE', '6220', 'Electricity', 'expense', '6200', 'Power bills'),
('KE', '6230', 'Water', 'expense', '6200', 'Water bills'),
('KE', '6240', 'Internet & Telephone', 'expense', '6200', 'Communications'),
('KE', '6300', 'Professional Fees', 'expense', '6000', 'External services'),
('KE', '6310', 'Accounting & Audit Fees', 'expense', '6300', 'Accountant fees'),
('KE', '6320', 'Legal Fees', 'expense', '6300', 'Lawyer fees'),
('KE', '6330', 'Consultancy Fees', 'expense', '6300', 'Consulting'),
('KE', '6400', 'Marketing & Advertising', 'expense', '6000', 'Promotional costs'),
('KE', '6500', 'Transport & Travel', 'expense', '6000', 'Travel expenses'),
('KE', '6510', 'Fuel & Oil', 'expense', '6500', 'Vehicle fuel'),
('KE', '6520', 'Vehicle Repairs', 'expense', '6500', 'Maintenance'),
('KE', '6530', 'Staff Travel', 'expense', '6500', 'Business trips'),
('KE', '6600', 'Office Expenses', 'expense', '6000', 'General office'),
('KE', '6610', 'Stationery', 'expense', '6600', 'Office supplies'),
('KE', '6620', 'Printing & Photocopying', 'expense', '6600', 'Print costs'),
('KE', '6700', 'Depreciation', 'expense', '6000', 'Asset depreciation'),
('KE', '6800', 'Bank Charges', 'expense', '6000', 'Banking fees'),
('KE', '6900', 'Insurance', 'expense', '6000', 'Business insurance'),

-- Other Expenses
('KE', '7000', 'Other Expenses', 'expense', NULL, 'Non-operating expenses'),
('KE', '7100', 'Interest Expense', 'expense', '7000', 'Loan interest'),
('KE', '7200', 'Foreign Exchange Losses', 'expense', '7000', 'Forex losses'),
('KE', '7300', 'Bad Debts', 'expense', '7000', 'Uncollectible receivables')
ON CONFLICT (country_code, account_code) DO NOTHING;

-- Insert Generic/International chart of accounts (DEFAULT)
INSERT INTO public.default_chart_of_accounts (country_code, account_code, account_name, account_type, parent_code, description) VALUES
-- Assets
('INT', '1000', 'Assets', 'asset', NULL, 'All asset accounts'),
('INT', '1100', 'Current Assets', 'asset', '1000', 'Short-term assets'),
('INT', '1110', 'Cash and Cash Equivalents', 'asset', '1100', 'Cash on hand and in banks'),
('INT', '1120', 'Accounts Receivable', 'asset', '1100', 'Customer receivables'),
('INT', '1130', 'Inventory', 'asset', '1100', 'Stock and merchandise'),
('INT', '1140', 'Prepaid Expenses', 'asset', '1100', 'Expenses paid in advance'),
('INT', '1200', 'Non-Current Assets', 'asset', '1000', 'Long-term assets'),
('INT', '1210', 'Property, Plant & Equipment', 'asset', '1200', 'Fixed assets'),
('INT', '1220', 'Accumulated Depreciation', 'asset', '1200', 'Contra asset account'),

-- Liabilities
('INT', '2000', 'Liabilities', 'liability', NULL, 'All liability accounts'),
('INT', '2100', 'Current Liabilities', 'liability', '2000', 'Short-term obligations'),
('INT', '2110', 'Accounts Payable', 'liability', '2100', 'Supplier payables'),
('INT', '2120', 'Accrued Expenses', 'liability', '2100', 'Expenses incurred not yet paid'),
('INT', '2130', 'Tax Payable', 'liability', '2100', 'Taxes due'),
('INT', '2200', 'Non-Current Liabilities', 'liability', '2000', 'Long-term obligations'),
('INT', '2210', 'Bank Loans', 'liability', '2200', 'Term loans from banks'),

-- Equity
('INT', '3000', 'Equity', 'equity', NULL, 'Owners equity'),
('INT', '3100', 'Share Capital', 'equity', '3000', 'Issued share capital'),
('INT', '3200', 'Retained Earnings', 'equity', '3000', 'Accumulated profits'),

-- Income
('INT', '4000', 'Revenue', 'income', NULL, 'All income accounts'),
('INT', '4100', 'Sales Revenue', 'income', '4000', 'Product and service sales'),
('INT', '4200', 'Other Income', 'income', '4000', 'Non-operating income'),

-- Expenses
('INT', '5000', 'Cost of Sales', 'expense', NULL, 'Direct costs'),
('INT', '5100', 'Cost of Goods Sold', 'expense', '5000', 'COGS'),
('INT', '6000', 'Operating Expenses', 'expense', NULL, 'Indirect costs'),
('INT', '6100', 'Salaries & Wages', 'expense', '6000', 'Employee compensation'),
('INT', '6200', 'Rent & Utilities', 'expense', '6000', 'Facility costs'),
('INT', '6300', 'Professional Fees', 'expense', '6000', 'External services'),
('INT', '6400', 'Marketing & Advertising', 'expense', '6000', 'Promotional costs'),
('INT', '6500', 'Depreciation', 'expense', '6000', 'Asset depreciation'),
('INT', '6600', 'Bank Charges', 'expense', '6000', 'Banking fees'),
('INT', '6700', 'Insurance', 'expense', '6000', 'Business insurance'),
('INT', '7000', 'Other Expenses', 'expense', NULL, 'Non-operating expenses'),
('INT', '7100', 'Interest Expense', 'expense', '7000', 'Loan interest')
ON CONFLICT (country_code, account_code) DO NOTHING;

-- Create function to provision default chart of accounts for an organization
CREATE OR REPLACE FUNCTION public.provision_default_chart_of_accounts(
  _org_id UUID,
  _business_id UUID,
  _country_code VARCHAR DEFAULT 'INT'
)
RETURNS INTEGER AS $$
DECLARE
  _accounts_created INTEGER := 0;
  _template RECORD;
  _parent_id UUID;
  _code_to_id JSONB := '{}'::JSONB;
BEGIN
  -- Use country-specific template if available, otherwise fall back to INT
  IF NOT EXISTS (SELECT 1 FROM public.default_chart_of_accounts WHERE country_code = _country_code LIMIT 1) THEN
    _country_code := 'INT';
  END IF;
  
  -- First pass: create all accounts without parents
  FOR _template IN 
    SELECT * FROM public.default_chart_of_accounts 
    WHERE country_code = _country_code 
    ORDER BY account_code
  LOOP
    -- Look up parent ID if parent_code exists
    _parent_id := NULL;
    IF _template.parent_code IS NOT NULL THEN
      _parent_id := (_code_to_id->>_template.parent_code)::UUID;
    END IF;
    
    -- Insert the account
    INSERT INTO public.accounts (
      organization_id,
      business_id,
      code,
      name,
      account_type,
      parent_id,
      description,
      is_system,
      is_active
    ) VALUES (
      _org_id,
      _business_id,
      _template.account_code,
      _template.account_name,
      _template.account_type,
      _parent_id,
      _template.description,
      _template.is_system,
      true
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO _parent_id;
    
    -- Store the mapping for child lookups
    IF _parent_id IS NOT NULL THEN
      _code_to_id := _code_to_id || jsonb_build_object(_template.account_code, _parent_id::TEXT);
      _accounts_created := _accounts_created + 1;
    END IF;
  END LOOP;
  
  RETURN _accounts_created;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.provision_default_chart_of_accounts TO authenticated;

-- Enable RLS on default_chart_of_accounts (read-only for all)
ALTER TABLE public.default_chart_of_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read default chart of accounts"
  ON public.default_chart_of_accounts
  FOR SELECT
  USING (true);