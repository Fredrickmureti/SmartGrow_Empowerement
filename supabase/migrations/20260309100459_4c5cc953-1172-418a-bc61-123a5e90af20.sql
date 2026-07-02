
-- Add payment_account_id to expenses table
-- This replaces the hardcoded payment_method string with a direct COA account reference
ALTER TABLE expenses ADD COLUMN payment_account_id UUID REFERENCES accounts(id);

-- Add index for FK lookups
CREATE INDEX idx_expenses_payment_account_id ON expenses(payment_account_id) WHERE payment_account_id IS NOT NULL;

COMMENT ON COLUMN expenses.payment_account_id IS 'The Chart of Accounts ledger account credited when this expense is paid (e.g., Cash, Bank, Accounts Payable). Replaces the legacy payment_method string mapping.';
