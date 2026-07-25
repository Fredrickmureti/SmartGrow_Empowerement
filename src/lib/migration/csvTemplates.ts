/**
 * CSV template generators for migration import steps.
 * Each returns a CSV string with headers and example rows.
 */

export const CSV_TEMPLATES = {
  accounts: {
    filename: "chart_of_accounts_template.csv",
    content: `code,name,account_type,description,parent_code
1000,Cash and Cash Equivalents,asset,Main cash account,
1100,Accounts Receivable,asset,Trade receivables,
2000,Accounts Payable,liability,Trade payables,
3000,Share Capital,equity,Owner's equity,
4000,Sales Revenue,income,Product and service sales,
5000,Cost of Goods Sold,expense,Direct costs,
`,
  },
  contacts: {
    filename: "contacts_template.csv",
    content: `name,type,email,phone,tax_id,address
Acme Corporation,customer,acme@example.com,+1-555-0100,TAX-001,"123 Main St, New York"
Best Supplies Ltd,supplier,info@bestsupplies.com,+1-555-0200,TAX-002,"456 Oak Ave, Chicago"
Global Trading Co,both,contact@globaltrading.com,+1-555-0300,TAX-003,"789 Pine Rd, LA"
`,
  },
  products: {
    filename: "products_template.csv",
    content: `name,sku,type,sale_price,cost_price,description,unit
Widget A,WGT-001,product,29.99,15.00,Standard widget,pcs
Service Plan,SVC-001,service,99.00,0,Monthly service plan,month
Raw Material X,RAW-001,product,5.50,5.50,Raw material input,kg
`,
  },
  trial_balance: {
    filename: "trial_balance_template.csv",
    content: `account_code,account_name,debit,credit
1000,Cash and Cash Equivalents,50000,0
1100,Accounts Receivable,125000,0
1200,Inventory,75000,0
1500,Fixed Assets,200000,0
2000,Accounts Payable,0,85000
2100,Accrued Liabilities,0,15000
3000,Share Capital,0,100000
3100,Retained Earnings,0,250000
`,
  },
  open_ar: {
    filename: "open_receivables_template.csv",
    content: `customer_name,invoice_number,invoice_date,due_date,amount,amount_paid,currency
Acme Corporation,INV-0001,2025-12-15,2026-01-15,5000.00,0,USD
Global Trading Co,INV-0002,2025-12-20,2026-01-20,12500.00,5000.00,USD
Smith & Associates,INV-0003,2025-12-28,2026-02-28,3200.00,3200.00,USD
`,
  },
  open_ap: {
    filename: "open_payables_template.csv",
    content: `supplier_name,bill_number,bill_date,due_date,amount,amount_paid,currency
Best Supplies Ltd,BILL-0001,2025-12-10,2026-01-10,8500.00,0,USD
Factory Direct Inc,BILL-0002,2025-12-18,2026-01-18,22000.00,10000.00,USD
Office Solutions Co,BILL-0003,2025-12-22,2026-02-22,1500.00,1500.00,USD
`,
  },
  inventory: {
    filename: "inventory_opening_stock_template.csv",
    content: `product_name,sku,quantity,unit_cost,total_value
Widget A,WGT-001,500,15.00,7500.00
Raw Material X,RAW-001,1200,5.50,6600.00
Component B,CMP-002,350,22.00,7700.00
`,
  },
  bank_balances: {
    filename: "bank_balances_template.csv",
    content: `account_name,account_number,opening_balance
Main Checking Account,1234567890,50000.00
Savings Account,0987654321,25000.00
Petty Cash,,500.00
`,
  },
};

export function downloadTemplate(key: keyof typeof CSV_TEMPLATES) {
  const template = CSV_TEMPLATES[key];
  downloadCsv(template.filename, template.content);
}
