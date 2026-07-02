
-- Add missing cashier_id column to pos_transactions
ALTER TABLE pos_transactions 
ADD COLUMN IF NOT EXISTS cashier_id UUID REFERENCES pos_cashiers(id);
