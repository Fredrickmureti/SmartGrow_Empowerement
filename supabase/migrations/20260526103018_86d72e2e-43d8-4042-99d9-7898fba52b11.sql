
WITH candidates AS (
  SELECT a.id,
    CASE
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'mobile money|m-?pesa|airtel money|wallet|mobile wallet' THEN 'mobile_money'
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'money market' THEN 'money_market'
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'savings' THEN 'savings'
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'petty cash|cash on hand|cash in hand|^cash$|cash drawer|till' THEN 'cash_on_hand'
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'bank|checking|current account' THEN 'checking'
      WHEN a.account_type = 'asset' AND (lower(a.name) ~ 'receivable|debtor' OR a.code LIKE '12%') THEN 'accounts_receivable'
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'inventory|stock' THEN 'inventory'
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'input tax|tax input|gst receivable|prepaid tax' THEN 'tax_input'
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'fixed asset|equipment|machinery|vehicle|building|land' THEN 'fixed_asset_other'
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'accumulated depreciation' THEN 'accumulated_depreciation'
      WHEN a.account_type = 'liability' AND lower(a.name) ~ 'credit card|visa|mastercard|amex' THEN 'credit_card'
      WHEN a.account_type = 'liability' AND lower(a.name) ~ 'loan|mortgage|note payable' THEN 'notes_payable'
      WHEN a.account_type = 'liability' AND lower(a.name) ~ 'line of credit|overdraft' THEN 'line_of_credit'
      WHEN a.account_type = 'liability'
           AND lower(a.name) ~ 'payable|creditor'
           AND lower(a.name) !~ 'tax|vat|salary|salaries|payroll|pension|nssf|shif|nhif|ahl|nita|paye|statutory|withheld|withholding|net salary'
           AND COALESCE(a.code, '') NOT IN ('2140','2150','2160','2170')
        THEN 'accounts_payable'
      WHEN a.account_type = 'liability' AND lower(a.name) ~ 'sales tax|vat payable|output tax' THEN 'sales_tax_payable'
      WHEN a.account_type = 'liability' AND lower(a.name) ~ 'customer deposit|unearned' THEN 'customer_deposits'
      WHEN a.account_type = 'income' AND lower(a.name) ~ 'service' THEN 'service_income'
      WHEN a.account_type = 'income' AND lower(a.name) ~ 'interest' THEN 'interest_income'
      WHEN a.account_type = 'income' AND lower(a.name) ~ 'rental|rent income' THEN 'rental_income'
      WHEN a.account_type = 'income' AND lower(a.name) ~ 'other income' THEN 'other_income'
      WHEN a.account_type = 'income' THEN 'sales_income'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'cost of goods|cogs' THEN 'cost_of_goods_sold'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'depreciation' THEN 'depreciation'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'rent' THEN 'rent_expense'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'salaries|wages|payroll' THEN 'payroll_expense'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'utilit' THEN 'utilities'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'bank charge|bank fee' THEN 'bank_charges'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'insurance' THEN 'insurance_expense'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'office' THEN 'office_expenses'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'travel' THEN 'travel'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'legal|professional' THEN 'legal_professional_fees'
      WHEN a.account_type = 'expense' THEN 'other_business_expenses'
      WHEN a.account_type = 'equity' AND lower(a.name) ~ 'retained' THEN 'retained_earnings'
      WHEN a.account_type = 'equity' AND lower(a.name) ~ 'opening balance' THEN 'opening_balance_equity'
      ELSE NULL
    END AS resolved
  FROM public.accounts a
  WHERE a.detail_type IS NULL
    AND COALESCE(a.is_header, false) = false
    AND NOT EXISTS (SELECT 1 FROM public.accounts c WHERE c.parent_id = a.id)
),
eligible AS (
  SELECT c.id, c.resolved
  FROM candidates c
  JOIN public.account_detail_type_catalog cat ON cat.detail_type = c.resolved
  JOIN public.accounts a ON a.id = c.id
  WHERE c.resolved IS NOT NULL
    AND cat.account_type::text = a.account_type::text
)
UPDATE public.accounts a
   SET detail_type = e.resolved
  FROM eligible e
 WHERE a.id = e.id;
