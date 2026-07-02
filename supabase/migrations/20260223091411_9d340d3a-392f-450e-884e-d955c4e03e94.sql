
-- ============================================================
-- KENYA LOCALIZATION PACK: Seeded from KRA official data (2025/2026)
-- ============================================================

-- 1. Create the Kenya Localization Pack
INSERT INTO public.localization_packs (id, country_code, name, description, version, is_active, is_published)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'KE',
  'Kenya Fiscal Localization',
  'Complete Kenya localization including KRA VAT rates, withholding taxes, PAYE brackets, IFRS-aligned chart of accounts, and statutory payroll deductions (NSSF, SHIF, Housing Levy). Based on KRA 2025/2026 rates.',
  '1.0.0',
  true,
  true
);

-- ============================================================
-- 2. TAX TEMPLATES — Real KRA rates
-- ============================================================

INSERT INTO public.localization_pack_tax_templates (pack_id, name, rate, description, is_compound, is_inclusive, is_default, sort_order) VALUES
-- VAT rates
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'VAT 16%', 16.00, 'Standard VAT rate per KRA', false, false, true, 1),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'VAT 8%', 8.00, 'Reduced VAT rate on petroleum products', false, false, false, 2),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'VAT 0% (Zero-Rated)', 0.00, 'Zero-rated supplies (exports, basic foodstuffs)', false, false, false, 3),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'VAT Exempt', 0.00, 'VAT exempt supplies (financial services, medical, education)', false, false, false, 4),

-- Withholding Tax (WHT) — Resident rates from PwC/KRA
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'WHT - Management/Professional Fees (Resident)', 5.00, 'Withholding tax on management or professional fees paid to residents', false, false, false, 10),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'WHT - Consultancy Fees (Resident)', 5.00, 'Withholding tax on consultancy fees paid to residents', false, false, false, 11),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'WHT - Training Fees (Resident)', 5.00, 'Withholding tax on training fees paid to residents', false, false, false, 12),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'WHT - Contractual Fees (Resident)', 3.00, 'Withholding tax on contractual fees paid to residents', false, false, false, 13),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'WHT - Royalties (Resident)', 5.00, 'Withholding tax on royalties paid to residents', false, false, false, 14),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'WHT - Dividends (Resident, <12.5% voting)', 5.00, 'WHT on dividends to residents with less than 12.5% voting power', false, false, false, 15),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'WHT - Interest (Resident)', 15.00, 'Withholding tax on interest paid to residents', false, false, false, 16),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'WHT - Rent (Residential, Agent-collected)', 7.50, 'WHT on rental income collected by appointed agents', false, false, false, 17),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'WHT - Digital Content Creators (Resident)', 5.00, 'WHT on payments to digital content creators', false, false, false, 18),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'WHT - Sales Promotion/Marketing (Resident)', 5.00, 'WHT on sales promotion, marketing, and advertising services', false, false, false, 19),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'WHT - Gaming/Betting Winnings', 20.00, 'WHT on winnings from gaming and betting', false, false, false, 20),

-- Non-resident WHT rates
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'WHT - Management/Professional Fees (Non-Resident)', 20.00, 'WHT on management/professional fees paid to non-residents', false, false, false, 30),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'WHT - Dividends (Non-Resident)', 15.00, 'WHT on dividends paid to non-residents', false, false, false, 31),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'WHT - Interest (Non-Resident)', 15.00, 'WHT on interest paid to non-residents', false, false, false, 32),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'WHT - Royalties (Non-Resident)', 20.00, 'WHT on royalties paid to non-residents', false, false, false, 33),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'WHT - Contractual Fees (Non-Resident)', 20.00, 'WHT on contractual fees paid to non-residents', false, false, false, 34),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'WHT - Insurance Premiums (Non-Resident)', 5.00, 'WHT on insurance/reinsurance premiums to non-residents', false, false, false, 35),

-- Excise Duty (common)
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Excise Duty - Financial Transactions', 20.00, 'Excise duty on fees charged for financial transactions (money transfer, etc.)', false, false, false, 40),

-- Corporate Income Tax
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Corporate Income Tax', 30.00, 'Standard corporate income tax rate in Kenya', false, false, false, 50),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Turnover Tax (Resident, below KES 25M)', 3.00, 'Turnover tax for resident persons with turnover not exceeding KES 25 million', false, false, false, 51),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Capital Gains Tax', 15.00, 'Tax on gains from transfer of property in Kenya', false, false, false, 52),

-- Digital Services Tax
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Significant Economic Presence Tax', 30.00, 'Tax on income derived from provision of services through a digital marketplace in Kenya (non-residents)', false, false, false, 53);


-- ============================================================
-- 3. CHART OF ACCOUNTS TEMPLATES — IFRS-aligned for Kenya
-- ============================================================

INSERT INTO public.localization_pack_account_templates (pack_id, code, name, account_type, parent_code, description, is_system, sort_order) VALUES
-- ASSETS (1xxx)
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1000', 'Assets', 'asset', NULL, 'Top-level asset category', true, 1),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1010', 'Cash and Cash Equivalents', 'asset', '1000', 'Cash in hand and at bank', true, 2),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1011', 'Petty Cash - KES', 'asset', '1010', 'Petty cash in Kenya Shillings', false, 3),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1012', 'Cash at Bank - KES', 'asset', '1010', 'Main operating bank account in KES', false, 4),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1013', 'Cash at Bank - USD', 'asset', '1010', 'Foreign currency bank account in USD', false, 5),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1014', 'M-Pesa Float', 'asset', '1010', 'Mobile money float (Safaricom M-Pesa)', false, 6),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1020', 'Accounts Receivable', 'asset', '1000', 'Trade debtors', true, 7),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1021', 'Trade Receivables', 'asset', '1020', 'Amounts due from customers for goods/services', false, 8),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1022', 'Allowance for Doubtful Debts', 'asset', '1020', 'Provision for expected credit losses', false, 9),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1023', 'Staff Debtors', 'asset', '1020', 'Advances and loans to employees', false, 10),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1024', 'WHT Receivable', 'asset', '1020', 'Withholding tax recoverable from KRA', false, 11),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1030', 'Inventory', 'asset', '1000', 'Stock and work in progress', false, 12),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1031', 'Raw Materials', 'asset', '1030', 'Raw materials and components', false, 13),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1032', 'Work in Progress', 'asset', '1030', 'Goods/services partially completed', false, 14),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1033', 'Finished Goods', 'asset', '1030', 'Completed goods available for sale', false, 15),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1040', 'Prepayments and Deposits', 'asset', '1000', 'Advance payments and deposits', false, 16),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1041', 'Prepaid Insurance', 'asset', '1040', 'Insurance paid in advance', false, 17),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1042', 'Prepaid Rent', 'asset', '1040', 'Rent paid in advance', false, 18),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1043', 'VAT Input (Recoverable)', 'asset', '1040', 'VAT on purchases recoverable from KRA', false, 19),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1050', 'Non-Current Assets', 'asset', '1000', 'Long-term assets', true, 20),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1051', 'Property, Plant and Equipment', 'asset', '1050', 'Tangible fixed assets (IAS 16)', false, 21),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1052', 'Accumulated Depreciation - PPE', 'asset', '1050', 'Accumulated depreciation on PPE', false, 22),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1053', 'Motor Vehicles', 'asset', '1050', 'Company vehicles', false, 23),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1054', 'Accumulated Depreciation - Motor Vehicles', 'asset', '1050', 'Accumulated depreciation on vehicles', false, 24),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1055', 'Furniture and Fittings', 'asset', '1050', 'Office furniture and fixtures', false, 25),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1056', 'Computer Equipment', 'asset', '1050', 'IT hardware and equipment', false, 26),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1057', 'Intangible Assets', 'asset', '1050', 'Software, licenses, patents (IAS 38)', false, 27),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1058', 'Right-of-Use Assets', 'asset', '1050', 'Leased assets per IFRS 16', false, 28),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1060', 'Investments', 'asset', '1000', 'Financial investments', false, 29),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1061', 'Government Securities (T-Bills/Bonds)', 'asset', '1060', 'Kenya government treasury bills and bonds', false, 30),

-- LIABILITIES (2xxx)
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2000', 'Liabilities', 'liability', NULL, 'Top-level liability category', true, 40),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2010', 'Accounts Payable', 'liability', '2000', 'Trade creditors', true, 41),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2011', 'Trade Payables', 'liability', '2010', 'Amounts owed to suppliers', false, 42),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2012', 'Accrued Expenses', 'liability', '2010', 'Expenses incurred but not yet paid', false, 43),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2020', 'Tax Liabilities', 'liability', '2000', 'Taxes payable to KRA', true, 44),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2021', 'VAT Output (Payable)', 'liability', '2020', 'VAT collected on sales, payable to KRA', false, 45),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2022', 'PAYE Payable', 'liability', '2020', 'Employee income tax withheld, payable to KRA', false, 46),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2023', 'WHT Payable', 'liability', '2020', 'Withholding tax deducted, payable to KRA', false, 47),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2024', 'Corporate Tax Payable', 'liability', '2020', 'Corporation tax liability', false, 48),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2025', 'Turnover Tax Payable', 'liability', '2020', 'Turnover tax payable (if applicable)', false, 49),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2030', 'Statutory Deductions Payable', 'liability', '2000', 'Employee statutory deductions held', true, 50),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2031', 'NSSF Payable', 'liability', '2030', 'NSSF contributions payable', false, 51),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2032', 'SHIF Payable', 'liability', '2030', 'Social Health Insurance Fund contributions payable (replaced NHIF)', false, 52),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2033', 'Housing Levy Payable', 'liability', '2030', 'Affordable Housing Levy payable', false, 53),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2034', 'NITA Payable', 'liability', '2030', 'National Industrial Training Authority levy payable', false, 54),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2040', 'Short-Term Borrowings', 'liability', '2000', 'Bank overdrafts and short-term loans', false, 55),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2041', 'Bank Overdraft', 'liability', '2040', 'Bank overdraft facility', false, 56),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2050', 'Long-Term Liabilities', 'liability', '2000', 'Non-current liabilities', true, 57),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2051', 'Bank Loans', 'liability', '2050', 'Long-term bank loans', false, 58),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2052', 'Lease Liabilities', 'liability', '2050', 'Lease obligations per IFRS 16', false, 59),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2053', 'Deferred Tax Liability', 'liability', '2050', 'Deferred tax per IAS 12', false, 60),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2060', 'Other Current Liabilities', 'liability', '2000', 'Other short-term obligations', false, 61),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2061', 'Customer Deposits', 'liability', '2060', 'Advance payments received from customers', false, 62),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2062', 'Unearned Revenue', 'liability', '2060', 'Revenue received but not yet earned (IFRS 15)', false, 63),

-- EQUITY (3xxx)
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '3000', 'Equity', 'equity', NULL, 'Owners equity', true, 70),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '3010', 'Share Capital', 'equity', '3000', 'Issued share capital', false, 71),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '3020', 'Share Premium', 'equity', '3000', 'Excess of issue price over par value', false, 72),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '3030', 'Retained Earnings', 'equity', '3000', 'Accumulated profits/losses', true, 73),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '3040', 'Revaluation Reserve', 'equity', '3000', 'Surplus on revaluation of assets (IAS 16)', false, 74),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '3050', 'Foreign Currency Translation Reserve', 'equity', '3000', 'Exchange differences on foreign operations (IAS 21)', false, 75),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '3060', 'Dividends Paid', 'equity', '3000', 'Dividends declared and paid', false, 76),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '3070', 'Owner''s Drawings', 'equity', '3000', 'Withdrawals by owner (sole proprietorship/partnership)', false, 77),

-- REVENUE (4xxx)
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '4000', 'Revenue', 'revenue', NULL, 'Top-level revenue category', true, 80),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '4010', 'Sales Revenue', 'revenue', '4000', 'Revenue from sale of goods (IFRS 15)', false, 81),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '4020', 'Service Revenue', 'revenue', '4000', 'Revenue from rendering of services', false, 82),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '4030', 'Sales Returns and Allowances', 'revenue', '4000', 'Returns, refunds and credit notes', false, 83),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '4040', 'Sales Discounts', 'revenue', '4000', 'Trade and settlement discounts given', false, 84),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '4050', 'Other Operating Income', 'revenue', '4000', 'Miscellaneous operating income', false, 85),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '4060', 'Interest Income', 'revenue', '4000', 'Interest earned on deposits and investments', false, 86),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '4070', 'Foreign Exchange Gains', 'revenue', '4000', 'Gains from foreign currency transactions', false, 87),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '4080', 'Rental Income', 'revenue', '4000', 'Income from rental of property', false, 88),

-- COST OF SALES (5xxx)
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '5000', 'Cost of Sales', 'expense', NULL, 'Direct costs of goods/services sold', true, 90),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '5010', 'Cost of Goods Sold', 'expense', '5000', 'Direct cost of goods sold', false, 91),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '5020', 'Direct Labour', 'expense', '5000', 'Direct labour costs in production', false, 92),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '5030', 'Manufacturing Overheads', 'expense', '5000', 'Factory overhead costs', false, 93),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '5040', 'Freight and Customs Duty', 'expense', '5000', 'Import duties, clearing and forwarding', false, 94),

-- OPERATING EXPENSES (6xxx)
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6000', 'Operating Expenses', 'expense', NULL, 'General and administrative expenses', true, 100),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6010', 'Salaries and Wages', 'expense', '6000', 'Employee basic salaries and wages', false, 101),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6011', 'Employer NSSF Contribution', 'expense', '6000', 'Employer share of NSSF', false, 102),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6012', 'Employer SHIF Contribution', 'expense', '6000', 'Employer share of SHIF (if applicable)', false, 103),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6013', 'Employer Housing Levy', 'expense', '6000', 'Employer share of Affordable Housing Levy (1.5%)', false, 104),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6014', 'NITA Levy', 'expense', '6000', 'National Industrial Training Authority levy (KES 50/employee)', false, 105),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6015', 'Staff Benefits', 'expense', '6000', 'Medical, leave pay, gratuity, etc.', false, 106),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6016', 'Staff Training', 'expense', '6000', 'Employee training and development', false, 107),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6020', 'Rent Expense', 'expense', '6000', 'Office and premises rent', false, 108),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6021', 'Utilities', 'expense', '6000', 'Electricity (KPLC), water, internet', false, 109),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6022', 'Telephone and Internet', 'expense', '6000', 'Safaricom, Airtel and internet services', false, 110),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6030', 'Office Supplies', 'expense', '6000', 'Stationery and office consumables', false, 111),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6031', 'Printing and Postage', 'expense', '6000', 'Printing, courier and postal expenses', false, 112),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6040', 'Travel and Transport', 'expense', '6000', 'Local and international travel', false, 113),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6041', 'Motor Vehicle Expenses', 'expense', '6000', 'Fuel, maintenance, insurance for vehicles', false, 114),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6050', 'Professional Fees', 'expense', '6000', 'Legal, audit, consultancy fees', false, 115),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6051', 'Audit Fees', 'expense', '6050', 'External audit fees', false, 116),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6052', 'Legal Fees', 'expense', '6050', 'Legal and advisory fees', false, 117),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6060', 'Insurance', 'expense', '6000', 'Business insurance premiums', false, 118),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6070', 'Depreciation', 'expense', '6000', 'Depreciation of property, plant and equipment', false, 119),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6071', 'Amortisation', 'expense', '6000', 'Amortisation of intangible assets', false, 120),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6080', 'Marketing and Advertising', 'expense', '6000', 'Advertising, branding, promotions', false, 121),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6090', 'Bank Charges', 'expense', '6000', 'Bank fees, charges and commissions', false, 122),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6091', 'M-Pesa/Mobile Money Charges', 'expense', '6000', 'Mobile money transaction fees', false, 123),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6100', 'Interest Expense', 'expense', '6000', 'Interest on loans and borrowings', false, 124),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6110', 'Foreign Exchange Losses', 'expense', '6000', 'Losses from foreign currency transactions', false, 125),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6120', 'Bad Debts Written Off', 'expense', '6000', 'Irrecoverable debts', false, 126),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6130', 'Repairs and Maintenance', 'expense', '6000', 'Building and equipment maintenance', false, 127),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6140', 'Security Services', 'expense', '6000', 'Security guard services, alarms, CCTV', false, 128),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6150', 'Licenses and Permits', 'expense', '6000', 'Business permits, county licenses, fire certificates', false, 129),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6160', 'Donations and CSR', 'expense', '6000', 'Charitable donations and corporate social responsibility', false, 130),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6170', 'Penalties and Fines', 'expense', '6000', 'KRA penalties, late filing fines, other regulatory fines', false, 131),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '6180', 'Miscellaneous Expenses', 'expense', '6000', 'Other general expenses', false, 132);


-- ============================================================
-- 4. PAYROLL TEMPLATES — KRA 2025/2026 statutory deductions
-- ============================================================

INSERT INTO public.localization_pack_payroll_templates (pack_id, rule_type, rule_name, parameters, sort_order) VALUES

-- PAYE (Pay As You Earn) — Progressive tax brackets 2025/2026
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'income_tax', 'PAYE (Pay As You Earn)', '{
  "type": "progressive",
  "currency": "KES",
  "period": "monthly",
  "brackets": [
    {"min": 0, "max": 24000, "rate": 10},
    {"min": 24001, "max": 32333, "rate": 25},
    {"min": 32334, "max": 500000, "rate": 30},
    {"min": 500001, "max": null, "rate": 35}
  ],
  "personal_relief": 2400,
  "insurance_relief_rate": 15,
  "insurance_relief_max": 5000,
  "disability_exemption": 150000,
  "notes": "Per KRA Tax Laws Amendment Act 2024. Personal relief of KES 2,400/month. Insurance relief at 15% of premiums, max KES 5,000/month."
}'::jsonb, 1),

-- NSSF (National Social Security Fund) — Tier I and II
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'statutory_deduction', 'NSSF (National Social Security Fund)', '{
  "type": "tiered",
  "currency": "KES",
  "period": "monthly",
  "tiers": [
    {"name": "Tier I", "lower_earnings_limit": 0, "upper_earnings_limit": 7000, "employee_rate": 6, "employer_rate": 6},
    {"name": "Tier II", "lower_earnings_limit": 7001, "upper_earnings_limit": 36000, "employee_rate": 6, "employer_rate": 6}
  ],
  "old_rates": {
    "employee": 200,
    "employer": 200,
    "note": "Old rates (KES 200 each) still commonly applied pending full transition to new NSSF Act rates"
  },
  "notes": "New NSSF Act 2013 rates: 6% of pensionable pay per tier. Tier I: up to KES 7,000. Tier II: KES 7,001-36,000. Max employee contribution: KES 2,160/month. Transition period still in effect for some employers."
}'::jsonb, 2),

-- SHIF (Social Health Insurance Fund) — Replaced NHIF
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'statutory_deduction', 'SHIF (Social Health Insurance Fund)', '{
  "type": "percentage",
  "currency": "KES",
  "period": "monthly",
  "rate": 2.75,
  "base": "gross_pay",
  "employee_only": true,
  "notes": "SHIF replaced NHIF effective Oct 2024. Rate is 2.75% of gross pay. No employer contribution. No cap specified."
}'::jsonb, 3),

-- Housing Levy (Affordable Housing Levy)
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'statutory_deduction', 'Affordable Housing Levy (AHL)', '{
  "type": "percentage",
  "currency": "KES",
  "period": "monthly",
  "employee_rate": 1.5,
  "employer_rate": 1.5,
  "base": "gross_pay",
  "notes": "Effective 1 July 2023. Both employee and employer contribute 1.5% of gross salary. Remit by 9th of following month via eCitizen/iTax."
}'::jsonb, 4),

-- NITA (National Industrial Training Authority)
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'employer_contribution', 'NITA (National Industrial Training Authority)', '{
  "type": "fixed",
  "currency": "KES",
  "period": "monthly",
  "amount_per_employee": 50,
  "employer_only": true,
  "notes": "Employer-only levy of KES 50 per employee per month. Payable to NITA by 9th of following month."
}'::jsonb, 5),

-- NHIF Legacy rates (for reference/backward compatibility)
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'statutory_deduction', 'NHIF (Legacy Rates - Reference Only)', '{
  "type": "graduated",
  "currency": "KES",
  "period": "monthly",
  "status": "replaced_by_shif",
  "brackets": [
    {"min": 0, "max": 5999, "amount": 150},
    {"min": 6000, "max": 7999, "amount": 300},
    {"min": 8000, "max": 11999, "amount": 400},
    {"min": 12000, "max": 14999, "amount": 500},
    {"min": 15000, "max": 19999, "amount": 600},
    {"min": 20000, "max": 24999, "amount": 750},
    {"min": 25000, "max": 29999, "amount": 850},
    {"min": 30000, "max": 34999, "amount": 900},
    {"min": 35000, "max": 39999, "amount": 950},
    {"min": 40000, "max": 44999, "amount": 1000},
    {"min": 45000, "max": 49999, "amount": 1100},
    {"min": 50000, "max": 59999, "amount": 1200},
    {"min": 60000, "max": 69999, "amount": 1300},
    {"min": 70000, "max": 79999, "amount": 1400},
    {"min": 80000, "max": 89999, "amount": 1500},
    {"min": 90000, "max": 99999, "amount": 1600},
    {"min": 100000, "max": null, "amount": 1700}
  ],
  "notes": "NHIF was replaced by SHIF in Oct 2024. These rates are kept for historical reference and backward compatibility."
}'::jsonb, 6);
