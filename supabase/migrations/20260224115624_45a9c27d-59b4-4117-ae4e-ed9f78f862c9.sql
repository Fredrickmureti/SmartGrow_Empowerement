-- Phase 1: Foundation columns for Odoo-parity workflow

-- 1a. Add salesperson_id to invoices and sales_orders
ALTER TABLE invoices ADD COLUMN salesperson_id UUID REFERENCES auth.users(id);
ALTER TABLE sales_orders ADD COLUMN salesperson_id UUID REFERENCES auth.users(id);

-- Backfill salesperson_id from created_by for existing records
UPDATE invoices SET salesperson_id = created_by WHERE salesperson_id IS NULL AND created_by IS NOT NULL;
UPDATE sales_orders SET salesperson_id = created_by WHERE salesperson_id IS NULL AND created_by IS NOT NULL;

-- Indexes for salesperson filtering/reporting
CREATE INDEX idx_invoices_salesperson ON invoices(salesperson_id);
CREATE INDEX idx_sales_orders_salesperson ON sales_orders(salesperson_id);

-- 1b. Add payment_term_id to sales_orders (invoices already has it)
ALTER TABLE sales_orders ADD COLUMN payment_term_id UUID REFERENCES payment_terms(id);

-- 1c. Add confirmed_by to invoices (separate from created_by)
ALTER TABLE invoices ADD COLUMN confirmed_by UUID REFERENCES auth.users(id);