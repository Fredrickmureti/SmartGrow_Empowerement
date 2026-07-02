-- Phase 1: Add business_id to all transactional tables
-- This migration adds business_id column to core tables and creates proper indexes

-- =====================================================
-- INVOICES & RELATED TABLES
-- =====================================================
ALTER TABLE public.invoices 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_business_id ON public.invoices(business_id);

ALTER TABLE public.invoice_items 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_invoice_items_business_id ON public.invoice_items(business_id);

-- =====================================================
-- CONTACTS
-- =====================================================
ALTER TABLE public.contacts 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_business_id ON public.contacts(business_id);

-- =====================================================
-- PRODUCTS
-- =====================================================
ALTER TABLE public.products 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_products_business_id ON public.products(business_id);

-- =====================================================
-- EXPENSES
-- =====================================================
ALTER TABLE public.expenses 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_business_id ON public.expenses(business_id);

-- =====================================================
-- ESTIMATES
-- =====================================================
ALTER TABLE public.estimates 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_estimates_business_id ON public.estimates(business_id);

-- =====================================================
-- BILLS & BILL PAYMENTS
-- =====================================================
ALTER TABLE public.bills 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bills_business_id ON public.bills(business_id);

ALTER TABLE public.bill_payments 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bill_payments_business_id ON public.bill_payments(business_id);

-- =====================================================
-- CREDIT NOTES
-- =====================================================
ALTER TABLE public.credit_notes 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_credit_notes_business_id ON public.credit_notes(business_id);

-- =====================================================
-- PURCHASE ORDERS
-- =====================================================
ALTER TABLE public.purchase_orders 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_business_id ON public.purchase_orders(business_id);

-- =====================================================
-- SALES ORDERS
-- =====================================================
ALTER TABLE public.sales_orders 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sales_orders_business_id ON public.sales_orders(business_id);

-- =====================================================
-- DELIVERY NOTES
-- =====================================================
ALTER TABLE public.delivery_notes 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_delivery_notes_business_id ON public.delivery_notes(business_id);

-- =====================================================
-- PROFORMA INVOICES
-- =====================================================
ALTER TABLE public.proforma_invoices 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_proforma_invoices_business_id ON public.proforma_invoices(business_id);

-- =====================================================
-- BANK ACCOUNTS & TRANSACTIONS
-- =====================================================
ALTER TABLE public.bank_accounts 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bank_accounts_business_id ON public.bank_accounts(business_id);

ALTER TABLE public.bank_transactions 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bank_transactions_business_id ON public.bank_transactions(business_id);

-- =====================================================
-- PAYMENTS & PAYMENT REQUESTS
-- =====================================================
ALTER TABLE public.payments 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payments_business_id ON public.payments(business_id);

ALTER TABLE public.payment_requests 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payment_requests_business_id ON public.payment_requests(business_id);

-- =====================================================
-- ACCOUNTS (Chart of Accounts)
-- =====================================================
ALTER TABLE public.accounts 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_business_id ON public.accounts(business_id);

-- =====================================================
-- JOURNAL ENTRIES
-- =====================================================
ALTER TABLE public.journal_entries 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_journal_entries_business_id ON public.journal_entries(business_id);

-- =====================================================
-- BUDGETS
-- =====================================================
ALTER TABLE public.budgets 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_budgets_business_id ON public.budgets(business_id);

-- =====================================================
-- EMPLOYEES & PAYROLL
-- =====================================================
ALTER TABLE public.employees 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_employees_business_id ON public.employees(business_id);

ALTER TABLE public.payroll_runs 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_runs_business_id ON public.payroll_runs(business_id);

ALTER TABLE public.payslips 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payslips_business_id ON public.payslips(business_id);

-- =====================================================
-- RECURRING INVOICES
-- =====================================================
ALTER TABLE public.recurring_invoices 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_recurring_invoices_business_id ON public.recurring_invoices(business_id);

-- =====================================================
-- SALES RETURNS & PURCHASE RETURNS
-- =====================================================
ALTER TABLE public.sales_returns 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sales_returns_business_id ON public.sales_returns(business_id);

ALTER TABLE public.purchase_returns 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_returns_business_id ON public.purchase_returns(business_id);

-- =====================================================
-- CUSTOMER STATEMENTS
-- =====================================================
ALTER TABLE public.customer_statements 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_customer_statements_business_id ON public.customer_statements(business_id);

-- =====================================================
-- FIXED ASSETS
-- =====================================================
ALTER TABLE public.fixed_assets 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_fixed_assets_business_id ON public.fixed_assets(business_id);

-- =====================================================
-- POS REGISTERS (add business_id for multi-business POS)
-- =====================================================
ALTER TABLE public.pos_registers 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pos_registers_business_id ON public.pos_registers(business_id);

-- =====================================================
-- POS TRANSACTIONS
-- =====================================================
ALTER TABLE public.pos_transactions 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pos_transactions_business_id ON public.pos_transactions(business_id);

-- =====================================================
-- WAREHOUSES
-- =====================================================
ALTER TABLE public.warehouses 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_warehouses_business_id ON public.warehouses(business_id);

-- =====================================================
-- BACKORDERS
-- =====================================================
ALTER TABLE public.backorders 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_backorders_business_id ON public.backorders(business_id);

-- =====================================================
-- TAX RATES
-- =====================================================
ALTER TABLE public.tax_rates 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tax_rates_business_id ON public.tax_rates(business_id);

-- =====================================================
-- PRICE LISTS
-- =====================================================
ALTER TABLE public.price_lists 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_price_lists_business_id ON public.price_lists(business_id);

-- =====================================================
-- PAYMENT TERMS
-- =====================================================
ALTER TABLE public.payment_terms 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payment_terms_business_id ON public.payment_terms(business_id);

-- =====================================================
-- APPROVAL WORKFLOWS
-- =====================================================
ALTER TABLE public.approval_workflows 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_approval_workflows_business_id ON public.approval_workflows(business_id);

-- =====================================================
-- LOYALTY PROGRAMS
-- =====================================================
ALTER TABLE public.loyalty_programs 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_loyalty_programs_business_id ON public.loyalty_programs(business_id);