-- Performance indexes for scalability
-- These composite indexes optimize common query patterns

-- Invoices: queries by org + status and org + date
CREATE INDEX IF NOT EXISTS idx_invoices_org_created ON invoices(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_org_status ON invoices(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_org_number ON invoices(organization_id, invoice_number);

-- Products: queries by org + name and org + sku
CREATE INDEX IF NOT EXISTS idx_products_org_name ON products(organization_id, name);
CREATE INDEX IF NOT EXISTS idx_products_org_sku ON products(organization_id, sku);
CREATE INDEX IF NOT EXISTS idx_products_org_type ON products(organization_id, type);

-- Contacts: queries by org + type and org + name  
CREATE INDEX IF NOT EXISTS idx_contacts_org_type ON contacts(organization_id, type);
CREATE INDEX IF NOT EXISTS idx_contacts_org_name ON contacts(organization_id, name);

-- Expenses: queries by org + date
CREATE INDEX IF NOT EXISTS idx_expenses_org_date ON expenses(organization_id, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_org_status ON expenses(organization_id, status);

-- Audit Logs: queries by org + date (critical for pagination)
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created ON audit_logs(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_entity ON audit_logs(organization_id, entity_type);

-- POS Transactions: queries by org + date and shift
CREATE INDEX IF NOT EXISTS idx_pos_transactions_org_created ON pos_transactions(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_transactions_shift ON pos_transactions(shift_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_transactions_register ON pos_transactions(register_id, created_at DESC);

-- Bank Transactions: queries by account + date
CREATE INDEX IF NOT EXISTS idx_bank_transactions_account_date ON bank_transactions(bank_account_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_org_date ON bank_transactions(organization_id, transaction_date DESC);

-- Bills: queries by org + status and org + date
CREATE INDEX IF NOT EXISTS idx_bills_org_status ON bills(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_bills_org_date ON bills(organization_id, bill_date DESC);

-- Sales Orders: queries by org + status
CREATE INDEX IF NOT EXISTS idx_sales_orders_org_status ON sales_orders(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_sales_orders_org_date ON sales_orders(organization_id, order_date DESC);