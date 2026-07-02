/**
 * Account Detail Types — QuickBooks-style
 * 
 * Complete Account Type → Detail Type mapping based on QuickBooks Online taxonomy.
 * When a user selects an Account Type, the Detail Type dropdown auto-populates
 * with the relevant options and auto-selects the first (most common) one.
 * Each detail type includes a rich description explaining when to use it.
 */

export interface DetailTypeOption {
  value: string;
  label: string;
  /** Full QuickBooks-style definition explaining when/how to use this detail type */
  description: string;
  /** Suggested default account names when this detail type is selected */
  suggestedNames: string[];
}

export const ACCOUNT_DETAIL_TYPES: Record<string, DetailTypeOption[]> = {
  asset: [
    // --- Cash and Bank (safe defaults first — NOT A/R) ---
    {
      value: "cash_and_cash_equivalents",
      label: "Cash and Cash Equivalents",
      description: "Use Cash and Cash Equivalents for highly liquid assets that are readily convertible to known amounts of cash and subject to insignificant risk of changes in value.",
      suggestedNames: ["Cash and Cash Equivalents"],
    },
    {
      value: "cash_on_hand",
      label: "Cash on Hand",
      description: "Use Cash on Hand to track cash your company keeps for occasional expenses, also called petty cash. To track cash from sales not yet deposited, use Undeposited Funds instead.",
      suggestedNames: ["Cash on Hand", "Petty Cash"],
    },
    {
      value: "checking",
      label: "Checking",
      description: "Use Checking accounts to track all your checking account activity, including debit card transactions. Each checking account at a bank should have its own account in the system.",
      suggestedNames: ["Bank Account - Current", "Checking Account", "Main Bank Account", "Bank"],
    },
    // --- Accounts Receivable (moved after cash/bank) ---
    {
      value: "accounts_receivable",
      label: "Accounts Receivable (A/R)",
      description: "Use Accounts Receivable to track money that customers owe you for products or services, and payments customers make. Most businesses need only one.",
      suggestedNames: ["Accounts Receivable", "Trade Receivables"],
    },
    {
      value: "savings",
      label: "Savings",
      description: "Use Savings accounts to track your savings and certificate of deposit activity. Each savings account at a bank should have its own account. For investments, see Other Current Assets.",
      suggestedNames: ["Savings Account", "Fixed Deposit"],
    },
    {
      value: "money_market",
      label: "Money Market",
      description: "Use Money Market to track amounts in money market accounts. For investments, see Other Current Assets instead.",
      suggestedNames: ["Money Market Account"],
    },
    {
      value: "mobile_money",
      label: "Mobile Money",
      description: "Use Mobile Money to track balances in mobile money accounts like M-PESA, Airtel Money, or similar services.",
      suggestedNames: ["M-PESA Business", "Mobile Money Account"],
    },
    {
      value: "trust_account",
      label: "Trust Account",
      description: "Use Trust Account to track funds held in trust, such as client trust accounts used by law firms, real estate agents, or escrow agents.",
      suggestedNames: ["Client Trust Account", "Trust Account", "Escrow Account"],
    },
    {
      value: "rents_held_in_trust",
      label: "Rents Held in Trust",
      description: "Use Rents Held in Trust to track rental income held in trust on behalf of property owners if you manage properties for others.",
      suggestedNames: ["Rents Held in Trust"],
    },
    // --- Current Assets ---
    {
      value: "allowance_bad_debts",
      label: "Allowance for Bad Debts",
      description: "Use Allowance for Bad Debts to estimate the part of your Accounts Receivable that you think you might not collect. Only use this on the accrual basis.",
      suggestedNames: ["Allowance for Doubtful Accounts", "Provision for Bad Debts"],
    },
    {
      value: "assets_available_for_sale",
      label: "Assets Available for Sale",
      description: "Use Assets Available for Sale to track assets that are actively marketed and expected to be sold within the current period.",
      suggestedNames: ["Assets Available for Sale"],
    },
    {
      value: "development_costs",
      label: "Development Costs",
      description: "Use Development Costs to track amounts you deposit or set aside to arrange for financing, such as SBA or other loan fees.",
      suggestedNames: ["Development Costs", "Loan Fees"],
    },
    {
      value: "employee_advances",
      label: "Employee Cash Advances",
      description: "Use Employee Cash Advances to track wages and salary you issue to an employee early, or other non-salary money given to employees. For loans to employees, use Loans to Others.",
      suggestedNames: ["Employee Advances", "Staff Advances"],
    },
    {
      value: "inventory",
      label: "Inventory",
      description: "Use Inventory to track the cost of goods your business purchases for resale. When goods are sold, assign the sale to a Cost of Sales account.",
      suggestedNames: ["Inventory", "Stock", "Merchandise Inventory"],
    },
    {
      value: "investment_government",
      label: "Investment - Government Obligations",
      description: "Use Investment - Government Obligations to track the value of government securities such as treasury bonds or bills.",
      suggestedNames: ["Government Securities", "Treasury Bonds"],
    },
    {
      value: "investment_tax_exempt",
      label: "Investment - Tax-Exempt Securities",
      description: "Use Investment - Tax-Exempt Securities to track the value of investments in tax-exempt securities such as municipal bonds.",
      suggestedNames: ["Tax-Exempt Securities", "Municipal Bonds"],
    },
    {
      value: "loans_to_officers",
      label: "Loans to Officers",
      description: "Use Loans to Officers to track money loaned to company officers, directors, or other individuals with a fiduciary relationship to the company.",
      suggestedNames: ["Loans to Officers", "Director Loans"],
    },
    {
      value: "loans_to_others",
      label: "Loans to Others",
      description: "Use Loans to Others to track money your business loans to other people or businesses. This is different from Employee Advances.",
      suggestedNames: ["Loans to Others", "Staff Loans"],
    },
    {
      value: "loans_to_stockholders",
      label: "Loans to Stockholders",
      description: "Use Loans to Stockholders to track money loaned to company stockholders or shareholders.",
      suggestedNames: ["Loans to Stockholders", "Shareholder Loans Receivable"],
    },
    {
      value: "prepaid_expenses",
      label: "Prepaid Expenses",
      description: "Use Prepaid Expenses to track payments for expenses you won't recognise until a future accounting period. When you recognise the expense, make a journal entry to transfer money to the expense account.",
      suggestedNames: ["Prepaid Expenses", "Prepaid Insurance", "Prepaid Rent"],
    },
    {
      value: "retainage",
      label: "Retainage",
      description: "Use Retainage if your customers regularly hold back a portion of a contract amount until you have completed a project.",
      suggestedNames: ["Retainage", "Retention Receivable"],
    },
    {
      value: "short_term_investments",
      label: "Short-term Investments",
      description: "Use Short-term Investments to track the value of investments expected to be converted to cash within a year. Examples include publicly-traded shares or treasury bills.",
      suggestedNames: ["Short-term Investments", "Treasury Bills", "Money Market Investments"],
    },
    {
      value: "undeposited_funds",
      label: "Undeposited Funds",
      description: "Use Undeposited Funds for cash or cheques from sales that haven't been deposited yet. For petty cash, use Cash on Hand instead.",
      suggestedNames: ["Undeposited Funds"],
    },
    {
      value: "other_current_asset",
      label: "Other Current Assets",
      description: "Use Other Current Assets for current assets not covered by the other types. Current assets are likely to be converted to cash or used up within a year.",
      suggestedNames: ["Other Current Asset"],
    },
    // --- Fixed / Tangible Assets ---
    {
      value: "accumulated_depreciation",
      label: "Accumulated Depreciation",
      description: "Use Accumulated Depreciation to track how much you have depreciated your tangible (fixed) assets over time.",
      suggestedNames: ["Accumulated Depreciation - Equipment", "Accumulated Depreciation - Vehicles", "Accumulated Depreciation - Furniture", "Accumulated Depreciation - Buildings"],
    },
    {
      value: "accumulated_depletion",
      label: "Accumulated Depletion",
      description: "Use Accumulated Depletion to track how much you've depleted a natural resource asset. It reduces the depletable asset's value on the balance sheet.",
      suggestedNames: ["Accumulated Depletion"],
    },
    {
      value: "buildings",
      label: "Buildings",
      description: "Use Buildings to track the cost of structures you own and use for your business. Use a separate Land account for the land portion of any real property.",
      suggestedNames: ["Buildings", "Office Building"],
    },
    {
      value: "depletable_assets",
      label: "Depletable Assets",
      description: "Use Depletable Assets to track natural resources your business owns, such as timber, oil, or mineral deposits, which are reduced as they are extracted.",
      suggestedNames: ["Depletable Assets", "Natural Resources"],
    },
    {
      value: "fixed_asset_computers",
      label: "Fixed Asset Computers",
      description: "Use Fixed Asset Computers to track computer hardware, servers, and networking equipment owned by the business.",
      suggestedNames: ["Computers", "Computer Equipment"],
    },
    {
      value: "fixed_asset_copiers",
      label: "Fixed Asset Copiers",
      description: "Use Fixed Asset Copiers to track copiers, printers, and multi-function machines owned by the business.",
      suggestedNames: ["Copiers", "Printers"],
    },
    {
      value: "fixed_asset_furniture",
      label: "Fixed Asset Furniture",
      description: "Use Fixed Asset Furniture to track furniture such as desks, chairs, and office furniture owned by the business.",
      suggestedNames: ["Furniture", "Office Furniture"],
    },
    {
      value: "fixed_asset_phone",
      label: "Fixed Asset Phone",
      description: "Use Fixed Asset Phone to track phone systems, handsets, and telecommunications equipment owned by the business.",
      suggestedNames: ["Phone Systems", "Telecommunications Equipment"],
    },
    {
      value: "fixed_asset_photo_video",
      label: "Fixed Asset Photo Video",
      description: "Use Fixed Asset Photo Video to track photography and video equipment owned by the business.",
      suggestedNames: ["Photo Equipment", "Video Equipment"],
    },
    {
      value: "fixed_asset_software",
      label: "Fixed Asset Software",
      description: "Use Fixed Asset Software to track purchased software or software licences that are capitalised as assets.",
      suggestedNames: ["Software", "Software Licences"],
    },
    {
      value: "fixed_asset_other_tools",
      label: "Fixed Asset Other Tools Equipment",
      description: "Use Fixed Asset Other Tools Equipment to track tools, equipment, and other fixed assets not covered by other types.",
      suggestedNames: ["Tools", "Other Equipment"],
    },
    {
      value: "furniture_fixtures",
      label: "Furniture & Fixtures",
      description: "Use Furniture & Fixtures to track any furniture and fixtures your business owns and uses, like desks, chairs, display cabinets or sales booths.",
      suggestedNames: ["Furniture & Fixtures"],
    },
    {
      value: "intangible_assets",
      label: "Intangible Assets",
      description: "Use Intangible Assets to track intangible assets that you plan to amortise. Examples include franchises, customer lists, copyrights and patents.",
      suggestedNames: ["Intangible Assets", "Patents", "Trademarks"],
    },
    {
      value: "land",
      label: "Land",
      description: "Use Land to track the cost of land you own. Separate from buildings as land is not depreciated.",
      suggestedNames: ["Land"],
    },
    {
      value: "leasehold_improvements",
      label: "Leasehold Improvements",
      description: "Use Leasehold Improvements to track improvements to a leased asset that increases its value. For example, if you renovate a leased office space.",
      suggestedNames: ["Leasehold Improvements"],
    },
    {
      value: "machinery_equipment",
      label: "Machinery & Equipment",
      description: "Use Machinery & Equipment to track computer hardware, as well as any other non-furniture fixtures or devices owned and used for your business. For vehicles, use the Vehicles type.",
      suggestedNames: ["Computer Equipment", "Machinery & Equipment", "Office Equipment"],
    },
    {
      value: "other_fixed_asset",
      label: "Other Fixed Assets",
      description: "Use Other Fixed Assets for tangible assets not covered by other types. Fixed assets are physical property you do not expect to convert to cash within one year.",
      suggestedNames: ["Other Fixed Asset"],
    },
    {
      value: "vehicles",
      label: "Vehicles",
      description: "Use Vehicles to track the value of vehicles your business owns and uses for business. This includes off-road vehicles, motorcycles, boats, etc.",
      suggestedNames: ["Motor Vehicles", "Delivery Vehicles"],
    },
    // --- Non-current / Other Assets ---
    {
      value: "accumulated_amortization",
      label: "Accumulated Amortisation of Other Assets",
      description: "Use Accumulated Amortisation to track how much you've amortised intangible assets over time.",
      suggestedNames: ["Accumulated Amortisation"],
    },
    {
      value: "assets_held_for_sale",
      label: "Assets Held for Sale",
      description: "Use Assets Held for Sale to track non-current assets whose carrying amount will be recovered principally through a sale transaction rather than through continuing use.",
      suggestedNames: ["Assets Held for Sale"],
    },
    {
      value: "deferred_tax_asset",
      label: "Deferred Tax",
      description: "Use Deferred Tax to track amounts of income taxes recoverable in future periods in respect of deductible temporary differences, carryforward of unused tax losses, and carryforward of unused tax credits.",
      suggestedNames: ["Deferred Tax Asset", "Deferred Tax"],
    },
    {
      value: "goodwill",
      label: "Goodwill",
      description: "Use Goodwill only if you have acquired another company. It represents intangible assets of the acquired company like brand name, customer relationships, or reputation.",
      suggestedNames: ["Goodwill"],
    },
    {
      value: "lease_buyout",
      label: "Lease Buyout",
      description: "Use Lease Buyout to track the cost of buying out a lease agreement, such as purchasing leased equipment or property at the end of a lease term.",
      suggestedNames: ["Lease Buyout"],
    },
    {
      value: "licenses",
      label: "Licences",
      description: "Use Licences to track the cost of licences and permits that provide long-term value, such as business licences, franchise rights, or intellectual property licences.",
      suggestedNames: ["Licences", "Permits"],
    },
    {
      value: "long_term_investments",
      label: "Long-term Investments",
      description: "Use Long-term Investments to track investments not expected to be converted to cash within one year.",
      suggestedNames: ["Long-term Investments"],
    },
    {
      value: "organizational_costs",
      label: "Organizational Costs",
      description: "Use Organizational Costs to track costs incurred in forming a corporation or partnership, such as legal fees, incorporation fees, and filing charges.",
      suggestedNames: ["Organizational Costs", "Formation Costs"],
    },
    {
      value: "security_deposits",
      label: "Security Deposits",
      description: "Use Security Deposits to track funds you've paid to cover any potential costs incurred by damage, loss, or theft. The funds should be returned at the end of the contract.",
      suggestedNames: ["Security Deposits", "Rental Deposits"],
    },
    {
      value: "other_non_current_asset",
      label: "Other Long-term Assets",
      description: "Use Other Long-term Assets for long-term assets not covered by other types. These are expected to provide value for more than one year.",
      suggestedNames: ["Other Non-current Asset", "Other Long-term Assets"],
    },
  ],
  liability: [
    // --- Credit Card (safe default first — NOT A/P) ---
    {
      value: "credit_card",
      label: "Credit Card",
      description: "Credit Card accounts track the balance due on your business credit cards. Create a separate account for each credit card your business uses.",
      suggestedNames: ["Credit Card - Visa", "Credit Card - Mastercard", "Corporate Card"],
    },
    // --- Accounts Payable (moved after credit card) ---
    {
      value: "accounts_payable",
      label: "Accounts Payable (A/P)",
      description: "Accounts Payable tracks amounts you owe to your suppliers. Most businesses need only one Accounts Payable account.",
      suggestedNames: ["Accounts Payable", "Trade Payables"],
    },
    // --- Current Liabilities ---
    {
      value: "accrued_liabilities",
      label: "Accrued Liabilities",
      description: "Use Accrued Liabilities for expenses that have been incurred but not yet paid, such as accrued rent, accrued interest, or accrued utilities.",
      suggestedNames: ["Accrued Liabilities", "Accrued Expenses"],
    },
    {
      value: "trust_accounts_liability_current",
      label: "Client Trust Accounts - Liabilities",
      description: "Use Client Trust Accounts - Liabilities to track amounts held in trust on behalf of clients that you are liable to pay out.",
      suggestedNames: ["Client Trust Accounts - Liabilities"],
    },
    {
      value: "finance_lease_current",
      label: "Current Portion of Obligations Under Finance Leases",
      description: "Use this to track the current portion (due within 12 months) of obligations under finance leases or capital leases.",
      suggestedNames: ["Current Portion of Finance Leases", "Finance Lease - Current"],
    },
    {
      value: "dividends_payable",
      label: "Dividends Payable",
      description: "Use Dividends Payable to track dividends that have been declared by the board of directors but have not yet been paid to shareholders.",
      suggestedNames: ["Dividends Payable"],
    },
    {
      value: "current_tax_liability",
      label: "Current Tax Liability",
      description: "Use Current Tax Liability to track the total amount of income taxes or corporate taxes collected but not yet paid to the government.",
      suggestedNames: ["Income Tax Payable", "Corporate Tax Payable", "Federal Income Tax Payable"],
    },
    {
      value: "insurance_payable",
      label: "Insurance Payable",
      description: "Use Insurance Payable to track insurance amounts due. Most useful for businesses with monthly recurring insurance expenses.",
      suggestedNames: ["Insurance Payable"],
    },
    {
      value: "line_of_credit",
      label: "Line of Credit",
      description: "Use Line of Credit to track the balance due on any lines of credit. Each line of credit should have its own account.",
      suggestedNames: ["Line of Credit", "Overdraft Facility"],
    },
    {
      value: "loan_payable_current",
      label: "Loan Payable",
      description: "Use Loan Payable to track loans your business owes which are payable within the next 12 months. For longer-term loans, use Long-term Liability instead.",
      suggestedNames: ["Short-term Loan", "Loan Payable - Current"],
    },
    {
      value: "payroll_clearing",
      label: "Payroll Clearing",
      description: "Use Payroll Clearing to track the net payroll amount after deductions, used as an intermediary account between payroll processing and actual payment.",
      suggestedNames: ["Payroll Clearing"],
    },
    {
      value: "payroll_liabilities",
      label: "Payroll Liabilities",
      description: "Use Payroll Liabilities to track amounts withheld from employee pay or owed as a result of payroll, including PAYE, NSSF, NHIF/SHIF, and Housing Levy.",
      suggestedNames: ["PAYE Payable", "NSSF Payable", "NHIF/SHIF Payable", "Housing Levy Payable", "Payroll Liabilities"],
    },
    {
      value: "payroll_tax_payable",
      label: "Payroll Tax Payable",
      description: "Use Payroll Tax Payable to track payroll tax amounts withheld from employees or owed by the employer that have not yet been remitted.",
      suggestedNames: ["Payroll Tax Payable"],
    },
    {
      value: "prepaid_expenses_payable",
      label: "Prepaid Expenses Payable",
      description: "Use Prepaid Expenses Payable to track amounts owed for prepaid expenses, such as insurance premiums or rent paid in advance by customers.",
      suggestedNames: ["Prepaid Expenses Payable"],
    },
    {
      value: "rents_in_trust_liability",
      label: "Rents in Trust - Liability",
      description: "Use Rents in Trust - Liability to track the liability side of rents you hold in trust for property owners.",
      suggestedNames: ["Rents in Trust - Liability"],
    },
    {
      value: "sales_tax_payable",
      label: "Sales Tax / VAT Payable",
      description: "Use Sales Tax / VAT Payable to track tax collected from customers on behalf of the government that you haven't yet remitted.",
      suggestedNames: ["VAT Payable", "Sales Tax Payable", "Withholding Tax Payable"],
    },
    {
      value: "state_local_tax_payable",
      label: "State/Local Income Tax Payable",
      description: "Use State/Local Income Tax Payable to track state and local income tax obligations that have been incurred but not yet paid.",
      suggestedNames: ["State Income Tax Payable", "Local Tax Payable"],
    },
    {
      value: "trust_accounts_liability",
      label: "Trust Accounts - Liabilities",
      description: "Use Trust Accounts - Liabilities to track amounts held in trust accounts that you are liable to pay out.",
      suggestedNames: ["Trust Accounts - Liabilities"],
    },
    {
      value: "unearned_revenue",
      label: "Unearned Revenue / Deferred Revenue",
      description: "Use Unearned Revenue for payments received from customers for goods or services you haven't yet delivered. Revenue is recognised when you fulfil the obligation.",
      suggestedNames: ["Unearned Revenue", "Customer Deposits", "Deferred Revenue"],
    },
    {
      value: "other_current_liability",
      label: "Other Current Liabilities",
      description: "Use Other Current Liabilities for short-term obligations due within 12 months not covered by other types.",
      suggestedNames: ["Other Current Liability"],
    },
    // --- Long-term Liabilities ---
    {
      value: "accrued_holiday_payable",
      label: "Accrued Holiday Payable",
      description: "Use Accrued Holiday Payable to track the liability for employee holiday pay and vacation time that has been earned but not yet taken or paid out.",
      suggestedNames: ["Accrued Holiday Payable", "Accrued Vacation"],
    },
    {
      value: "accrued_non_current_liabilities",
      label: "Accrued Non-current Liabilities",
      description: "Use Accrued Non-current Liabilities to track long-term accrued obligations not covered by other types, such as deferred compensation or long-term employee benefits.",
      suggestedNames: ["Accrued Non-current Liabilities"],
    },
    {
      value: "liabilities_held_for_sale",
      label: "Liabilities Related to Assets Held for Sale",
      description: "Use this to track liabilities directly associated with assets classified as held for sale, presented separately on the balance sheet.",
      suggestedNames: ["Liabilities Related to Assets Held for Sale"],
    },
    {
      value: "long_term_borrowings",
      label: "Long-term Debt",
      description: "Use Long-term Debt to track the amount due on borrowings with a repayment term exceeding 12 months.",
      suggestedNames: ["Long-term Loan", "Term Loan", "Long-term Debt"],
    },
    {
      value: "lease_obligations",
      label: "Lease Obligations",
      description: "Use Lease Obligations to track long-term lease payment obligations under finance leases or operating leases recognised on the balance sheet.",
      suggestedNames: ["Lease Obligations", "Finance Lease Liability"],
    },
    {
      value: "notes_payable",
      label: "Notes Payable",
      description: "Use Notes Payable to track amounts your business owes in long-term (over 12 months) loans. For shorter loans, use Loan Payable instead.",
      suggestedNames: ["Notes Payable", "Bank Loan - Long-term", "Mortgage Payable"],
    },
    {
      value: "shareholder_notes_payable",
      label: "Shareholder Notes Payable",
      description: "Use Shareholder Notes Payable to track amounts the business owes to shareholders through formal loan agreements.",
      suggestedNames: ["Shareholder Notes Payable", "Director Loan Payable"],
    },
    {
      value: "other_non_current_liability",
      label: "Other Long Term Liabilities",
      description: "Use Other Long Term Liabilities for obligations due in more than 12 months not covered by other types.",
      suggestedNames: ["Other Non-current Liability", "Provision for Liabilities"],
    },
  ],
  equity: [
    {
      value: "accumulated_adjustment",
      label: "Accumulated Adjustment",
      description: "Use Accumulated Adjustment for S-corporation adjustments or accumulated other comprehensive income items such as foreign currency translation or unrealised gains/losses.",
      suggestedNames: ["Accumulated Adjustment", "Accumulated Other Comprehensive Income"],
    },
    {
      value: "dividend_disbursed",
      label: "Dividend Disbursed",
      description: "Use Dividend Disbursed to track dividends that have been paid out to shareholders during the current period.",
      suggestedNames: ["Dividend Disbursed", "Dividends Paid"],
    },
    {
      value: "equity_in_subsidiaries",
      label: "Equity in Earnings of Subsidiaries",
      description: "Use Equity in Earnings of Subsidiaries to track the parent company's share of profit or loss from subsidiary companies accounted for using the equity method.",
      suggestedNames: ["Equity in Earnings of Subsidiaries"],
    },
    {
      value: "share_capital",
      label: "Ordinary Shares",
      description: "Use Ordinary Shares to track shares of common stock issued to shareholders. The amount should reflect the stated (par) value of the shares.",
      suggestedNames: ["Common Stock", "Share Capital", "Ordinary Shares"],
    },
    {
      value: "estimated_taxes",
      label: "Estimated Taxes",
      description: "Use Estimated Taxes to track estimated tax payments made during the year before the final tax return is filed.",
      suggestedNames: ["Estimated Taxes", "Provisional Tax"],
    },
    {
      value: "health_insurance_premium",
      label: "Health Insurance Premium",
      description: "Use Health Insurance Premium to track health insurance premiums paid on behalf of partners, sole proprietors, or LLC members.",
      suggestedNames: ["Health Insurance Premium"],
    },
    {
      value: "opening_balance_equity",
      label: "Opening Balance Equity",
      description: "Opening Balance Equity is used when you enter opening balances for balance sheet accounts. This ensures you have a correct balance sheet even before entering all assets and liabilities.",
      suggestedNames: ["Opening Balance Equity"],
    },
    {
      value: "other_comprehensive_income",
      label: "Other Comprehensive Income",
      description: "Use Other Comprehensive Income to track items that bypass the income statement, such as unrealised gains/losses on available-for-sale securities, foreign currency translation adjustments, and cash flow hedge adjustments.",
      suggestedNames: ["Other Comprehensive Income"],
    },
    {
      value: "owner_contributions",
      label: "Partner Contributions",
      description: "Use Partner Contributions to track amounts the owner(s) or partners contribute to the business during the year, separate from share capital.",
      suggestedNames: ["Owner's Investment", "Partner Contributions", "Capital Contributions"],
    },
    {
      value: "owner_drawings",
      label: "Partner Distributions",
      description: "Use Partner Distributions to track amounts distributed by the business to its owner(s) or partners during the year. Don't use this for regular salary payments.",
      suggestedNames: ["Owner's Drawings", "Dividends Paid", "Partner Distributions"],
    },
    {
      value: "owners_equity",
      label: "Owner's Equity",
      description: "Use Owner's Equity to show the cumulative net investment by the owner(s) of the business. For partnerships, use Partner's Equity.",
      suggestedNames: ["Owner's Equity", "Partner's Equity", "Shareholders' Equity"],
    },
    {
      value: "paid_in_capital",
      label: "Paid-in Capital or Surplus",
      description: "Use Paid-in Capital to track amounts received from shareholders in exchange for shares that are over and above the shares' stated (par) value.",
      suggestedNames: ["Paid-in Capital", "Share Premium"],
    },
    {
      value: "personal_expense",
      label: "Personal Expense",
      description: "Use Personal Expense to track personal expenses paid by the business on behalf of the owner. This is treated as a draw against equity.",
      suggestedNames: ["Personal Expense"],
    },
    {
      value: "personal_income",
      label: "Personal Income",
      description: "Use Personal Income to track personal income deposited into the business account. This is treated as a contribution to equity.",
      suggestedNames: ["Personal Income"],
    },
    {
      value: "preferred_stock",
      label: "Preferred Shares",
      description: "Use Preferred Shares to track the value of preferred shares issued. Preferred shareholders have priority over ordinary shareholders for dividends.",
      suggestedNames: ["Preferred Stock", "Preference Shares"],
    },
    {
      value: "retained_earnings",
      label: "Retained Earnings",
      description: "Retained Earnings tracks net income from previous financial years. The system automatically transfers your profit (or loss) to Retained Earnings at the end of each financial year.",
      suggestedNames: ["Retained Earnings", "Accumulated Profits"],
    },
    {
      value: "treasury_stock",
      label: "Treasury Shares",
      description: "Use Treasury Shares to track the cost of shares repurchased by the company. Treasury shares reduce total shareholders' equity.",
      suggestedNames: ["Treasury Stock", "Treasury Shares"],
    },
    {
      value: "other_equity",
      label: "Other Equity",
      description: "Use Other Equity for equity items not covered by other types, such as revaluation reserves or foreign currency translation adjustments.",
      suggestedNames: ["Other Equity", "Revaluation Reserve"],
    },
  ],
  income: [
    {
      value: "discount_refund",
      label: "Discounts / Refunds Given",
      description: "Use Discounts/Refunds Given to track discounts you give to customers. This account typically has a negative balance so it offsets other income. For supplier discounts, use an Expense account.",
      suggestedNames: ["Sales Discounts", "Sales Returns & Refunds"],
    },
    {
      value: "non_profit_income",
      label: "Non-Profit Income",
      description: "Use Non-Profit Income to track money coming in if you are a non-profit organisation, including donations, grants, and membership fees.",
      suggestedNames: ["Donations Received", "Grants Income", "Membership Fees"],
    },
    {
      value: "other_primary_income",
      label: "Other Primary Income",
      description: "Use Other Primary Income to track income from normal business operations that doesn't fall into Sales or Service income categories.",
      suggestedNames: ["Other Primary Income"],
    },
    {
      value: "revenue_general",
      label: "Revenue - General",
      description: "Use Revenue - General for general revenue streams that are not specifically categorised as product sales, service income, or other specific income types.",
      suggestedNames: ["Revenue - General", "General Revenue"],
    },
    {
      value: "sales_retail",
      label: "Sales - Retail",
      description: "Use Sales - Retail to track income from retail sales made directly to end consumers.",
      suggestedNames: ["Retail Sales", "Sales - Retail"],
    },
    {
      value: "sales_wholesale",
      label: "Sales - Wholesale",
      description: "Use Sales - Wholesale to track income from wholesale sales made to resellers or bulk buyers at discounted prices.",
      suggestedNames: ["Wholesale Sales", "Sales - Wholesale"],
    },
    {
      value: "sales_income",
      label: "Sales of Product Income",
      description: "Use Sales of Product Income to track income from selling products. This can include all kinds of products — goods, crops, livestock, or merchandise.",
      suggestedNames: ["Product Sales", "Sales Revenue", "Merchandise Sales"],
    },
    {
      value: "service_income",
      label: "Service / Fee Income",
      description: "Use Service/Fee Income to track income from services you perform or ordinary usage fees you charge. For late fees or unusual income, use Other Income instead.",
      suggestedNames: ["Service Revenue", "Consulting Income", "Professional Fees", "Contract Revenue"],
    },
    {
      value: "unapplied_cash_payment_income",
      label: "Unapplied Cash Payment Income",
      description: "Use Unapplied Cash Payment Income to track cash received but not yet matched to a specific customer invoice.",
      suggestedNames: ["Unapplied Cash Payment Income"],
    },
    // --- Other Income ---
    {
      value: "dividend_income",
      label: "Dividend Income",
      description: "Use Dividend Income to track taxable dividends received from investments in other companies.",
      suggestedNames: ["Dividend Income"],
    },
    {
      value: "interest_income",
      label: "Interest Earned",
      description: "Use Interest Earned to track interest from bank accounts, investments, or interest payments to you on loans your business has made.",
      suggestedNames: ["Interest Income", "Bank Interest Earned"],
    },
    {
      value: "gain_on_asset_sales",
      label: "Loss on Disposal of Assets",
      description: "Use Loss on Disposal of Assets to track gains or losses made from selling or disposing of business assets.",
      suggestedNames: ["Gain on Sale of Assets", "Loss on Disposal of Assets"],
    },
    {
      value: "other_investment_income",
      label: "Other Investment Income",
      description: "Use Other Investment Income to track income from investments not classified as interest or dividends, such as capital gains distributions.",
      suggestedNames: ["Other Investment Income", "Capital Gains"],
    },
    {
      value: "other_operating_income",
      label: "Other Operating Income",
      description: "Use Other Operating Income to track income from operating activities not classified as primary revenue, such as commissions received, management fees, or recharges.",
      suggestedNames: ["Other Operating Income"],
    },
    {
      value: "rental_income",
      label: "Rental Income",
      description: "Use Rental Income to track income received from renting out property or equipment owned by the business.",
      suggestedNames: ["Rental Income"],
    },
    {
      value: "tax_exempt_interest",
      label: "Tax-Exempt Interest",
      description: "Use Tax-Exempt Interest to track interest income earned on tax-exempt investments such as municipal bonds.",
      suggestedNames: ["Tax-Exempt Interest"],
    },
    {
      value: "unrealized_loss_securities",
      label: "Unrealised Loss on Securities, Net of Tax",
      description: "Use this to track unrealised losses on investments in securities that are reported net of the related tax effect.",
      suggestedNames: ["Unrealised Loss on Securities"],
    },
    {
      value: "other_income",
      label: "Other Miscellaneous Income",
      description: "Use Other Miscellaneous Income for income that isn't from normal business operations and doesn't fall into another income type.",
      suggestedNames: ["Miscellaneous Income", "Foreign Exchange Gain", "Other Income"],
    },
  ],
  expense: [
    // --- Cost of Goods Sold ---
    {
      value: "cost_of_labour",
      label: "Cost of Labour - COS",
      description: "Use Cost of Labour to track the cost of paying employees to produce products or supply services. It includes all employment costs including food and transportation.",
      suggestedNames: ["Direct Labour", "Cost of Labour"],
    },
    {
      value: "cost_of_goods_sold",
      label: "Cost of Goods Sold",
      description: "Use Cost of Goods Sold to track the direct costs of products sold or services delivered. This is the primary cost of sales account.",
      suggestedNames: ["Cost of Goods Sold", "Cost of Sales"],
    },
    {
      value: "equipment_rental_cos",
      label: "Equipment Rental - COS",
      description: "Use Equipment Rental - COS to track the cost of renting equipment directly used in producing goods or delivering services.",
      suggestedNames: ["Equipment Rental - COS"],
    },
    {
      value: "freight_delivery_cos",
      label: "Freight and Delivery - COS",
      description: "Use Freight and Delivery - COS to track freight and delivery costs that are a direct cost of sales, separate from general shipping expenses.",
      suggestedNames: ["Freight and Delivery - COS"],
    },
    {
      value: "supplies_materials_cos",
      label: "Supplies & Materials - COGS",
      description: "Use Supplies & Materials to track the cost of raw goods and parts used or consumed when producing a product or providing a service.",
      suggestedNames: ["Direct Materials", "Raw Materials", "Supplies - COS"],
    },
    {
      value: "shipping_cos",
      label: "Shipping, Freight & Delivery - COS",
      description: "Use Shipping, Freight & Delivery to track the cost of shipping products to customers or distributors as a direct cost of sales.",
      suggestedNames: ["Freight In", "Shipping - COS", "Delivery Costs - COS"],
    },
    {
      value: "other_cos",
      label: "Other Costs of Services - COS",
      description: "Use Other Costs of Services for direct costs related to products or services that don't fall into another Cost of Sales type.",
      suggestedNames: ["Other Cost of Sales", "Purchase Discounts", "Other Costs of Services"],
    },
    // --- Operating Expenses ---
    {
      value: "advertising",
      label: "Advertising / Promotional",
      description: "Use Advertising/Promotional to track money spent promoting your company — Yellow Pages, newspaper, radio, flyers, events, online ads, etc.",
      suggestedNames: ["Advertising & Marketing", "Marketing Expense", "Promotional Expenses"],
    },
    {
      value: "auto",
      label: "Auto",
      description: "Use Auto to track costs associated with business vehicles — fuel, repairs, maintenance, registration, and insurance.",
      suggestedNames: ["Vehicle Expenses", "Fuel & Mileage", "Auto Expense"],
    },
    {
      value: "bad_debts",
      label: "Bad Debts",
      description: "Use Bad Debts to track debt you have written off as uncollectable.",
      suggestedNames: ["Bad Debt Expense"],
    },
    {
      value: "bank_charges",
      label: "Bank Charges",
      description: "Use Bank Charges for any fees you pay to financial institutions — service charges, transaction fees, wire transfer fees, etc.",
      suggestedNames: ["Bank Charges", "Bank Service Fees"],
    },
    {
      value: "charitable_contributions",
      label: "Charitable Contributions",
      description: "Use Charitable Contributions to track donations and contributions to charitable organisations.",
      suggestedNames: ["Charitable Contributions", "Donations"],
    },
    {
      value: "commissions_fees",
      label: "Commissions & Fees",
      description: "Use Commissions & Fees to track commission payments to sales agents, brokers, or other intermediaries, and associated fees.",
      suggestedNames: ["Commissions & Fees", "Sales Commissions"],
    },
    {
      value: "cost_of_labour_expense",
      label: "Cost of Labour",
      description: "Use Cost of Labour (as an operating expense) to track labour costs that are not directly tied to production or cost of sales.",
      suggestedNames: ["Cost of Labour", "Labour Expense"],
    },
    {
      value: "dues_subscriptions",
      label: "Dues & Subscriptions",
      description: "Use Dues & Subscriptions for professional dues, membership fees, magazines, newspapers, industry publications, or software subscriptions.",
      suggestedNames: ["Dues & Subscriptions", "Software Subscriptions"],
    },
    {
      value: "entertainment",
      label: "Entertainment",
      description: "Use Entertainment to track entertainment expenses for clients or employees, such as event tickets, outings, or recreational activities.",
      suggestedNames: ["Entertainment", "Client Entertainment"],
    },
    {
      value: "entertainment_meals",
      label: "Entertainment Meals",
      description: "Use Entertainment Meals to track meals provided for entertainment purposes, such as client dinners or business social events.",
      suggestedNames: ["Entertainment Meals"],
    },
    {
      value: "equipment_rental",
      label: "Equipment Rental",
      description: "Use Equipment Rental for the cost of renting equipment to produce products or services. If you purchase equipment, use a Fixed Asset account instead.",
      suggestedNames: ["Equipment Rental"],
    },
    {
      value: "finance_costs",
      label: "Finance Costs",
      description: "Use Finance Costs to track costs related to financing activities, such as loan origination fees, commitment fees, or other financing charges.",
      suggestedNames: ["Finance Costs", "Financing Charges"],
    },
    {
      value: "income_tax_expense",
      label: "Income Tax Expense",
      description: "Use Income Tax Expense to track the total income tax expense recognised in the income statement for the period.",
      suggestedNames: ["Income Tax Expense", "Corporate Tax Expense"],
    },
    {
      value: "insurance_expense",
      label: "Insurance",
      description: "Use Insurance to track insurance payments — general liability, property, professional indemnity, health insurance, etc.",
      suggestedNames: ["Insurance Expense", "General Insurance", "Professional Indemnity Insurance"],
    },
    {
      value: "interest_paid",
      label: "Interest Paid",
      description: "Use Interest Paid for all types of interest you pay, including mortgage interest, finance charges on cards, or interest on loans.",
      suggestedNames: ["Interest Expense", "Loan Interest"],
    },
    {
      value: "loss_discontinued_operations",
      label: "Loss on Discontinued Operations, Net of Tax",
      description: "Use this to track losses from business segments or operations that have been discontinued, reported net of the related tax effect.",
      suggestedNames: ["Loss on Discontinued Operations"],
    },
    {
      value: "management_compensation",
      label: "Management Compensation",
      description: "Use Management Compensation to track compensation paid to directors, executives, and key management personnel.",
      suggestedNames: ["Management Compensation", "Director Compensation"],
    },
    {
      value: "legal_professional_fees",
      label: "Legal & Professional Fees",
      description: "Use Legal & Professional Fees for money paid to professionals — accountants, lawyers, consultants, auditors, or other professional advisors.",
      suggestedNames: ["Professional Fees", "Legal Fees", "Audit Fees", "Consulting Fees"],
    },
    {
      value: "office_expenses",
      label: "Office / General Administrative Expenses",
      description: "Use Office/General Administrative Expenses for all types of general or office-related expenses not covered by other categories.",
      suggestedNames: ["Office Supplies", "General & Administrative", "Printing & Stationery"],
    },
    {
      value: "other_business_expenses",
      label: "Other Business Expenses",
      description: "Use Other Business Expenses for business expenses that don't fall into any other specific expense category.",
      suggestedNames: ["Other Business Expenses", "Miscellaneous Business Expense"],
    },
    {
      value: "other_selling_expense",
      label: "Other Selling Expense",
      description: "Use Other Selling Expense to track selling expenses not covered by other categories, such as sales team costs, trade show expenses, or marketing collateral.",
      suggestedNames: ["Other Selling Expense", "Selling Expenses"],
    },
    {
      value: "other_misc_service_cost",
      label: "Other Miscellaneous Service Cost",
      description: "Use Other Miscellaneous Service Cost to track service-related expenses that don't fall into another category.",
      suggestedNames: ["Other Miscellaneous Service Cost"],
    },
    {
      value: "payroll_expense",
      label: "Payroll Expenses",
      description: "Use Payroll Expenses to track employee compensation — salaries, wages, bonuses, employer tax contributions, benefits, and allowances.",
      suggestedNames: ["Salaries & Wages", "Employee Benefits", "Payroll Taxes", "NSSF Employer Contribution"],
    },
    {
      value: "payroll_tax_expense",
      label: "Payroll Tax Expenses",
      description: "Use Payroll Tax Expenses to track payroll taxes paid by the employer, such as employer FICA, FUTA, SUTA, or equivalent.",
      suggestedNames: ["Payroll Tax Expenses", "Employer Payroll Taxes"],
    },
    {
      value: "payroll_wage_expense",
      label: "Payroll Wage Expenses",
      description: "Use Payroll Wage Expenses to separately track gross wages and salaries paid to employees.",
      suggestedNames: ["Wages & Salaries", "Payroll Wage Expenses"],
    },
    {
      value: "promotional_meals",
      label: "Promotional Meals",
      description: "Use Promotional Meals to track meals provided for promotional purposes, such as product launches or marketing events.",
      suggestedNames: ["Promotional Meals"],
    },
    {
      value: "rent_expense",
      label: "Rent or Lease of Buildings",
      description: "Use Rent or Lease of Buildings to track rent payments for office space, warehouse, retail space, or other business premises.",
      suggestedNames: ["Rent Expense", "Office Rent", "Warehouse Rent"],
    },
    {
      value: "repair_maintenance",
      label: "Repair & Maintenance",
      description: "Use Repair & Maintenance for any repairs and periodic maintenance fees — equipment, building, vehicle, or IT maintenance.",
      suggestedNames: ["Repairs & Maintenance", "Equipment Maintenance"],
    },
    {
      value: "security_expenses",
      label: "Security Expenses",
      description: "Use Security Expenses for costs related to securing your business premises — security guards, alarm systems, CCTV, etc.",
      suggestedNames: ["Security Expenses"],
    },
    {
      value: "shipping_delivery",
      label: "Shipping, Freight & Delivery",
      description: "Use Shipping, Freight & Delivery for incidental shipping expenses. For direct cost-of-sales shipping, use the COS version instead.",
      suggestedNames: ["Shipping & Delivery", "Freight & Postage"],
    },
    {
      value: "supplies",
      label: "Supplies & Materials",
      description: "Use Supplies & Materials to track the cost of materials consumed in day-to-day operations — cleaning supplies, breakroom items, small tools, etc.",
      suggestedNames: ["Office Supplies", "Cleaning Supplies", "Supplies & Materials"],
    },
    {
      value: "taxes_paid",
      label: "Taxes Paid",
      description: "Use Taxes Paid for taxes you pay that are an expense to the business, such as property taxes, excise taxes, or business licences.",
      suggestedNames: ["Taxes Paid", "Licence Fees"],
    },
    {
      value: "telephone_internet",
      label: "Telephone & Internet",
      description: "Use Telephone & Internet to track costs for phone lines, mobile phones, and internet services used for business purposes.",
      suggestedNames: ["Telephone & Internet", "Internet Expense", "Mobile Phone Expense", "Communication"],
    },
    {
      value: "travel",
      label: "Travel Expenses - General and Admin",
      description: "Use Travel to track travel costs — flights, accommodation, ground transport. For food while travelling, use Travel Meals instead.",
      suggestedNames: ["Travel Expense", "Travel & Accommodation"],
    },
    {
      value: "travel_meals",
      label: "Travel Meals",
      description: "Use Travel Meals to track meal expenses incurred while travelling for business purposes.",
      suggestedNames: ["Travel Meals"],
    },
    {
      value: "travel_selling",
      label: "Travel Expenses - Selling Expense",
      description: "Use Travel Expenses - Selling Expense to track travel costs incurred by the sales team for client visits, trade shows, and sales-related travel.",
      suggestedNames: ["Travel - Sales", "Sales Travel"],
    },
    {
      value: "meals_entertainment",
      label: "Meals & Entertainment",
      description: "Use Meals & Entertainment for dining with employees to promote morale, or for business entertainment. Include who you dined with and the purpose.",
      suggestedNames: ["Travel & Entertainment", "Meals & Entertainment"],
    },
    {
      value: "unapplied_cash_bill_payment",
      label: "Unapplied Cash Bill Payment Expense",
      description: "Use Unapplied Cash Bill Payment Expense to track payments made that have not yet been matched to a specific vendor bill.",
      suggestedNames: ["Unapplied Cash Bill Payment"],
    },
    {
      value: "utilities",
      label: "Utilities",
      description: "Use Utilities for utility payments — electricity, water, gas, waste disposal, and similar recurring service bills.",
      suggestedNames: ["Utilities", "Electricity", "Water & Sewage"],
    },
    // --- Depreciation & Amortisation ---
    {
      value: "depreciation",
      label: "Depreciation",
      description: "Use Depreciation to track how much you depreciate tangible assets. You may want a depreciation account for each tangible asset category.",
      suggestedNames: ["Depreciation Expense"],
    },
    {
      value: "amortization",
      label: "Amortisation",
      description: "Use Amortisation to track the spreading of the cost of intangible assets over their useful life, similar to depreciation for tangible assets.",
      suggestedNames: ["Amortisation Expense"],
    },
    // --- Other Expenses ---
    {
      value: "exchange_gain_loss",
      label: "Exchange Gain or Loss",
      description: "Use Exchange Gain or Loss to track gains or losses that occur as a result of exchange rate fluctuations on foreign currency transactions.",
      suggestedNames: ["Foreign Exchange Loss", "Exchange Gain/Loss"],
    },
    {
      value: "penalties",
      label: "Penalties & Settlements",
      description: "Use Penalties & Settlements for money you pay for violating laws or regulations, settling lawsuits, fines, or other penalties.",
      suggestedNames: ["Penalties & Fines"],
    },
    {
      value: "loss_on_asset_sales",
      label: "Loss on Sale of Assets",
      description: "Use Loss on Sale of Assets to track losses from selling business assets for less than their book value.",
      suggestedNames: ["Loss on Sale of Assets"],
    },
    {
      value: "other_expense",
      label: "Other Miscellaneous Expense",
      description: "Use Other Expense for unusual or infrequent expenses that don't fall into any other expense category.",
      suggestedNames: ["Miscellaneous Expense", "Other Expense"],
    },
  ],
};

/**
 * QuickBooks-style Account Categories (15 types)
 * 
 * QuickBooks shows these 15 categories in the "Account Type" dropdown,
 * grouped under Balance Sheet / Income & Expense headers.
 * Each category maps to one of our 5 base DB types and filters detail types.
 */
export interface AccountCategory {
  value: string;
  label: string;
  /** The base account_type stored in DB */
  baseType: "asset" | "liability" | "equity" | "income" | "expense";
  /** Which detail_type values belong to this category */
  detailTypes: string[];
  /** Grouping header for the dropdown */
  group: "Balance Sheet" | "Income & Expense";
}

export const ACCOUNT_CATEGORIES: AccountCategory[] = [
  // ── Balance Sheet: Assets ──
  {
    value: "bank",
    label: "Cash and Cash Equivalents",
    baseType: "asset",
    detailTypes: ["checking", "cash_and_cash_equivalents", "cash_on_hand", "trust_account", "money_market", "rents_held_in_trust", "savings", "mobile_money"],
    group: "Balance Sheet",
  },
  {
    value: "accounts_receivable",
    label: "Accounts Receivable (A/R)",
    baseType: "asset",
    detailTypes: ["accounts_receivable"],
    group: "Balance Sheet",
  },
  {
    value: "other_current_assets",
    label: "Other Current Assets",
    baseType: "asset",
    detailTypes: [
      "allowance_bad_debts", "assets_available_for_sale", "development_costs", "employee_advances",
      "inventory", "investment_government", "investment_tax_exempt", "loans_to_officers",
      "loans_to_others", "loans_to_stockholders", "prepaid_expenses", "retainage",
      "short_term_investments", "undeposited_funds", "other_current_asset",
    ],
    group: "Balance Sheet",
  },
  {
    value: "fixed_assets",
    label: "Fixed Assets",
    baseType: "asset",
    detailTypes: [
      "accumulated_depletion", "accumulated_depreciation", "buildings", "depletable_assets",
      "fixed_asset_computers", "fixed_asset_copiers", "fixed_asset_furniture", "fixed_asset_phone",
      "fixed_asset_photo_video", "fixed_asset_software", "fixed_asset_other_tools",
      "furniture_fixtures", "intangible_assets", "land", "leasehold_improvements",
      "machinery_equipment", "other_fixed_asset", "vehicles",
    ],
    group: "Balance Sheet",
  },
  {
    value: "other_assets",
    label: "Non-current Assets",
    baseType: "asset",
    detailTypes: [
      "accumulated_amortization", "assets_held_for_sale", "deferred_tax_asset", "goodwill",
      "intangible_assets", "lease_buyout", "licenses", "long_term_investments",
      "organizational_costs", "security_deposits", "other_non_current_asset",
    ],
    group: "Balance Sheet",
  },
  // ── Balance Sheet: Liabilities ──
  {
    value: "accounts_payable",
    label: "Accounts Payable (A/P)",
    baseType: "liability",
    detailTypes: ["accounts_payable"],
    group: "Balance Sheet",
  },
  {
    value: "credit_card",
    label: "Credit Card",
    baseType: "liability",
    detailTypes: ["credit_card"],
    group: "Balance Sheet",
  },
  {
    value: "other_current_liabilities",
    label: "Other Current Liabilities",
    baseType: "liability",
    detailTypes: [
      "accrued_liabilities", "trust_accounts_liability_current", "current_tax_liability",
      "finance_lease_current", "dividends_payable", "insurance_payable",
      "line_of_credit", "loan_payable_current", "payroll_clearing", "payroll_liabilities",
      "payroll_tax_payable", "prepaid_expenses_payable", "rents_in_trust_liability",
      "sales_tax_payable", "state_local_tax_payable", "trust_accounts_liability",
      "unearned_revenue", "other_current_liability",
    ],
    group: "Balance Sheet",
  },
  {
    value: "long_term_liabilities",
    label: "Non-current Liabilities",
    baseType: "liability",
    detailTypes: [
      "accrued_holiday_payable", "accrued_non_current_liabilities", "liabilities_held_for_sale",
      "long_term_borrowings", "lease_obligations", "notes_payable",
      "shareholder_notes_payable", "other_non_current_liability",
    ],
    group: "Balance Sheet",
  },
  // ── Balance Sheet: Equity ──
  {
    value: "equity",
    label: "Owner's Equity",
    baseType: "equity",
    detailTypes: [
      "accumulated_adjustment", "dividend_disbursed", "equity_in_subsidiaries",
      "share_capital", "estimated_taxes", "health_insurance_premium",
      "opening_balance_equity", "other_comprehensive_income", "owner_contributions",
      "owner_drawings", "owners_equity", "paid_in_capital", "personal_expense",
      "personal_income", "preferred_stock", "retained_earnings", "treasury_stock", "other_equity",
    ],
    group: "Balance Sheet",
  },
  // ── Income & Expense ──
  {
    value: "income",
    label: "Income",
    baseType: "income",
    detailTypes: [
      "discount_refund", "non_profit_income", "other_primary_income", "revenue_general",
      "sales_retail", "sales_wholesale", "sales_income", "service_income",
      "unapplied_cash_payment_income",
    ],
    group: "Income & Expense",
  },
  {
    value: "other_income",
    label: "Other Income",
    baseType: "income",
    detailTypes: [
      "dividend_income", "interest_income", "gain_on_asset_sales",
      "other_investment_income", "other_operating_income", "rental_income",
      "tax_exempt_interest", "unrealized_loss_securities", "other_income",
    ],
    group: "Income & Expense",
  },
  {
    value: "cost_of_goods_sold",
    label: "Cost of Goods Sold",
    baseType: "expense",
    detailTypes: [
      "cost_of_labour", "cost_of_goods_sold", "equipment_rental_cos",
      "freight_delivery_cos", "supplies_materials_cos", "shipping_cos", "other_cos",
    ],
    group: "Income & Expense",
  },
  {
    value: "expenses",
    label: "Expenses",
    baseType: "expense",
    detailTypes: [
      "advertising", "amortization", "auto", "bad_debts", "bank_charges",
      "charitable_contributions", "commissions_fees", "cost_of_labour_expense",
      "dues_subscriptions", "entertainment", "entertainment_meals", "equipment_rental",
      "finance_costs", "income_tax_expense", "insurance_expense", "interest_paid",
      "loss_discontinued_operations", "management_compensation", "legal_professional_fees",
      "meals_entertainment", "office_expenses", "other_business_expenses",
      "other_selling_expense", "other_misc_service_cost",
      "payroll_expense", "payroll_tax_expense", "payroll_wage_expense", "promotional_meals",
      "rent_expense", "repair_maintenance", "security_expenses", "shipping_delivery",
      "supplies", "taxes_paid", "telephone_internet", "travel", "travel_meals",
      "travel_selling", "unapplied_cash_bill_payment", "utilities", "depreciation",
    ],
    group: "Income & Expense",
  },
  {
    value: "other_expense",
    label: "Other Expense",
    baseType: "expense",
    detailTypes: ["exchange_gain_loss", "penalties", "loss_on_asset_sales", "other_expense"],
    group: "Income & Expense",
  },
];

/**
 * Find which AccountCategory a detail_type belongs to
 */
export function getCategoryForDetailType(detailType: string): AccountCategory | undefined {
  return ACCOUNT_CATEGORIES.find(cat => cat.detailTypes.includes(detailType));
}

/**
 * Get the category value for a given base account_type + detail_type combo
 */
export function getCategoryValue(accountType: string, detailType: string | null): string {
  if (detailType) {
    const cat = getCategoryForDetailType(detailType);
    if (cat) return cat.value;
  }
  // Fallback: return a reasonable default category for the base type
  const defaults: Record<string, string> = {
    asset: "other_current_assets",
    liability: "other_current_liabilities",
    equity: "equity",
    income: "income",
    expense: "expenses",
  };
  return defaults[accountType] || "other_current_assets";
}

/**
 * Get detail types for a given account type
 */
export function getDetailTypesForAccountType(accountType: string): DetailTypeOption[] {
  return ACCOUNT_DETAIL_TYPES[accountType] || [];
}

/**
 * Get detail types filtered by an AccountCategory value
 */
export function getDetailTypesForCategory(categoryValue: string): DetailTypeOption[] {
  const cat = ACCOUNT_CATEGORIES.find(c => c.value === categoryValue);
  if (!cat) return [];
  const allTypes = ACCOUNT_DETAIL_TYPES[cat.baseType] || [];
  return allTypes.filter(dt => cat.detailTypes.includes(dt.value));
}

/**
 * Get the default (first) detail type for a given account type.
 * QuickBooks auto-selects the first detail type when account type changes.
 */
export function getDefaultDetailType(accountType: string): string {
  const types = ACCOUNT_DETAIL_TYPES[accountType] || [];
  return types.length > 0 ? types[0].value : "";
}

/**
 * Get the default detail type for a category
 */
export function getDefaultDetailTypeForCategory(categoryValue: string): string {
  const filtered = getDetailTypesForCategory(categoryValue);
  return filtered.length > 0 ? filtered[0].value : "";
}

/**
 * Get suggested names for a given detail type
 */
export function getSuggestedNames(accountType: string, detailType: string): string[] {
  const types = ACCOUNT_DETAIL_TYPES[accountType] || [];
  const found = types.find(t => t.value === detailType);
  return found?.suggestedNames || [];
}

/**
 * Get detail type label
 */
export function getDetailTypeLabel(accountType: string, detailType: string): string {
  const types = ACCOUNT_DETAIL_TYPES[accountType] || [];
  const found = types.find(t => t.value === detailType);
  return found?.label || detailType;
}

/**
 * Get detail type description
 */
export function getDetailTypeDescription(accountType: string, detailType: string): string {
  const types = ACCOUNT_DETAIL_TYPES[accountType] || [];
  const found = types.find(t => t.value === detailType);
  return found?.description || "";
}

/**
 * Resolve the best detail_type from an account name and account_type.
 * Used during CSV import when detail_type is not explicitly provided.
 * Matches account name against suggestedNames for each detail type.
 */
export function resolveDetailTypeFromName(accountType: string, accountName: string): string {
  const types = ACCOUNT_DETAIL_TYPES[accountType] || [];
  if (!accountName || types.length === 0) return getDefaultDetailType(accountType);

  const normalizedName = accountName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const lowerName = accountName.toLowerCase().trim();

  // ── Keyword-based rules (high-confidence matches before fuzzy scoring) ──

  if (accountType === "asset") {
    // Bank accounts → checking
    const bankKeywords = ["bank", "ncba", "kcb", "equity bank", "coop bank", "stanbic", "absa", "dtb", "citi", "barclays", "chase", "wells fargo", "boa"];
    if (bankKeywords.some(kw => lowerName.includes(kw))) {
      return "checking";
    }
    // Mobile money → mobile_money
    if (["m-pesa", "mpesa", "airtel money", "mobile money"].some(kw => lowerName.includes(kw))) {
      return "mobile_money";
    }
    // Petty cash → cash_on_hand
    if (lowerName.includes("petty cash") || lowerName === "cash") {
      return "cash_on_hand";
    }
    // Receivable → accounts_receivable (only when explicitly named)
    if (lowerName.includes("receivable") || lowerName.includes("a/r") || lowerName.includes("trade debtors")) {
      return "accounts_receivable";
    }
    // Inventory
    if (["inventory", "stock", "merchandise"].some(kw => lowerName.includes(kw))) {
      return "inventory";
    }
  }

  if (accountType === "liability") {
    // Payable → accounts_payable (only when explicitly named)
    if (lowerName.includes("payable") || lowerName.includes("a/p") || lowerName.includes("trade creditors")) {
      return "accounts_payable";
    }
    // Credit card
    if (lowerName.includes("credit card") || lowerName.includes("visa") || lowerName.includes("mastercard")) {
      return "credit_card";
    }
  }

  // ── Fuzzy scoring against suggestedNames ──

  // Score each detail type by how well account name matches suggested names
  let bestMatch = "";
  let bestScore = 0;

  for (const dt of types) {
    for (const suggested of dt.suggestedNames) {
      const normalizedSuggested = suggested.toLowerCase().replace(/[^a-z0-9]/g, "");

      // Exact match
      if (normalizedName === normalizedSuggested) return dt.value;

      // Check if name contains the suggested name or vice versa
      if (normalizedName.includes(normalizedSuggested)) {
        const score = normalizedSuggested.length / normalizedName.length;
        if (score > bestScore) { bestScore = score; bestMatch = dt.value; }
      } else if (normalizedSuggested.includes(normalizedName)) {
        const score = normalizedName.length / normalizedSuggested.length * 0.8;
        if (score > bestScore) { bestScore = score; bestMatch = dt.value; }
      }
    }

    // Also match against the detail type label
    const normalizedLabel = dt.label.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalizedName.includes(normalizedLabel) || normalizedLabel.includes(normalizedName)) {
      const score = Math.min(normalizedLabel.length, normalizedName.length) /
                    Math.max(normalizedLabel.length, normalizedName.length) * 0.7;
      if (score > bestScore) { bestScore = score; bestMatch = dt.value; }
    }
  }

  // Return best match if score is reasonable (>30%), otherwise default
  return bestScore > 0.3 ? bestMatch : getDefaultDetailType(accountType);
}
