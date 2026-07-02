
-- ============================================================
-- Migration 1: Detail-type catalog + validation trigger
-- Apply Default Account Mapping — Phase 3 (Classification model)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.account_detail_type_catalog (
  detail_type text PRIMARY KEY,
  account_type public.account_type NOT NULL,
  display_label text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.account_detail_type_catalog ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Detail type catalog is readable by all authenticated users"
  ON public.account_detail_type_catalog;
CREATE POLICY "Detail type catalog is readable by all authenticated users"
  ON public.account_detail_type_catalog FOR SELECT
  TO authenticated USING (true);

INSERT INTO public.account_detail_type_catalog (detail_type, account_type, display_label, description)
VALUES
('cash_and_cash_equivalents', 'asset'::public.account_type, 'Cash and Cash Equivalents', 'Highly liquid assets that are readily convertible to known amounts of cash and subject to insignificant risk of changes in value.'),
('cash_on_hand', 'asset'::public.account_type, 'Cash on Hand', 'Cash your company keeps for occasional expenses, also called petty cash.'),
('checking', 'asset'::public.account_type, 'Checking', 'Checking account activity, including debit card transactions. Each checking account at a bank should have its own account.'),
('accounts_receivable', 'asset'::public.account_type, 'Accounts Receivable (A/R)', 'Money customers owe you for products or services. Most businesses need only one A/R account.'),
('savings', 'asset'::public.account_type, 'Savings', 'Savings and certificate of deposit activity.'),
('money_market', 'asset'::public.account_type, 'Money Market', 'Amounts in money market accounts.'),
('mobile_money', 'asset'::public.account_type, 'Mobile Money', 'Balances in mobile money accounts like M-PESA, Airtel Money, or similar services.'),
('trust_account', 'asset'::public.account_type, 'Trust Account', 'Funds held in trust, such as client trust accounts used by law firms, real estate agents, or escrow agents.'),
('rents_held_in_trust', 'asset'::public.account_type, 'Rents Held in Trust', 'Rental income held in trust on behalf of property owners.'),
('allowance_bad_debts', 'asset'::public.account_type, 'Allowance for Bad Debts', 'Estimated portion of A/R that may not be collected. Accrual basis only.'),
('assets_available_for_sale', 'asset'::public.account_type, 'Assets Available for Sale', 'Assets actively marketed and expected to be sold within the current period.'),
('development_costs', 'asset'::public.account_type, 'Development Costs', 'Amounts deposited or set aside to arrange financing.'),
('employee_advances', 'asset'::public.account_type, 'Employee Cash Advances', 'Wages or non-salary money issued to an employee early.'),
('inventory', 'asset'::public.account_type, 'Inventory', 'Cost of goods purchased for resale.'),
('investment_government', 'asset'::public.account_type, 'Investment - Government Obligations', 'Value of government securities such as treasury bonds or bills.'),
('investment_tax_exempt', 'asset'::public.account_type, 'Investment - Tax-Exempt Securities', 'Value of investments in tax-exempt securities such as municipal bonds.'),
('loans_to_officers', 'asset'::public.account_type, 'Loans to Officers', 'Money loaned to company officers or directors.'),
('loans_to_others', 'asset'::public.account_type, 'Loans to Others', 'Money your business loans to other people or businesses.'),
('loans_to_stockholders', 'asset'::public.account_type, 'Loans to Stockholders', 'Money loaned to company stockholders or shareholders.'),
('prepaid_expenses', 'asset'::public.account_type, 'Prepaid Expenses', 'Payments for expenses not yet recognised, such as prepaid insurance or rent.'),
('retainage', 'asset'::public.account_type, 'Retainage', 'Portion of contract amount held back until project completion.'),
('short_term_investments', 'asset'::public.account_type, 'Short-term Investments', 'Investments expected to be converted to cash within a year.'),
('undeposited_funds', 'asset'::public.account_type, 'Undeposited Funds', 'Cash or cheques from sales not yet deposited.'),
('other_current_asset', 'asset'::public.account_type, 'Other Current Assets', 'Current assets not covered by other types.'),
('accumulated_depreciation', 'asset'::public.account_type, 'Accumulated Depreciation', 'How much you have depreciated tangible (fixed) assets over time.'),
('accumulated_depletion', 'asset'::public.account_type, 'Accumulated Depletion', 'How much a natural resource asset has been depleted.'),
('buildings', 'asset'::public.account_type, 'Buildings', 'Cost of structures owned and used for business.'),
('depletable_assets', 'asset'::public.account_type, 'Depletable Assets', 'Natural resources owned (timber, oil, mineral deposits).'),
('fixed_asset_computers', 'asset'::public.account_type, 'Fixed Asset Computers', 'Computer hardware, servers, and networking equipment.'),
('fixed_asset_copiers', 'asset'::public.account_type, 'Fixed Asset Copiers', 'Copiers, printers, multi-function machines.'),
('fixed_asset_furniture', 'asset'::public.account_type, 'Fixed Asset Furniture', 'Furniture such as desks, chairs, and office furniture.'),
('fixed_asset_phone', 'asset'::public.account_type, 'Fixed Asset Phone', 'Phone systems, handsets, telecommunications equipment.'),
('fixed_asset_photo_video', 'asset'::public.account_type, 'Fixed Asset Photo Video', 'Photography and video equipment.'),
('fixed_asset_software', 'asset'::public.account_type, 'Fixed Asset Software', 'Purchased software or licences capitalised as assets.'),
('fixed_asset_other_tools', 'asset'::public.account_type, 'Fixed Asset Other Tools Equipment', 'Tools, equipment, and other fixed assets.'),
('furniture_fixtures', 'asset'::public.account_type, 'Furniture & Fixtures', 'Furniture and fixtures owned and used.'),
('intangible_assets', 'asset'::public.account_type, 'Intangible Assets', 'Intangible assets to amortise (franchises, customer lists, copyrights, patents).'),
('land', 'asset'::public.account_type, 'Land', 'Cost of land owned. Not depreciated.'),
('leasehold_improvements', 'asset'::public.account_type, 'Leasehold Improvements', 'Improvements to a leased asset that increase its value.'),
('machinery_equipment', 'asset'::public.account_type, 'Machinery & Equipment', 'Computer hardware and other non-furniture fixtures or devices.'),
('other_fixed_asset', 'asset'::public.account_type, 'Other Fixed Assets', 'Tangible assets not covered by other types.'),
('vehicles', 'asset'::public.account_type, 'Vehicles', 'Vehicles owned and used for business.'),
('accumulated_amortization', 'asset'::public.account_type, 'Accumulated Amortisation of Other Assets', 'How much intangible assets have been amortised over time.'),
('assets_held_for_sale', 'asset'::public.account_type, 'Assets Held for Sale', 'Non-current assets to be recovered through sale rather than continuing use.'),
('deferred_tax_asset', 'asset'::public.account_type, 'Deferred Tax', 'Income taxes recoverable in future periods.'),
('goodwill', 'asset'::public.account_type, 'Goodwill', 'Intangible assets of an acquired company.'),
('lease_buyout', 'asset'::public.account_type, 'Lease Buyout', 'Cost of buying out a lease agreement.'),
('licenses', 'asset'::public.account_type, 'Licences', 'Long-term licences and permits.'),
('long_term_investments', 'asset'::public.account_type, 'Long-term Investments', 'Investments not expected to be converted to cash within one year.'),
('organizational_costs', 'asset'::public.account_type, 'Organizational Costs', 'Costs incurred in forming a corporation or partnership.'),
('security_deposits', 'asset'::public.account_type, 'Security Deposits', 'Funds paid to cover potential damage, loss, or theft.'),
('other_non_current_asset', 'asset'::public.account_type, 'Other Long-term Assets', 'Long-term assets not covered by other types.'),
('suspense', 'asset'::public.account_type, 'Suspense Account', 'Temporary holding account for unidentified or unallocated transactions awaiting reclassification.'),
('credit_card', 'liability'::public.account_type, 'Credit Card', 'Balance due on business credit cards.'),
('accounts_payable', 'liability'::public.account_type, 'Accounts Payable (A/P)', 'Amounts owed to suppliers. Most businesses need only one A/P account.'),
('accrued_liabilities', 'liability'::public.account_type, 'Accrued Liabilities', 'Expenses incurred but not yet paid (accrued rent, interest, utilities).'),
('trust_accounts_liability_current', 'liability'::public.account_type, 'Client Trust Accounts - Liabilities', 'Liability side of client trust funds held.'),
('current_portion_long_term_debt', 'liability'::public.account_type, 'Current Portion of Long-term Debt', 'Portion of long-term debt due within twelve months.'),
('current_tax_liability', 'liability'::public.account_type, 'Current Tax Liability', 'Income taxes currently due to be paid.'),
('deferred_revenue', 'liability'::public.account_type, 'Deferred Revenue', 'Money received before goods or services are delivered.'),
('dividends_payable', 'liability'::public.account_type, 'Dividends Payable', 'Dividends declared but not yet paid to shareholders.'),
('escrow_liabilities', 'liability'::public.account_type, 'Escrow Liabilities', 'Funds held on behalf of others (escrow accounts).'),
('estimated_taxes', 'liability'::public.account_type, 'Estimated Taxes', 'Estimated income taxes accrued but not yet paid.'),
('federal_income_tax_payable', 'liability'::public.account_type, 'Federal Income Tax Payable', 'Federal income tax owed.'),
('insurance_payable', 'liability'::public.account_type, 'Insurance Payable', 'Unpaid insurance premiums.'),
('line_of_credit', 'liability'::public.account_type, 'Line of Credit', 'Balance owed on a business line of credit.'),
('loan_payable', 'liability'::public.account_type, 'Loan Payable', 'Money owed on a loan.'),
('payroll_clearing', 'liability'::public.account_type, 'Payroll Clearing', 'Temporary clearing account used in payroll processing.'),
('payroll_tax_payable', 'liability'::public.account_type, 'Payroll Tax Payable', 'Payroll taxes withheld and owed to tax authorities.'),
('prepaid_expense_payable', 'liability'::public.account_type, 'Prepaid Expense Payable', 'Payable side of prepaid arrangements.'),
('rents_in_trust_liability', 'liability'::public.account_type, 'Rents in Trust - Liability', 'Liability side of rents held in trust.'),
('sales_tax_payable', 'liability'::public.account_type, 'Sales Tax Payable / VAT Payable', 'Sales tax or VAT collected and owed to tax authorities.'),
('state_local_income_tax_payable', 'liability'::public.account_type, 'State/Local Income Tax Payable', 'State or local income tax owed.'),
('unearned_revenue', 'liability'::public.account_type, 'Unearned Revenue', 'Customer payments received before delivery of goods or services.'),
('customer_deposits', 'liability'::public.account_type, 'Customer Deposits', 'Customer prepayments and credit obligations.'),
('other_current_liabilities', 'liability'::public.account_type, 'Other Current Liabilities', 'Current liabilities not covered by other types.'),
('notes_payable', 'liability'::public.account_type, 'Notes Payable', 'Long-term promissory notes owed.'),
('long_term_loan_payable', 'liability'::public.account_type, 'Long-term Loan Payable', 'Long-term loan obligations.'),
('shareholder_notes_payable', 'liability'::public.account_type, 'Shareholder Notes Payable', 'Notes payable to shareholders.'),
('mortgage_payable', 'liability'::public.account_type, 'Mortgage Payable', 'Mortgage debt on property.'),
('deferred_tax_liability', 'liability'::public.account_type, 'Deferred Tax Liability', 'Income taxes payable in future periods.'),
('other_long_term_liabilities', 'liability'::public.account_type, 'Other Long-term Liabilities', 'Long-term liabilities not covered by other types.'),
('opening_balance_equity', 'equity'::public.account_type, 'Opening Balance Equity', 'Used to balance accounts during initial setup or migration.'),
('retained_earnings', 'equity'::public.account_type, 'Retained Earnings', 'Cumulative profits not distributed as dividends.'),
('owners_equity', 'equity'::public.account_type, 'Owner''s Equity', 'Owner''s investment in the business.'),
('partners_equity', 'equity'::public.account_type, 'Partner''s Equity', 'Partner''s investment in the partnership.'),
('common_stock', 'equity'::public.account_type, 'Common Stock', 'Par value of common stock issued.'),
('preferred_stock', 'equity'::public.account_type, 'Preferred Stock', 'Par value of preferred stock issued.'),
('paid_in_capital', 'equity'::public.account_type, 'Paid-in Capital or Surplus', 'Capital contributed beyond par value of stock.'),
('treasury_stock', 'equity'::public.account_type, 'Treasury Stock', 'Company''s own stock that has been repurchased.'),
('owner_distributions', 'equity'::public.account_type, 'Owner''s Distributions / Drawings', 'Withdrawals by owner from the business.'),
('partner_distributions', 'equity'::public.account_type, 'Partner Distributions', 'Distributions to partners.'),
('estimated_taxes_equity', 'equity'::public.account_type, 'Estimated Taxes - Equity', 'Equity-side estimated tax tracking.'),
('healthcare', 'equity'::public.account_type, 'Healthcare', 'Equity-side healthcare contributions.'),
('personal_income', 'equity'::public.account_type, 'Personal Income', 'Personal income tracked through equity.'),
('personal_expense', 'equity'::public.account_type, 'Personal Expense', 'Personal expenses tracked through equity.'),
('accumulated_other_comprehensive_income', 'equity'::public.account_type, 'Accumulated Other Comprehensive Income', 'Cumulative items recognised in other comprehensive income.'),
('other_equity', 'equity'::public.account_type, 'Other Equity', 'Equity items not covered by other types.'),
('sales_income', 'income'::public.account_type, 'Sales of Product Income', 'Revenue from sales of physical products.'),
('service_income', 'income'::public.account_type, 'Service / Fee Income', 'Revenue from services rendered.'),
('non_profit_income', 'income'::public.account_type, 'Non-Profit Income', 'Revenue from non-profit activities, donations, grants.'),
('discounts_refunds_given', 'income'::public.account_type, 'Discounts / Refunds Given', 'Contra-revenue for discounts given and refunds issued to customers.'),
('unapplied_cash_payment_income', 'income'::public.account_type, 'Unapplied Cash Payment Income', 'Customer payments received but not yet applied to invoices.'),
('cash_receipt_income', 'income'::public.account_type, 'Cash Receipt Income', 'Income from immediate cash sales not tied to specific invoices.'),
('other_primary_income', 'income'::public.account_type, 'Other Primary Income', 'Primary business income not covered by other categories.'),
('rental_income', 'income'::public.account_type, 'Rental Income', 'Income from renting out property or equipment.'),
('dividend_income', 'income'::public.account_type, 'Dividend Income', 'Dividend payments received from investments.'),
('interest_income', 'income'::public.account_type, 'Interest Income', 'Interest earned on bank balances, loans receivable, or investments.'),
('gain_on_asset_sales', 'income'::public.account_type, 'Gain on Sale of Assets', 'Gains from selling business assets above book value.'),
('gain_on_investments', 'income'::public.account_type, 'Gain on Investments', 'Gains from investments — appreciation, dividends classified as gains.'),
('insurance_proceeds', 'income'::public.account_type, 'Insurance Proceeds', 'Proceeds from insurance settlements.'),
('legal_settlement_income', 'income'::public.account_type, 'Legal Settlement Income', 'Income from legal settlements.'),
('royalty_income', 'income'::public.account_type, 'Royalty Income', 'Royalty payments received.'),
('other_investment_income', 'income'::public.account_type, 'Other Investment Income', 'Investment income not covered by other types.'),
('other_misc_income', 'income'::public.account_type, 'Other Miscellaneous Income', 'Miscellaneous income not covered elsewhere.'),
('other_income', 'income'::public.account_type, 'Other Income', 'Non-operating or miscellaneous income.'),
('cost_of_goods_sold', 'expense'::public.account_type, 'Cost of Goods Sold', 'Direct costs of producing or purchasing goods sold.'),
('cost_of_labor_cos', 'expense'::public.account_type, 'Cost of Labor - COS', 'Direct labour costs tied to production or cost of sales.'),
('cost_of_sales_equipment_rental', 'expense'::public.account_type, 'Equipment Rental - COS', 'Equipment rental costs directly tied to cost of sales.'),
('cost_of_sales_other', 'expense'::public.account_type, 'Other Cost of Sales', 'Other direct cost of sales not covered by other types.'),
('cost_of_sales_shipping_freight', 'expense'::public.account_type, 'Shipping, Freight & Delivery - COS', 'Shipping and freight directly attributable to cost of sales.'),
('cost_of_sales_supplies_materials', 'expense'::public.account_type, 'Supplies & Materials - COS', 'Supplies and materials consumed in production.'),
('other_cos', 'expense'::public.account_type, 'Other Cost of Sales (Adjustments)', 'Adjustments and write-offs to cost of sales (e.g. inventory shrinkage).'),
('advertising', 'expense'::public.account_type, 'Advertising', 'Costs of advertising and marketing — print, online, broadcast.'),
('auto_expenses', 'expense'::public.account_type, 'Vehicle Expenses', 'Vehicle running costs — fuel, repairs, maintenance, insurance.'),
('bad_debt_expense', 'expense'::public.account_type, 'Bad Debt Expense', 'Receivables written off as uncollectible.'),
('bank_charges', 'expense'::public.account_type, 'Bank Charges', 'Bank fees, wire fees, monthly service charges.'),
('charitable_contributions', 'expense'::public.account_type, 'Charitable Contributions', 'Donations made to qualifying charitable organisations.'),
('communication_expense', 'expense'::public.account_type, 'Communication', 'Communication-related costs not covered elsewhere.'),
('cost_of_labour_expense', 'expense'::public.account_type, 'Cost of Labour', 'Operating labour costs not directly tied to production.'),
('dues_subscriptions', 'expense'::public.account_type, 'Dues & Subscriptions', 'Professional dues, memberships, subscriptions.'),
('entertainment', 'expense'::public.account_type, 'Entertainment', 'Entertainment expenses for clients or employees.'),
('entertainment_meals', 'expense'::public.account_type, 'Entertainment Meals', 'Meals provided for entertainment purposes.'),
('equipment_rental', 'expense'::public.account_type, 'Equipment Rental', 'Equipment rental costs not tied to production.'),
('finance_costs', 'expense'::public.account_type, 'Finance Costs', 'Loan origination fees, commitment fees, financing charges.'),
('income_tax_expense', 'expense'::public.account_type, 'Income Tax Expense', 'Total income tax expense recognised in the income statement.'),
('insurance_expense', 'expense'::public.account_type, 'Insurance', 'Insurance payments — liability, property, professional indemnity, health.'),
('interest_paid', 'expense'::public.account_type, 'Interest Paid', 'Interest paid on debt — mortgage, finance charges, loan interest.'),
('loss_discontinued_operations', 'expense'::public.account_type, 'Loss on Discontinued Operations, Net of Tax', 'Losses from discontinued business segments.'),
('management_compensation', 'expense'::public.account_type, 'Management Compensation', 'Compensation paid to directors, executives, and key management.'),
('legal_professional_fees', 'expense'::public.account_type, 'Legal & Professional Fees', 'Fees for accountants, lawyers, consultants, auditors.'),
('office_expenses', 'expense'::public.account_type, 'Office / General Administrative Expenses', 'General office or administrative expenses.'),
('other_business_expenses', 'expense'::public.account_type, 'Other Business Expenses', 'Business expenses not covered by other categories.'),
('other_selling_expense', 'expense'::public.account_type, 'Other Selling Expense', 'Selling expenses not covered by other categories.'),
('other_misc_service_cost', 'expense'::public.account_type, 'Other Miscellaneous Service Cost', 'Service-related expenses not covered elsewhere.'),
('payroll_expense', 'expense'::public.account_type, 'Payroll Expenses', 'Employee compensation — salaries, wages, bonuses, employer taxes, benefits.'),
('payroll_tax_expense', 'expense'::public.account_type, 'Payroll Tax Expenses', 'Employer-paid payroll taxes (FICA, FUTA, SUTA equivalents).'),
('payroll_wage_expense', 'expense'::public.account_type, 'Payroll Wage Expenses', 'Gross wages and salaries paid to employees.'),
('promotional_meals', 'expense'::public.account_type, 'Promotional Meals', 'Meals provided for promotional purposes.'),
('rent_expense', 'expense'::public.account_type, 'Rent or Lease of Buildings', 'Rent payments for office, warehouse, retail, or other premises.'),
('repair_maintenance', 'expense'::public.account_type, 'Repair & Maintenance', 'Repairs and periodic maintenance — equipment, building, vehicle, IT.'),
('security_expenses', 'expense'::public.account_type, 'Security Expenses', 'Security personnel, alarm systems, CCTV.'),
('shipping_delivery', 'expense'::public.account_type, 'Shipping, Freight & Delivery', 'Shipping expenses not classified as cost of sales.'),
('supplies', 'expense'::public.account_type, 'Supplies & Materials', 'Materials consumed in day-to-day operations.'),
('taxes_paid', 'expense'::public.account_type, 'Taxes Paid', 'Property taxes, excise taxes, business licences.'),
('telephone_internet', 'expense'::public.account_type, 'Telephone & Internet', 'Phone lines, mobile, internet service.'),
('travel', 'expense'::public.account_type, 'Travel Expenses - General and Admin', 'Flights, accommodation, ground transport.'),
('travel_meals', 'expense'::public.account_type, 'Travel Meals', 'Meals while travelling for business.'),
('travel_selling', 'expense'::public.account_type, 'Travel Expenses - Selling Expense', 'Sales-team travel for client visits and trade shows.'),
('meals_entertainment', 'expense'::public.account_type, 'Meals & Entertainment', 'Dining for morale or business entertainment.'),
('unapplied_cash_bill_payment', 'expense'::public.account_type, 'Unapplied Cash Bill Payment Expense', 'Bill payments not yet matched to a specific vendor bill.'),
('utilities', 'expense'::public.account_type, 'Utilities', 'Electricity, water, gas, waste disposal.'),
('depreciation', 'expense'::public.account_type, 'Depreciation', 'Depreciation of tangible assets.'),
('amortization', 'expense'::public.account_type, 'Amortisation', 'Amortisation of intangible assets.'),
('exchange_gain_loss', 'expense'::public.account_type, 'Exchange Gain or Loss', 'Gains or losses from foreign exchange rate fluctuations.'),
('penalties', 'expense'::public.account_type, 'Penalties & Settlements', 'Fines, penalties, lawsuit settlements.'),
('loss_on_asset_sales', 'expense'::public.account_type, 'Loss on Sale of Assets', 'Losses from selling business assets below book value.'),
('other_expense', 'expense'::public.account_type, 'Other Miscellaneous Expense', 'Unusual or infrequent expenses not covered elsewhere.')
ON CONFLICT (detail_type) DO UPDATE
  SET account_type = EXCLUDED.account_type,
      display_label = EXCLUDED.display_label,
      description = EXCLUDED.description;

CREATE OR REPLACE FUNCTION public.validate_account_detail_type()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  expected public.account_type;
BEGIN
  IF NEW.detail_type IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT account_type INTO expected
  FROM public.account_detail_type_catalog
  WHERE detail_type = NEW.detail_type;

  IF expected IS NULL THEN
    RAISE EXCEPTION 'Unknown account detail_type: %. Must exist in account_detail_type_catalog.', NEW.detail_type
      USING ERRCODE = '22023';
  END IF;

  IF expected <> NEW.account_type THEN
    RAISE EXCEPTION 'detail_type % is reserved for account_type %, but account % has account_type %',
      NEW.detail_type, expected, COALESCE(NEW.code, '?'), NEW.account_type
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS trg_validate_account_detail_type ON public.accounts;
CREATE TRIGGER trg_validate_account_detail_type
  BEFORE INSERT OR UPDATE OF detail_type, account_type ON public.accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_account_detail_type();
